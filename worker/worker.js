// Today's Dish Cloudflare Worker: todaysdish-ingredients.mattbrianburnett.workers.dev
//
// Routes
//   /img?u=...        image proxy for TheMealDB photos (cook page)
//   /search, /recipe  "Cook with what you have" search over TheMealDB v1
//   /eats             "I'm eating this" counter (GET counts, POST a tap); needs the D1
//                     binding DB, see worker/schema.sql. Without it the route answers
//                     503 and the site simply hides the counter.
//   /media/<day>/<file> today's Instagram images and caption: PUT by the daily GitHub job
//                     (Authorization: Bearer MEDIA_KEY), GET is public so Instagram can fetch them
//   /ig/publish       POST (Bearer MEDIA_KEY) to post a day's carousel and story now
//   /ig/status        GET (Bearer MEDIA_KEY) recent posting results and token age
//
// Scheduled (Cron Trigger "0 5-10 * * *", i.e. 07:00 to 12:00 in South Africa): posts today's
// carousel and story to Instagram once the images are uploaded, at most once a day.
//
// Secrets: IG_TOKEN (Instagram User access token, first one only; the Worker renews it weekly
// and keeps the renewed one in D1), MEDIA_KEY (shared with the GitHub job), IP_SALT (optional).
//
// Deployed by pasting into the Cloudflare dashboard; this file is the source of truth.

const WORKER_URL = "https://todaysdish-ingredients.mattbrianburnett.workers.dev";
const IG_API = "https://graph.instagram.com";
const MEDIA_KEEP_DAYS = 3;
const MAX_POST_ATTEMPTS = 3;
const TOKEN_REFRESH_DAYS = 7; // tokens last 60 days and must be renewed before then

// The site's day is South African (UTC+2 all year)
function saToday() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

function bearerOk(request, env) {
  return Boolean(env.MEDIA_KEY) && request.headers.get("Authorization") === "Bearer " + env.MEDIA_KEY;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Settings (Instagram token) ----
async function getSetting(env, key) {
  return env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = ?").bind(key).first();
}
async function setSetting(env, key, value) {
  await env.DB
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, Date.now()).run();
}

// The token lives in D1 so the Worker can renew it. Changing the IG_TOKEN secret
// (say, after it lapsed) replaces the stored one.
async function igToken(env) {
  if (!env.IG_TOKEN) throw new Error("IG_TOKEN secret is not set");
  const seed = await sha256Hex(env.IG_TOKEN);
  const seeded = await getSetting(env, "ig_token_seed");
  if (!seeded || seeded.value !== seed) {
    await setSetting(env, "ig_token", env.IG_TOKEN);
    await setSetting(env, "ig_token_seed", seed);
  }
  const row = await getSetting(env, "ig_token");
  if (Date.now() - row.updated_at > TOKEN_REFRESH_DAYS * 86400000) {
    const r = await fetch(`${IG_API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(row.value)}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) {
      await setSetting(env, "ig_token", j.access_token);
      return j.access_token;
    }
  }
  return row.value;
}

async function igCall(path, params, token, method = "POST") {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === "POST"
    ? await fetch(`${IG_API}/${path}`, { method: "POST", body })
    : await fetch(`${IG_API}/${path}?${body}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Instagram ${path.split("/").pop()}: ${j.error ? j.error.message : "HTTP " + r.status}`);
  return j;
}

// Instagram downloads the image, then the container must reach FINISHED before publishing
async function waitReady(id, token) {
  for (let i = 0; i < 24; i++) {
    const j = await igCall(id, { fields: "status_code" }, token, "GET");
    if (j.status_code === "FINISHED") return;
    if (j.status_code === "ERROR" || j.status_code === "EXPIRED") throw new Error(`Instagram container ${j.status_code}`);
    await sleep(5000);
  }
  throw new Error("Instagram container not ready after 2 minutes");
}

// ---- Daily Instagram post ----
async function publishDay(env, day) {
  const done = await env.DB.prepare("SELECT * FROM ig_posts WHERE day = ?").bind(day).first();
  if (done && done.media_id) return { day, status: "already posted", media_id: done.media_id };
  if (done && done.attempts >= MAX_POST_ATTEMPTS) return { day, status: "gave up", error: done.error };

  const keys = (await env.DB.prepare("SELECT key FROM media WHERE key LIKE ?").bind(day + "/%").all()).results.map(r => r.key);
  const slideNo = k => parseInt((k.match(/post-(\d+)\.jpg$/) || [])[1], 10);
  const slides = keys.filter(k => slideNo(k) > 0).sort((a, b) => slideNo(a) - slideNo(b));
  if (!slides.length) return { day, status: "waiting for images" };

  await env.DB
    .prepare("INSERT INTO ig_posts (day, attempts) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1")
    .bind(day).run();
  try {
    const capRow = await env.DB.prepare("SELECT data FROM media WHERE key = ?").bind(day + "/caption.txt").first();
    const caption = capRow ? new TextDecoder().decode(new Uint8Array(capRow.data)) : "";
    const token = await igToken(env);
    const me = await igCall("me", { fields: "user_id,username" }, token, "GET");
    const uid = me.user_id || me.id;
    const mediaUrl = k => `${WORKER_URL}/media/${k}`;

    // Carousel: one container per slide, then the carousel itself
    const children = [];
    for (const k of slides) {
      const c = await igCall(`${uid}/media`, { image_url: mediaUrl(k), is_carousel_item: "true" }, token);
      children.push(c.id);
    }
    for (const id of children) await waitReady(id, token);
    const carousel = await igCall(`${uid}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }, token);
    await waitReady(carousel.id, token);
    const post = await igCall(`${uid}/media_publish`, { creation_id: carousel.id }, token);
    await env.DB
      .prepare("UPDATE ig_posts SET media_id = ?, posted_at = ?, error = NULL WHERE day = ?")
      .bind(post.id, Date.now(), day).run();

    // Story is a bonus: a failure here never undoes the post
    let story = null;
    if (keys.includes(day + "/story.jpg")) {
      try {
        const s = await igCall(`${uid}/media`, { media_type: "STORIES", image_url: mediaUrl(day + "/story.jpg") }, token);
        await waitReady(s.id, token);
        story = (await igCall(`${uid}/media_publish`, { creation_id: s.id }, token)).id;
        await env.DB.prepare("UPDATE ig_posts SET story_id = ? WHERE day = ?").bind(story, day).run();
      } catch (e) {
        await env.DB.prepare("UPDATE ig_posts SET error = ? WHERE day = ?").bind("story: " + e.message, day).run();
      }
    }
    return { day, status: "posted", media_id: post.id, story_id: story, username: me.username };
  } catch (e) {
    await env.DB.prepare("UPDATE ig_posts SET error = ? WHERE day = ?").bind(e.message, day).run();
    return { day, status: "failed", error: e.message };
  }
}

async function runScheduled(env) {
  const cutoff = Date.now() - MEDIA_KEEP_DAYS * 86400000;
  await env.DB.prepare("DELETE FROM media WHERE created_at < ?").bind(cutoff).run();
  return publishDay(env, saToday());
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    // ---- Image proxy: /img?u=https://... ----
if (url.pathname === "/img") {
  const u = url.searchParams.get("u") || "";
  if (!u) {
    return new Response("Missing u", { status: 400 });
  }

  // Force https and basic allowlist for safety
  const safe = u.trim().replace(/^http:\/\//i, "https://");

  // Only allow TheMealDB image host (prevents open-proxy abuse)
  try {
    const parsed = new URL(safe);
    if (!/(\.|^)themealdb\.com$/i.test(parsed.hostname)) {
      return new Response("Blocked host", { status: 403 });
    }
  } catch {
    return new Response("Bad url", { status: 400 });
  }

  // Fetch the image server-side
  const resp = await fetch(safe, {
    headers: {
      // Some servers behave better with a basic UA
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!resp.ok) {
    return new Response("Upstream image failed", { status: 502 });
  }

  // Return image with caching
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=86400"); // 1 day
  return new Response(resp.body, { status: 200, headers });
}

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // TheMealDB v1 endpoints: list/filter/lookup
    const BASE = "https://www.themealdb.com/api/json/v1/1";
    const allowedDiets = new Set(["any", "vegan", "glutenfree", "vegan_glutenfree"]);

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- Random helpers (Option B: every search different) ----
    function randomInt(maxExclusive) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] % maxExclusive;
    }

    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    // ---- Normalization ----
    function normalizeWord(s) {
      return String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z\s]/g, "")
        .replace(/\s+/g, " ");
    }

    function normalizeIngredientName(s) {
      let x = normalizeWord(s);
      if (x.endsWith("es")) x = x.slice(0, -2);
      else if (x.endsWith("s")) x = x.slice(0, -1);
      return x;
    }

    // ---- Diet checks (best effort) ----
    function containsAny(ingredientNames, words) {
      for (const ing of ingredientNames) {
        for (const w of words) {
          if (ing.includes(w)) return true;
        }
      }
      return false;
    }

    const animalProducts = [
      "beef","pork","ham","bacon","chicken","turkey","lamb","goat","duck",
      "sausage","anchov","tuna","salmon","fish","prawn","shrimp","gelatin",
      "egg","milk","cheese","butter","cream","yogurt","honey"
    ];

    const glutenWords = [
      "wheat","flour","bread","bun","roll","pasta","noodle","spaghetti","macaroni",
      "barley","rye","malt","beer","breadcrumb","crouton","couscous","bulgur",
      "tortilla","wrap","seitan","semolina","cracker","cake","biscuit","pastry",
      "soy sauce"
    ];

    function dietAllowedFromIngredientNames(ingredientNames, diet) {
      const veganOk = !containsAny(ingredientNames, animalProducts);
      const glutenOk = !containsAny(ingredientNames, glutenWords);

      if (diet === "any") return true;
      if (diet === "vegan") return veganOk;
      if (diet === "glutenfree") return glutenOk;
      if (diet === "vegan_glutenfree") return veganOk && glutenOk;
      return true;
    }

    function effortLevel(ingredientsCount, stepsCount) {
      if (ingredientsCount <= 6 && stepsCount <= 6) return "Quick";
      if (ingredientsCount <= 12 && stepsCount <= 10) return "Medium";
      return "Involved";
    }

    // ---- TheMealDB calls ----
    async function mealsForIngredient(ingredientName) {
      // filter.php?i=...
      const iParam = ingredientName.replace(/\s+/g, "_");
      const r = await fetch(`${BASE}/filter.php?i=${encodeURIComponent(iParam)}`);
      if (!r.ok) return [];
      const j = await r.json();
      return j.meals || [];
    }

    async function mealDetails(idMeal) {
      // lookup.php?i=...
      const r = await fetch(`${BASE}/lookup.php?i=${encodeURIComponent(idMeal)}`);
      if (!r.ok) return null;
      const j = await r.json();
      return (j.meals && j.meals[0]) ? j.meals[0] : null;
    }

    // ---- Ingredient list caching (in memory) ----
    // Reduces calls and keeps within Worker limits.
    let globalIngredients = globalThis.__mealdbIngredientList || null;

    async function getIngredientList() {
      if (globalIngredients) return globalIngredients;

      // list.php?i=list
      const r = await fetch(`${BASE}/list.php?i=list`);
      if (!r.ok) return [];
      const j = await r.json();
      const list = (j.meals || [])
        .map(x => x.strIngredient)
        .filter(Boolean)
        .map(s => s.trim());

      globalThis.__mealdbIngredientList = list;
      globalIngredients = list;
      return list;
    }

    function findVariants(term, ingredientList, maxVariants) {
      const t = normalizeIngredientName(term);
      if (!t) return [];

      const matches = [];
      for (const ing of ingredientList) {
        const ni = normalizeIngredientName(ing);
        if (ni.includes(t)) matches.push(ing);
      }
      matches.sort((a, b) => a.length - b.length);
      return matches.slice(0, maxVariants);
    }

    function normalizeMealDetail(m) {
      const ingredientsList = [];
      const ingredientNames = [];

      for (let i = 1; i <= 20; i++) {
        const ing = (m[`strIngredient${i}`] || "").trim();
        const meas = (m[`strMeasure${i}`] || "").trim();
        if (!ing) continue;

        ingredientsList.push(meas ? `${meas} ${ing}`.trim() : ing);
        ingredientNames.push(normalizeIngredientName(ing));
      }

      const steps = (m.strInstructions || "")
        .split(/\r?\n+/)
        .map(s => s.trim())
        .filter(Boolean);

      return {
        id: m.idMeal,
        name: m.strMeal,
        image: m.strMealThumb,
        category: (m.strCategory || "").trim(),
        ingredients: ingredientsList,
        ingredientNames,
        steps,
        effort: effortLevel(ingredientsList.length, steps.length),
      };
    }

    function computeMissing(userIngredients, recipeIngredientNames) {
      const userSet = new Set(userIngredients.map(normalizeIngredientName));
      const recipeSet = new Set(recipeIngredientNames);

      const missed = [];
      let usedCount = 0;

      for (const ing of recipeSet) {
        if (!ing) continue;
        if (userSet.has(ing)) usedCount++;
        else missed.push(ing);
      }

      return {
        usedIngredientCount: usedCount,
        missedIngredientCount: missed.length,
        missedIngredients: missed
      };
    }

    // ---- "I'm eating this" counter (D1) ----
    const MEAL_KEYS = new Set(["breakfast", "lunch", "dinner"]);
    const MAX_TAPS_PER_IP_PER_DAY = 30; // a busy household or office, not a script
    const KEEP_DAYS = 30;

    // The site's day is South African; allow a day either side of UTC for other time zones
    function dayOk(day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
      const t = Date.parse(day + "T00:00:00Z");
      return Number.isFinite(t) && Math.abs(t - Date.now()) < 2 * 86400000;
    }

    async function eatCounts(day) {
      const perMeal = await env.DB
        .prepare("SELECT meal, COUNT(*) AS n FROM eats WHERE day = ? GROUP BY meal")
        .bind(day).all();
      const people = await env.DB
        .prepare("SELECT COUNT(DISTINCT device) AS n FROM eats WHERE day = ?")
        .bind(day).first();
      const out = { day, breakfast: 0, lunch: 0, dinner: 0, people: people ? people.n : 0 };
      for (const r of perMeal.results || []) out[r.meal] = r.n;
      return out;
    }

    // -------------------- Routes --------------------
    if (url.pathname === "/") {
      return new Response(
        "Today'sDish Ingredients API ✅ (SMART MATCH + TIER FILL + RANDOM)\n\n/search?ingredients=onion,pepper,tomato,chicken&number=50&diet=any\n/recipe?id=52772&ingredients=onion,pepper,tomato,chicken&diet=any\n/eats?day=YYYY-MM-DD\n",
        { headers: corsHeaders }
      );
    }

    // -------- /media (Instagram images, kept a few days) --------
    if (url.pathname.startsWith("/media/")) {
      if (!env || !env.DB) return json({ error: "Not set up" }, 503);
      const key = url.pathname.slice("/media/".length);
      if (!/^\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.(jpg|txt)$/.test(key)) return json({ error: "Bad key" }, 400);

      if (request.method === "PUT") {
        if (!bearerOk(request, env)) return json({ error: "Unauthorized" }, 401);
        const data = await request.arrayBuffer();
        if (!data.byteLength || data.byteLength > 1900000) return json({ error: "Bad size" }, 413);
        const type = key.endsWith(".jpg") ? "image/jpeg" : "text/plain; charset=utf-8";
        await env.DB
          .prepare("INSERT INTO media (key, data, content_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, content_type = excluded.content_type, created_at = excluded.created_at")
          .bind(key, data, type, Date.now()).run();
        return json({ ok: true, key, bytes: data.byteLength });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const row = await env.DB.prepare("SELECT data, content_type FROM media WHERE key = ?").bind(key).first();
        if (!row) return new Response("Not found", { status: 404 });
        return new Response(request.method === "HEAD" ? null : new Uint8Array(row.data), {
          headers: { "Content-Type": row.content_type, "Cache-Control": "public, max-age=3600" },
        });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // -------- /ig (manual post and status, private) --------
    if (url.pathname === "/ig/publish" || url.pathname === "/ig/status") {
      if (!env || !env.DB) return json({ error: "Not set up" }, 503);
      if (!bearerOk(request, env)) return json({ error: "Unauthorized" }, 401);

      if (url.pathname === "/ig/publish" && request.method === "POST") {
        const day = url.searchParams.get("day") || saToday();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "Invalid day" }, 400);
        return json(await publishDay(env, day));
      }
      if (url.pathname === "/ig/status" && request.method === "GET") {
        const posts = await env.DB.prepare("SELECT day, media_id, story_id, attempts, error, posted_at FROM ig_posts ORDER BY day DESC LIMIT 7").all();
        const token = await getSetting(env, "ig_token");
        const media = await env.DB.prepare("SELECT key, length(data) AS bytes FROM media ORDER BY key DESC LIMIT 20").all();
        return json({
          today: saToday(),
          posts: posts.results,
          token: token ? { renewed_days_ago: Math.floor((Date.now() - token.updated_at) / 86400000) } : null,
          media: media.results,
        });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // -------- /eats (counter) --------
    if (url.pathname === "/eats") {
      if (!env || !env.DB) return json({ error: "Counter not set up" }, 503);

      if (request.method === "GET") {
        const day = (url.searchParams.get("day") || "").trim();
        if (!dayOk(day)) return json({ error: "Invalid day" }, 400);
        return json(await eatCounts(day));
      }

      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
        const day = String(body.day || "");
        const meal = String(body.meal || "");
        const device = String(body.device || "").toLowerCase();
        if (!dayOk(day)) return json({ error: "Invalid day" }, 400);
        if (!MEAL_KEYS.has(meal)) return json({ error: "Invalid meal" }, 400);
        if (!/^[0-9a-f-]{36}$/.test(device)) return json({ error: "Invalid device" }, 400);

        if (body.eating) {
          // Only a salted hash of the IP is stored, and the salt changes daily
          const ip = request.headers.get("CF-Connecting-IP") || "";
          const ipHash = await sha256Hex((env.IP_SALT || "todaysdish") + "|" + day + "|" + ip);
          const used = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM eats WHERE day = ? AND ip_hash = ?")
            .bind(day, ipHash).first();
          if (used && used.n >= MAX_TAPS_PER_IP_PER_DAY) return json({ error: "Too many taps" }, 429);
          await env.DB
            .prepare("INSERT OR IGNORE INTO eats (day, meal, device, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(day, meal, device, ipHash, Date.now()).run();
        } else {
          await env.DB
            .prepare("DELETE FROM eats WHERE day = ? AND meal = ? AND device = ?")
            .bind(day, meal, device).run();
        }

        // Tidy old days now and then instead of on every tap
        if (randomInt(100) === 0) {
          const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
          await env.DB.prepare("DELETE FROM eats WHERE day < ?").bind(cutoff).run();
        }

        return json(await eatCounts(day));
      }

      return json({ error: "Method not allowed" }, 405);
    }

    // -------- /search (SMART MATCH + fill tiers) --------
    if (url.pathname === "/search") {
      const ingredientsRaw = (url.searchParams.get("ingredients") || "").trim();
      const numberRaw = (url.searchParams.get("number") || "50").trim();
      const diet = (url.searchParams.get("diet") || "any").trim().toLowerCase();

      if (!ingredientsRaw) return json({ error: "Missing ingredients" }, 400);
      if (!allowedDiets.has(diet)) return json({ error: "Invalid diet" }, 400);

      const number = Math.max(5, Math.min(50, parseInt(numberRaw, 10) || 50));

      const terms = ingredientsRaw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 6); // keep safe under limits

      const ingredientList = await getIngredientList();

      const MAX_VARIANTS_PER_TERM = 3;
      const expanded = terms.map(t => ({
        term: t,
        variants: findVariants(t, ingredientList, MAX_VARIANTS_PER_TERM)
      }));
      for (const e of expanded) {
        if (!e.variants.length) e.variants = [e.term];
        shuffle(e.variants); // extra variety
      }

      // mealId -> {name,image, matchedTerms:Set}
      const mealMap = new Map();

      for (const e of expanded) {
        const termKey = normalizeIngredientName(e.term);
        const seenIdsForThisTerm = new Set();

        for (const variant of e.variants) {
          const meals = await mealsForIngredient(variant);
          for (const m of meals) {
            if (!m || !m.idMeal) continue;
            const id = m.idMeal;
            if (seenIdsForThisTerm.has(id)) continue;
            seenIdsForThisTerm.add(id);

            const cur = mealMap.get(id) || {
              id,
              name: m.strMeal,
              image: m.strMealThumb,
              matchedTerms: new Set(),
            };
            cur.matchedTerms.add(termKey);
            mealMap.set(id, cur);
          }
        }
      }

      const items = Array.from(mealMap.values()).map(x => ({
        id: x.id,
        name: x.name,
        image: x.image,
        matchedCount: x.matchedTerms.size,
        requiredCount: expanded.length
      }));

      // Bucket by matchedCount
      const buckets = new Map(); // matchedCount -> []
      for (const it of items) {
        const k = it.matchedCount;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(it);
      }

      // Build final list: high matchedCount first, but shuffle within each bucket
      const counts = Array.from(buckets.keys()).sort((a, b) => b - a);
      const out = [];

      for (const c of counts) {
        const arr = buckets.get(c);
        shuffle(arr);
        for (const it of arr) {
          out.push(it);
          if (out.length >= number) break;
        }
        if (out.length >= number) break;
      }

      // strictnessUsed = highest matchedCount present in the output’s first item
      const strictnessUsed = out.length ? out[0].matchedCount : 0;

      return json({
        ingredients: ingredientsRaw,
        diet,
        requiredCount: expanded.length,
        strictnessUsed,
        candidatesCount: out.length,
        results: out
      });
    }

    // -------- /recipe (DETAIL) --------
    if (url.pathname === "/recipe") {
      const id = (url.searchParams.get("id") || "").trim();
      const ingredientsRaw = (url.searchParams.get("ingredients") || "").trim();
      const diet = (url.searchParams.get("diet") || "any").trim().toLowerCase();

      if (!id) return json({ error: "Missing id" }, 400);
      if (!ingredientsRaw) return json({ error: "Missing ingredients" }, 400);
      if (!allowedDiets.has(diet)) return json({ error: "Invalid diet" }, 400);

      const userIngredients = ingredientsRaw
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);

      const detail = await mealDetails(id);
      if (!detail) return json({ error: "Meal not found" }, 404);

      const norm = normalizeMealDetail(detail);

      if (!dietAllowedFromIngredientNames(norm.ingredientNames, diet)) {
        return json({ error: "Excluded by diet filter" }, 200);
      }

      const miss = computeMissing(userIngredients, norm.ingredientNames);

      return json({
        id: norm.id,
        name: norm.name,
        image: norm.image,
        category: norm.category,
        effort: norm.effort,
        ingredients: norm.ingredients,
        steps: norm.steps,
        ...miss
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};
