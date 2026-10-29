// Today's Dish Cloudflare Worker: todaysdish-ingredients.mattbrianburnett.workers.dev
//
// Routes
//   /img?u=...        image proxy for TheMealDB photos (cook page)
//   /search, /recipe  "Cook with what you have" search over TheMealDB v1
//   /eats             "I'm eating this" counter (GET counts, POST a tap); needs the D1
//                     binding DB, see worker/schema.sql. Without it the route answers
//                     503 and the site simply hides the counter.
//
// Deployed by pasting into the Cloudflare dashboard; this file is the source of truth.

export default {
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

    async function sha256Hex(s) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
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
