// Today's Dish Cloudflare Worker: todaysdish-ingredients.mattbrianburnett.workers.dev
//
// Routes
//   /img?u=...        image proxy for TheMealDB photos (cook page)
//   /search, /recipe  "Cook with what you have" search over TheMealDB v1
//   /eats             "I'm eating this" counter (GET counts, POST a tap); needs the D1
//                     binding DB, see worker/schema.sql. Without it the route answers
//                     503 and the site simply hides the counter.
//   /media/<day>/<file> today's Instagram images, Reel video and captions: PUT by the daily GitHub job
//                     (Authorization: Bearer MEDIA_KEY), GET is public so Instagram can fetch them
//   /ig/publish       POST (Bearer MEDIA_KEY) to post a day's carousel and story now
//   /ig/status        GET (Bearer MEDIA_KEY) recent posting results and token age
//   /health           GET, public: Worker version, when the cron last ran, whether GH_TOKEN
//                     is set and the last job start (no secrets, safe to open in a browser)
//   /subscribe        POST {email} from the site's Monday email form; sends a confirmation email
//   /confirm?t=       the link in that email: turns the sign-up on, then back to the site
//   /unsubscribe?t=   GET shows an Unsubscribe button, POST unsubscribes (Gmail one-click too)
//   /newsletter/preview  GET, public: this Monday email built from today's menu (?confirm=1 for
//                     the confirmation email); /newsletter/test?to= POST (Bearer MEDIA_KEY) sends it
//
// Scheduled (Cron Trigger "*/5 * * * *"): the menu changes at 00:00 GMT. GitHub's own scheduler
// often runs hours late, so at 00:00 the Worker starts the daily GitHub job itself (needs
// GH_TOKEN) and keeps nudging it every 30 minutes while the site still shows yesterday. Once
// the site shows today's menu it posts today's carousel and story to Instagram, and the same
// slides plus a story to the Facebook Page when FB_PAGE_ID is set. A few minutes later, on its
// own cron ticks, it posts the day's Reel (reel.mp4): one tick creates it, later ticks wait for
// Instagram to process the video and publish it, so the Reel never adds to the carousel's work
// or holds it up. The GitHub job also asks
// for the post the moment the site updates; a lock stops the two posting together. Each
// network posts at most once a day and retries on its own, so a failure on one never blocks
// or repeats the other. On Mondays from 04:00 UTC, quiet ticks send the weekly email.
//
// Secrets: RESEND_API_KEY (Resend, sending only, for the Monday email), IG_TOKEN, MEDIA_KEY (shared with the GitHub job), IP_SALT (optional),
// GH_TOKEN (fine-grained GitHub token for this repo only, Actions: read and write),
// IG_USER_ID when IG_TOKEN is a Meta system-user token, and for Facebook FB_PAGE_ID plus
// FB_TOKEN (optional; defaults to IG_TOKEN, which must then be a system-user token with Page
// permissions). Two Instagram token kinds work:
//   "EAA..." system-user token from the dashboard's Unified login: never expires, uses
//            graph.facebook.com, and needs IG_USER_ID (the Instagram account's ID)
//   "IG..."  Instagram User token from Instagram login: lasts 60 days, uses
//            graph.instagram.com; the Worker renews it weekly and keeps the new one in D1
//
// Deployed by pasting into the Cloudflare dashboard; this file is the source of truth.

const WORKER_URL = "https://todaysdish-ingredients.mattbrianburnett.workers.dev";
const IG_API = "https://graph.instagram.com";
const FB_API = "https://graph.facebook.com";

// System-user tokens (Unified login) go through Facebook's Graph API and never expire
const isSystemToken = token => token.startsWith("EAA");
const MEDIA_KEEP_DAYS = 3;
const MAX_POST_ATTEMPTS = 3;
const TOKEN_REFRESH_DAYS = 7; // tokens last 60 days and must be renewed before then
const SITE_TODAY = "https://www.todaysdish.food/today.json";
const GH_DISPATCH = "https://api.github.com/repos/mattbrianb/todaysdish/actions/workflows/daily.yml/dispatches";
const DISPATCH_EVERY_MS = 30 * 60000; // a run plus the Pages deploy takes about 5 minutes
const MAX_DISPATCHES = 8;
const POST_LOCK_MS = 10 * 60000;
const WORKER_VERSION = "2026-11-08 monday email";

// The menu day is GMT: a new one at 00:00 UTC
function utcToday() {
  return new Date().toISOString().slice(0, 10);
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
  if (!isSystemToken(row.value) && Date.now() - row.updated_at > TOKEN_REFRESH_DAYS * 86400000) {
    const r = await fetch(`${IG_API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(row.value)}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) {
      await setSetting(env, "ig_token", j.access_token);
      return j.access_token;
    }
  }
  return row.value;
}

async function graphCall(api, label, path, params, token, method = "POST") {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === "POST"
    ? await fetch(`${api}/${path}`, { method: "POST", body })
    : await fetch(`${api}/${path}?${body}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${label} ${path.split("/").pop()}: ${j.error ? j.error.message : "HTTP " + r.status}`);
  return j;
}
const igCall = (path, params, token, method) =>
  graphCall(isSystemToken(token) ? FB_API : IG_API, "Instagram", path, params, token, method);
const fbCall = (path, params, token, method) => graphCall(FB_API, "Facebook", path, params, token, method);

// Instagram downloads the image, then the container must reach FINISHED before publishing
async function waitReady(id, token) {
  let hiccups = 0;
  for (let i = 0; i < 24; i++) {
    let j;
    try {
      j = await igCall(id, { fields: "status_code" }, token, "GET");
    } catch (e) {
      // Right after creation Instagram can briefly answer "Unsupported get request"
      if (!/Unsupported get request/i.test(e.message) || ++hiccups > 3) throw e;
      await sleep(5000);
      continue;
    }
    if (j.status_code === "FINISHED") return;
    if (j.status_code === "ERROR" || j.status_code === "EXPIRED") throw new Error(`Instagram container ${j.status_code}`);
    await sleep(5000);
  }
  throw new Error("Instagram container not ready after 2 minutes");
}

// Create a container. Instagram has answered with id "0" (which can never be checked or
// published), so ask again when the id isn't a real one
async function createContainer(uid, params, token) {
  for (let i = 0; i < 3; i++) {
    const c = await igCall(`${uid}/media`, params, token);
    if (/^[1-9]\d*$/.test(String(c.id))) return String(c.id);
    await sleep(3000);
  }
  throw new Error("Instagram returned no usable container id");
}

// ---- Daily posts ----
const mediaUrl = k => `${WORKER_URL}/media/${k}`;

async function mediaText(env, key) {
  const row = await env.DB.prepare("SELECT data FROM media WHERE key = ?").bind(key).first();
  return row ? new TextDecoder().decode(new Uint8Array(row.data)) : null;
}

// The Facebook columns came after the table; add them once if an older database lacks them
let fbColumnsReady = false;
async function ensureFbColumns(env) {
  if (fbColumnsReady) return;
  for (const col of ["fb_post_id TEXT", "fb_story_id TEXT", "fb_attempts INTEGER NOT NULL DEFAULT 0", "fb_error TEXT", "busy_until INTEGER",
    "reel_container TEXT", "reel_id TEXT", "reel_attempts INTEGER NOT NULL DEFAULT 0", "reel_error TEXT"]) {
    try { await env.DB.prepare(`ALTER TABLE ig_posts ADD COLUMN ${col}`).run(); } catch (e) { /* already there */ }
  }
  fbColumnsReady = true;
}

async function publishDay(env, day) {
  await ensureFbColumns(env);
  await env.DB.prepare("INSERT OR IGNORE INTO ig_posts (day, attempts) VALUES (?, 0)").bind(day).run();
  const row = await env.DB.prepare("SELECT * FROM ig_posts WHERE day = ?").bind(day).first();
  const fbWanted = Boolean(env.FB_PAGE_ID);
  const igDone = row.media_id || row.attempts >= MAX_POST_ATTEMPTS;
  const fbDone = !fbWanted || row.fb_post_id || row.fb_attempts >= MAX_POST_ATTEMPTS;

  let slides = [], keys = [];
  if (!igDone || !fbDone) {
    keys = (await env.DB.prepare("SELECT key FROM media WHERE key LIKE ?").bind(day + "/%").all()).results.map(r => r.key);
    const slideNo = k => parseInt((k.match(/post-(\d+)\.jpg$/) || [])[1], 10);
    slides = keys.filter(k => slideNo(k) > 0).sort((a, b) => slideNo(a) - slideNo(b));
    if (!slides.length) return { day, status: "waiting for images" };

    // The GitHub job and the cron can ask at the same moment: only one of them posts
    const now = Date.now();
    const claim = await env.DB
      .prepare("UPDATE ig_posts SET busy_until = ? WHERE day = ? AND (busy_until IS NULL OR busy_until < ?)")
      .bind(now + POST_LOCK_MS, day, now).run();
    if (!claim.meta || claim.meta.changes !== 1) return { day, status: "posting already in progress" };
    try {
      // The other caller may have finished just before we took the lock
      const fresh = await env.DB.prepare("SELECT * FROM ig_posts WHERE day = ?").bind(day).first();
      const result = { day, ...(await publishInstagram(env, day, fresh, keys, slides)) };
      if (fbWanted) result.facebook = await publishFacebook(env, day, fresh, keys, slides);
      return result;
    } finally {
      await env.DB.prepare("UPDATE ig_posts SET busy_until = NULL WHERE day = ?").bind(day).run();
    }
  }

  const result = { day, ...(await publishInstagram(env, day, row, keys, slides)) };
  if (fbWanted) result.facebook = await publishFacebook(env, day, row, keys, slides);
  return result;
}

async function publishInstagram(env, day, row, keys, slides) {
  if (row.media_id) return { status: "already posted", media_id: row.media_id };
  if (row.attempts >= MAX_POST_ATTEMPTS) return { status: "gave up", error: row.error };

  await env.DB.prepare("UPDATE ig_posts SET attempts = attempts + 1 WHERE day = ?").bind(day).run();
  try {
    const caption = (await mediaText(env, day + "/caption.txt")) || "";
    const token = await igToken(env);
    let uid, me;
    if (isSystemToken(token)) {
      if (!env.IG_USER_ID) throw new Error("IG_USER_ID secret is not set");
      uid = env.IG_USER_ID;
      me = await igCall(uid, { fields: "username" }, token, "GET");
    } else {
      me = await igCall("me", { fields: "user_id,username" }, token, "GET");
      uid = me.user_id || me.id;
    }

    // Carousel: one container per slide, then the carousel itself
    const children = [];
    for (const k of slides) {
      children.push(await createContainer(uid, { image_url: mediaUrl(k), is_carousel_item: "true" }, token));
    }
    for (const id of children) await waitReady(id, token);
    const carousel = await createContainer(uid, { media_type: "CAROUSEL", children: children.join(","), caption }, token);
    await waitReady(carousel, token);
    const post = await igCall(`${uid}/media_publish`, { creation_id: carousel }, token);
    await env.DB
      .prepare("UPDATE ig_posts SET media_id = ?, posted_at = ?, error = NULL WHERE day = ?")
      .bind(post.id, Date.now(), day).run();

    // Story is a bonus: a failure here never undoes the post
    let story = null;
    if (keys.includes(day + "/story.jpg")) {
      try {
        const s = await createContainer(uid, { media_type: "STORIES", image_url: mediaUrl(day + "/story.jpg") }, token);
        await waitReady(s, token);
        story = (await igCall(`${uid}/media_publish`, { creation_id: s }, token)).id;
        await env.DB.prepare("UPDATE ig_posts SET story_id = ? WHERE day = ?").bind(story, day).run();
      } catch (e) {
        await env.DB.prepare("UPDATE ig_posts SET error = ? WHERE day = ?").bind("story: " + e.message, day).run();
      }
    }
    return { status: "posted", media_id: post.id, story_id: story, username: me.username };
  } catch (e) {
    await env.DB.prepare("UPDATE ig_posts SET error = ? WHERE day = ?").bind(e.message, day).run();
    return { status: "failed", error: e.message };
  }
}

// Posting as the Page needs the Page's own token. A system-user token gets it from me/accounts
// (or the Page itself); posting with the system-user token instead fails with a misleading
// "publish_actions is deprecated" error, so never fall back to it.
async function pageAccessToken(token, page) {
  const reasons = [];
  try {
    const a = await fbCall("me/accounts", { fields: "id,name,access_token", limit: "100" }, token, "GET");
    const hit = (a.data || []).find(x => String(x.id) === String(page));
    if (hit && hit.access_token) return hit.access_token;
    const ids = (a.data || []).map(x => `${x.id} (${x.name})`).join(", ") || "none";
    reasons.push(`the token can't see Page ${page}; it can see: ${ids}`);
  } catch (e) {
    reasons.push(e.message);
  }
  try {
    const p = await fbCall(page, { fields: "access_token" }, token, "GET");
    if (p.access_token) return p.access_token;
    reasons.push("the Page returned no access_token");
  } catch (e) {
    // New-style Pages also have a profile ID (the one in the web address) that can't post
    reasons.push(/nonexisting field \(access_token\)/.test(e.message)
      ? `${page} looks like the Page's profile ID, not its Page ID; set FB_PAGE_ID to the Page ID listed above`
      : e.message);
  }
  throw new Error(`No Page token for ${page}: ${reasons.join(" | ")}. Assign the Page to the system user (content permission) and generate the token with pages_manage_posts, pages_read_engagement and pages_show_list`);
}

// Facebook Page: the same slides as one multi-photo post (links are clickable there), then a story
async function publishFacebook(env, day, row, keys, slides) {
  if (row.fb_post_id) return { status: "already posted", post_id: row.fb_post_id };
  if (row.fb_attempts >= MAX_POST_ATTEMPTS) return { status: "gave up", error: row.fb_error };

  await env.DB.prepare("UPDATE ig_posts SET fb_attempts = fb_attempts + 1 WHERE day = ?").bind(day).run();
  try {
    const token = env.FB_TOKEN || await igToken(env);
    if (!isSystemToken(token)) throw new Error("Facebook needs a Meta system-user token: set FB_TOKEN");
    const page = env.FB_PAGE_ID;
    const pageToken = await pageAccessToken(token, page);

    const message = (await mediaText(env, day + "/facebook.txt")) || (await mediaText(env, day + "/caption.txt")) || "";
    const params = { message };
    let i = 0;
    for (const k of slides) {
      const photo = await fbCall(`${page}/photos`, { url: mediaUrl(k), published: "false" }, pageToken);
      params[`attached_media[${i++}]`] = JSON.stringify({ media_fbid: photo.id });
    }
    const post = await fbCall(`${page}/feed`, params, pageToken);
    await env.DB.prepare("UPDATE ig_posts SET fb_post_id = ?, fb_error = NULL WHERE day = ?").bind(post.id, day).run();

    let story = null;
    if (keys.includes(day + "/story.jpg")) {
      try {
        const photo = await fbCall(`${page}/photos`, { url: mediaUrl(day + "/story.jpg"), published: "false" }, pageToken);
        const st = await fbCall(`${page}/photo_stories`, { photo_id: photo.id }, pageToken);
        story = st.post_id || st.id || "posted";
        await env.DB.prepare("UPDATE ig_posts SET fb_story_id = ? WHERE day = ?").bind(story, day).run();
      } catch (e) {
        await env.DB.prepare("UPDATE ig_posts SET fb_error = ? WHERE day = ?").bind("story: " + e.message, day).run();
      }
    }
    return { status: "posted", post_id: post.id, story_id: story };
  } catch (e) {
    await env.DB.prepare("UPDATE ig_posts SET fb_error = ? WHERE day = ?").bind(e.message, day).run();
    return { status: "failed", error: e.message };
  }
}

// The date of the menu visitors see right now (skipping caches), or null if it can't be read
async function siteDay() {
  try {
    const r = await fetch(SITE_TODAY + "?t=" + Date.now(), { cf: { cacheTtl: 0 }, headers: { "Cache-Control": "no-cache" } });
    return r.ok ? (await r.json()).date || null : null;
  } catch (e) {
    return null;
  }
}

// Start the daily GitHub job (force=false: it skips the recipe lookup if today's menu exists)
async function dispatchDaily(env) {
  const r = await fetch(GH_DISPATCH, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GH_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "todaysdish-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { force: "false" } }),
  });
  if (r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// While the site shows an old menu, start the job at most every 30 minutes, 8 times a day
async function nudgeDaily(env, day) {
  if (!env.GH_TOKEN) {
    await setSetting(env, "dispatch", JSON.stringify({ day, count: 0, at: 0, error: "GH_TOKEN secret is not set" }));
    return { status: "GH_TOKEN secret is not set" };
  }
  const saved = await getSetting(env, "dispatch");
  let rec = saved ? JSON.parse(saved.value) : {};
  if (rec.day !== day) rec = { day, count: 0, at: 0 };
  if (rec.count >= MAX_DISPATCHES) return { status: "gave up for today", ...rec };
  if (Date.now() - rec.at < DISPATCH_EVERY_MS) return { status: "job started, waiting", ...rec };
  rec = { day, count: rec.count + 1, at: Date.now() };
  try {
    await dispatchDaily(env);
    delete rec.error;
  } catch (e) {
    rec.error = e.message;
  }
  await setSetting(env, "dispatch", JSON.stringify(rec));
  return { status: rec.error ? "could not start the job" : "job started", ...rec };
}

// The day's Reel, one small step per cron tick: create the container, then on later ticks
// check Instagram has processed the video and publish it. Up to 3 containers a day. It goes to
// the Reels tab only (share_to_feed false): the carousel is the day's post on the profile grid.
async function publishReel(env, day) {
  await ensureFbColumns(env);
  const row = await env.DB.prepare("SELECT * FROM ig_posts WHERE day = ?").bind(day).first();
  if (!row || !row.media_id) return { status: "waiting for the carousel" };
  if (row.reel_id) return { status: "already posted", reel_id: row.reel_id };
  const has = await env.DB.prepare("SELECT 1 FROM media WHERE key = ?").bind(day + "/reel.mp4").first();
  if (!has) return { status: "no reel today" };
  const fail = async msg => {
    await env.DB.prepare("UPDATE ig_posts SET reel_container = NULL, reel_error = ? WHERE day = ?").bind(msg, day).run();
    return { status: "failed", error: msg };
  };
  try {
    const token = await igToken(env);
    const uid = isSystemToken(token) ? env.IG_USER_ID : (await igCall("me", { fields: "user_id" }, token, "GET")).user_id;
    if (!row.reel_container) {
      if (row.reel_attempts >= MAX_POST_ATTEMPTS) return { status: "gave up", error: row.reel_error };
      await env.DB.prepare("UPDATE ig_posts SET reel_attempts = reel_attempts + 1 WHERE day = ?").bind(day).run();
      const caption = (await mediaText(env, day + "/reel-caption.txt")) || (await mediaText(env, day + "/caption.txt")) || "";
      const id = await createContainer(uid, { media_type: "REELS", video_url: mediaUrl(day + "/reel.mp4"), caption, share_to_feed: "false" }, token);
      await env.DB.prepare("UPDATE ig_posts SET reel_container = ?, reel_error = NULL WHERE day = ?").bind(id, day).run();
      return { status: "processing", container: id };
    }
    const j = await igCall(row.reel_container, { fields: "status_code" }, token, "GET");
    if (j.status_code === "ERROR" || j.status_code === "EXPIRED") return fail(`Instagram Reel ${j.status_code}`);
    if (j.status_code !== "FINISHED") return { status: "processing", container: row.reel_container };
    const post = await igCall(`${uid}/media_publish`, { creation_id: row.reel_container }, token);
    await env.DB.prepare("UPDATE ig_posts SET reel_id = ?, reel_error = NULL WHERE day = ?").bind(post.id, day).run();
    return { status: "posted", reel_id: post.id };
  } catch (e) {
    return fail(e.message);
  }
}

// ---- Monday email (Resend) ----
// Visitors sign up on the site (POST /subscribe), confirm from an email (GET /confirm), and
// every Monday from 04:00 UTC (06:00 in South Africa) get that day's menu plus last week's.
// Sending uses Resend's free plan (about 100 emails a day), so each cron tick sends at most
// NEWS_BATCH and a daily-limit answer pauses the send until the next UTC day; it picks up where
// it stopped. Without the RESEND_API_KEY secret, sign-ups are still saved and the confirmation
// emails go out once the key is set.
const RESEND_API = "https://api.resend.com";
// No reply address: replies go to noreply@, which has no routing rule, so they never reach the inbox
const NEWS_FROM = "Today's Dish <noreply@todaysdish.food>";
const SITE = "https://www.todaysdish.food/";
const NEWS_SEND_HOUR_UTC = 4;
const NEWS_BATCH = 50;
const CONFIRMS_PER_TICK = 10;
const SIGNUPS_PER_IP_PER_DAY = 5;
const CONFIRM_RESEND_MS = 60 * 60000; // one confirmation email an hour per address, at most
const PENDING_KEEP_DAYS = 7;

let subscribersReady = false;
async function ensureSubscribers(env) {
  if (subscribersReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscribers (
    email TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, confirmed_at INTEGER, confirm_sent_at INTEGER, ip_hash TEXT)`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS subscribers_by_status ON subscribers (status, email)").run();
  subscribersReady = true;
}

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cleanEmail = e => String(e || "").trim().toLowerCase();
const emailOk = e => e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(e);
const dishName = n => String(n || "").replace(/^(breakfast|lunch|dinner)\s*:\s*/i, "").replace(/^how to (make|cook)\s+/i, "").replace(/\s+recipe$/i, "").trim();
const unsubUrl = token => `${WORKER_URL}/unsubscribe?t=${token}`;

function newToken() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

function shiftDay(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const weekday = iso => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const shortDate = iso => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const mondayOf = iso => shiftDay(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));

async function resend(env, path, payload, idempotencyKey) {
  const headers = { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch(RESEND_API + path, { method: "POST", headers, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Resend ${r.status}: ${(j && (j.message || j.name)) || "error"}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

// One frame for both emails: cream page, red checker strip, the logo, then the content
function emailShell(inner, footer) {
  const checker = `<div style="height:12px;background:repeating-linear-gradient(90deg,#A8261F 0 12px,#F3E9D8 12px 24px)"></div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#F3E9D8;color:#2B1A12;font-family:'Roboto Condensed',Arial,Helvetica,sans-serif">
${checker}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3E9D8"><tr><td align="center" style="padding:24px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td align="center" style="padding:4px 0 18px"><a href="${SITE}" style="font-family:Pacifico,'Brush Script MT',cursive;font-size:34px;color:#A8261F;text-decoration:none">Today's Dish</a>
<div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#5E4A3C;padding-top:2px">One menu · Everybody eats</div></td></tr>
${inner}
<tr><td style="padding:22px 6px 0;font-size:12px;line-height:1.6;color:#5E4A3C;text-align:center">${footer}</td></tr>
</table></td></tr></table>
${checker}
</body></html>`;
}

const button = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#A8261F;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:1.5px;text-transform:uppercase;padding:15px 30px;border-radius:999px">${label}</a>`;

function confirmEmail(email, token) {
  const link = `${WORKER_URL}/confirm?t=${token}`;
  const inner = `<tr><td style="background:#FFFBF3;border-radius:16px;padding:28px 24px;text-align:center">
<div style="font-size:24px;font-weight:700;padding-bottom:10px">One tap and you're on the list</div>
<div style="font-size:16px;line-height:1.55;color:#2B1A12;padding-bottom:22px">Every Monday morning we'll email you that day's breakfast, lunch and dinner, plus everything that was on last week's menu.</div>
${button(link, "Yes, sign me up")}
<div style="font-size:13px;line-height:1.5;color:#5E4A3C;padding-top:20px">Didn't ask for this? Just ignore this email and you won't hear from us.</div>
</td></tr>`;
  return {
    from: NEWS_FROM,
    to: [email],
    subject: "Confirm your Monday menu email",
    html: emailShell(inner, `Sent because this address was entered at <a href="${SITE}" style="color:#A8261F">todaysdish.food</a>.`),
    text: `Confirm your Today's Dish email\n\nEvery Monday morning we'll email you that day's breakfast, lunch and dinner, plus last week's menu.\n\nYes, sign me up: ${link}\n\nDidn't ask for this? Just ignore this email.`,
  };
}

// Today's menu and last week's from the live site
async function weeklyMenu(day) {
  const get = async f => {
    const r = await fetch(SITE + f + "?t=" + Date.now(), { cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  };
  const today = await get("today.json");
  if (today.date !== day) throw new Error(`site shows ${today.date}, not ${day}`);
  let lastWeek = [];
  try {
    const served = (await get("history.json")).served || [];
    const from = shiftDay(day, -7);
    const byDay = new Map();
    for (const e of served) {
      if (e.date >= from && e.date < day) {
        if (!byDay.has(e.date)) byDay.set(e.date, {});
        byDay.get(e.date)[e.meal] = dishName(e.name);
      }
    }
    lastWeek = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, meals]) => ({ date, ...meals }));
  } catch (e) { /* last week is a bonus */ }
  return { today, lastWeek };
}

const MEAL_LABELS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"]];

function weeklyEmail(menu, email, token) {
  const { today, lastWeek } = menu;
  const names = MEAL_LABELS.filter(([k]) => today[k]).map(([k]) => dishName(today[k].name));
  const cards = MEAL_LABELS.filter(([k]) => today[k]).map(([k, label]) => {
    const d = today[k];
    const time = d.cookTime ? `Ready in ${d.cookTime >= 60 ? Math.floor(d.cookTime / 60) + " hr " : ""}${d.cookTime % 60 ? (d.cookTime % 60) + " min" : ""}`.trim() : "";
    return `<tr><td style="padding:0 0 14px"><a href="${SITE}" style="text-decoration:none;color:#2B1A12;display:block;background:#FFFBF3;border-radius:16px;overflow:hidden">
${d.image ? `<img src="${esc(d.image)}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0">` : ""}
<div style="padding:14px 18px 16px"><div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#A8261F">${label}</div>
<div style="font-size:21px;font-weight:700;line-height:1.25;padding-top:4px">${esc(dishName(d.name))}</div>
${time ? `<div style="font-size:14px;color:#5E4A3C;padding-top:4px">${esc(time)}</div>` : ""}</div></a></td></tr>`;
  }).join("");
  const board = `<tr><td style="background:#8A5A35;border-radius:14px;padding:8px">
<div style="background:#1D1D1D;border-radius:8px;padding:20px 16px;text-align:center;color:#F4F4F0;font-weight:700;letter-spacing:2px;text-transform:uppercase">
<div style="font-size:20px">Today's specials</div><div style="font-size:13px;color:#F4F4F0;padding-top:4px">${esc(shortDate(today.date))}</div>
${MEAL_LABELS.filter(([k]) => today[k]).map(([k, label]) => `<div style="font-size:12px;color:#F2C14E;padding-top:12px">${label}</div><div style="font-size:16px;padding-top:2px">${esc(dishName(today[k].name))}</div>`).join("")}
</div></td></tr><tr><td style="height:16px"></td></tr>`;
  const week = lastWeek.length ? `<tr><td style="padding:10px 0 0"><div style="background:#FFFBF3;border-radius:16px;padding:18px">
<div style="font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#A8261F;padding-bottom:6px">Last week's menu</div>
${lastWeek.map(w => `<div style="font-size:14px;line-height:1.5;padding:8px 0;border-top:1px solid rgba(43,26,18,0.12)"><b>${esc(shortDate(w.date))}</b><br>${MEAL_LABELS.filter(([k]) => w[k]).map(([k]) => esc(w[k])).join(" · ")}</div>`).join("")}
</div></td></tr>` : "";
  const inner = `<tr><td style="text-align:center;padding:0 6px 16px;font-size:17px;line-height:1.5">Happy ${esc(weekday(today.date))}! Here's what everybody's eating today.</td></tr>
${board}${cards}
<tr><td align="center" style="padding:8px 0 6px">${button(SITE, "See the recipes")}</td></tr>
<tr><td align="center" style="padding:4px 0 6px;font-size:14px;color:#5E4A3C">Tap "I'm eating this" and keep your streak going. New menu every day at midnight GMT.</td></tr>
${week}
<tr><td align="center" style="padding:18px 0 0;font-size:14px">Made one? Post your plate with <b>#TodaysDish</b> · <a href="https://www.instagram.com/todaysdish.food/" style="color:#A8261F">@todaysdish.food</a></td></tr>`;
  const footer = `You're getting this because you signed up at todaysdish.food. One email a week, every Monday.<br>
<a href="${unsubUrl(token)}" style="color:#A8261F">Unsubscribe</a> · Replies to this address aren't read.`;
  const text = [`Today's Dish: ${shortDate(today.date)}`, "",
    ...MEAL_LABELS.filter(([k]) => today[k]).map(([k, l]) => `${l}: ${dishName(today[k].name)}`), "",
    `See the recipes: ${SITE}`, "",
    ...(lastWeek.length ? ["Last week's menu:", ...lastWeek.map(w => `${shortDate(w.date)}: ${MEAL_LABELS.filter(([k]) => w[k]).map(([k]) => w[k]).join(" / ")}`), ""] : []),
    `Unsubscribe: ${unsubUrl(token)}`].join("\n");
  return {
    from: NEWS_FROM,
    to: [email],
    subject: `${weekday(today.date)}'s menu: ${names.join(", ")}`,
    html: emailShell(inner, footer),
    text,
    headers: { "List-Unsubscribe": `<${unsubUrl(token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// Send confirmation emails that are still owed (no key yet, or Resend was down)
async function sendOwedConfirmations(env) {
  if (!env.RESEND_API_KEY) return { status: "RESEND_API_KEY secret is not set" };
  const rows = (await env.DB.prepare("SELECT email, token FROM subscribers WHERE status = 'pending' AND confirm_sent_at IS NULL LIMIT ?").bind(CONFIRMS_PER_TICK).all()).results || [];
  let sent = 0;
  for (const r of rows) {
    try {
      await resend(env, "/emails", confirmEmail(r.email, r.token));
      await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = ? WHERE email = ?").bind(Date.now(), r.email).run();
      sent++;
    } catch (e) {
      return { sent, error: e.message };
    }
  }
  return { sent };
}

// The Monday send, a batch per cron tick, resuming where it stopped
async function runNewsletter(env, day) {
  await ensureSubscribers(env);
  await env.DB.prepare("DELETE FROM subscribers WHERE status = 'pending' AND created_at < ?").bind(Date.now() - PENDING_KEEP_DAYS * 86400000).run();
  const out = { confirmations: await sendOwedConfirmations(env) };
  if (!env.RESEND_API_KEY) return out;

  const week = mondayOf(day);
  const saved = await getSetting(env, "newsletter");
  let rec = saved ? JSON.parse(saved.value) : {};
  if (rec.week !== week) {
    if (day === week && new Date().getUTCHours() < NEWS_SEND_HOUR_UTC) return { ...out, weekly: "waiting for 04:00 UTC" };
    rec = { week, cursor: "", sent: 0, done: false };
  }
  if (rec.done) return { ...out, weekly: "sent", sent: rec.sent };
  if (rec.paused_until && rec.paused_until > day) return { ...out, weekly: "paused until " + rec.paused_until, sent: rec.sent };

  const rows = (await env.DB.prepare("SELECT email, token FROM subscribers WHERE status = 'active' AND email > ? ORDER BY email LIMIT ?").bind(rec.cursor, NEWS_BATCH).all()).results || [];
  if (!rows.length) {
    rec.done = true;
    rec.finished_at = new Date().toISOString();
  } else {
    try {
      const menu = await weeklyMenu(day);
      await resend(env, "/emails/batch", rows.map(r => weeklyEmail(menu, r.email, r.token)), `weekly-${week}-${rec.cursor || "start"}`);
      rec.cursor = rows[rows.length - 1].email;
      rec.sent += rows.length;
      delete rec.error;
      delete rec.paused_until;
    } catch (e) {
      rec.error = e.message;
      // 429 is the free plan's daily limit (or a burst): carry on tomorrow
      if (e.status === 429) rec.paused_until = shiftDay(day, 1);
    }
  }
  await setSetting(env, "newsletter", JSON.stringify(rec));
  return { ...out, weekly: rec.done ? "sent" : rec.error ? "error" : "sending", sent: rec.sent, error: rec.error };
}

// A small page in the site's look for the unsubscribe step
function page(title, body) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Today's Dish</title>
<link href="https://fonts.googleapis.com/css2?family=Pacifico&family=Roboto+Condensed:wght@500;700&display=swap" rel="stylesheet">
<style>body{margin:0;background:#F3E9D8;color:#2B1A12;font-family:'Roboto Condensed',Arial,sans-serif;text-align:center}
.c{height:24px;background:repeating-conic-gradient(#A8261F 0 25%,#F3E9D8 0 50%) 0 0/24px 24px}
main{max-width:460px;margin:0 auto;padding:36px 18px}a.l{font-family:Pacifico,cursive;font-size:36px;color:#A8261F;text-decoration:none}
.card{background:#FFFBF3;border-radius:16px;padding:26px 20px;margin-top:22px;box-shadow:0 8px 18px rgba(43,26,18,.18)}
h1{font-size:24px;margin:0 0 10px}p{font-size:16px;line-height:1.5;margin:0 0 18px}
button,.b{display:inline-block;border:0;border-radius:999px;background:#A8261F;color:#fff;font:700 16px 'Roboto Condensed',Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;padding:15px 28px;cursor:pointer;text-decoration:none}</style></head>
<body><div class="c"></div><main><a class="l" href="${SITE}">Today's Dish</a><div class="card">${body}</div></main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function runScheduled(env) {
  await setSetting(env, "cron_tick", new Date().toISOString());
  const cutoff = Date.now() - MEDIA_KEEP_DAYS * 86400000;
  await env.DB.prepare("DELETE FROM media WHERE created_at < ?").bind(cutoff).run();
  const day = utcToday();
  const live = await siteDay();
  // Post only once visitors can see the same menu the post shows
  if (live !== day) return { day, site: live, menu: await nudgeDaily(env, day) };
  const posts = await publishDay(env, day);
  // The Reel only on a tick that posted nothing else, so one run never does both
  const quiet = posts.status === "already posted" && (!posts.facebook || ["already posted", "gave up"].includes(posts.facebook.status));
  if (quiet) posts.reel = await publishReel(env, day);
  // Email only on a tick that did no posting (posted or given up on both networks), so a
  // run never does both; a problem there never touches the posts
  const settled = s => ["already posted", "gave up"].includes(s);
  if (settled(posts.status) && (!posts.facebook || settled(posts.facebook.status))) {
    try {
      posts.email = await runNewsletter(env, day);
    } catch (e) {
      posts.email = { error: e.message };
    }
  }
  return posts;
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

    // The menu day is GMT; allow a day either side for other time zones
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
      if (!/^\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.(jpg|txt|mp4)$/.test(key)) return json({ error: "Bad key" }, 400);

      if (request.method === "PUT") {
        if (!bearerOk(request, env)) return json({ error: "Unauthorized" }, 401);
        const data = await request.arrayBuffer();
        if (!data.byteLength || data.byteLength > 1900000) return json({ error: "Bad size" }, 413);
        const type = key.endsWith(".jpg") ? "image/jpeg" : key.endsWith(".mp4") ? "video/mp4" : "text/plain; charset=utf-8";
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

    // -------- /health (public, no secrets) --------
    if (url.pathname === "/health") {
      const out = { version: WORKER_VERSION, now: new Date().toISOString(), github_token_set: Boolean(env.GH_TOKEN) };
      if (env && env.DB) {
        try {
          const tick = await getSetting(env, "cron_tick");
          const dispatch = await getSetting(env, "dispatch");
          out.cron_last_ran = tick ? tick.value : "never (check the Cron Trigger is */5 * * * *)";
          out.last_job_start = dispatch ? JSON.parse(dispatch.value) : null;
        } catch (e) {
          out.db_error = e.message;
        }
      }
      return json(out);
    }

    // -------- Monday email: sign up, confirm, unsubscribe --------
    if (url.pathname === "/subscribe" && request.method === "POST") {
      if (!env || !env.DB) return json({ error: "Not set up" }, 503);
      await ensureSubscribers(env);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
      if (body.website) return json({ ok: true }); // the hidden field only bots fill in
      const email = cleanEmail(body.email);
      if (!emailOk(email)) return json({ error: "Please check your email address" }, 400);

      const ip = request.headers.get("CF-Connecting-IP") || "";
      const ipHash = await sha256Hex((env.IP_SALT || "todaysdish") + "|" + utcToday() + "|" + ip);
      const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at > ?").bind(ipHash, Date.now() - 86400000).first();
      if (recent && recent.n >= SIGNUPS_PER_IP_PER_DAY) return json({ error: "Too many sign-ups, try again tomorrow" }, 429);

      const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first();
      // Already on the list: same answer as a new sign-up, so the form never reveals who's subscribed
      if (row && row.status === "active") return json({ ok: true });
      let token = row ? row.token : newToken();
      if (!row) {
        await env.DB.prepare("INSERT INTO subscribers (email, token, status, created_at, ip_hash) VALUES (?, ?, 'pending', ?, ?)").bind(email, token, Date.now(), ipHash).run();
      } else {
        // Coming back after unsubscribing, or asking again: start over as pending
        await env.DB.prepare("UPDATE subscribers SET status = 'pending', created_at = ?, ip_hash = ? WHERE email = ?").bind(Date.now(), ipHash, email).run();
        if (row.status === "pending" && row.confirm_sent_at && Date.now() - row.confirm_sent_at < CONFIRM_RESEND_MS) return json({ ok: true });
        await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = NULL WHERE email = ?").bind(email).run();
      }
      if (env.RESEND_API_KEY) {
        try {
          await resend(env, "/emails", confirmEmail(email, token));
          await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = ? WHERE email = ?").bind(Date.now(), email).run();
        } catch (e) { /* the cron sends it later */ }
      }
      return json({ ok: true });
    }

    if (url.pathname === "/confirm" && request.method === "GET") {
      if (!env || !env.DB) return Response.redirect(SITE, 303);
      await ensureSubscribers(env);
      const t = url.searchParams.get("t") || "";
      if (/^[0-9a-f]{36}$/.test(t)) {
        await env.DB.prepare("UPDATE subscribers SET status = 'active', confirmed_at = ? WHERE token = ? AND status = 'pending'").bind(Date.now(), t).run();
        const row = await env.DB.prepare("SELECT status FROM subscribers WHERE token = ?").bind(t).first();
        if (row && row.status === "active") return Response.redirect(SITE + "?email=confirmed", 303);
      }
      return Response.redirect(SITE + "?email=expired", 303);
    }

    // GET shows a button (mail scanners open links, so a visit alone never unsubscribes);
    // POST unsubscribes, which is also what Gmail's one-click unsubscribe sends
    if (url.pathname === "/unsubscribe") {
      if (!env || !env.DB) return Response.redirect(SITE, 303);
      await ensureSubscribers(env);
      const t = url.searchParams.get("t") || "";
      const row = /^[0-9a-f]{36}$/.test(t) ? await env.DB.prepare("SELECT status FROM subscribers WHERE token = ?").bind(t).first() : null;
      if (request.method === "POST") {
        if (row) await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE token = ?").bind(t).run();
        return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>No more Monday emails. Today's menu is always waiting at the website.</p><a class="b" href="${SITE}">See today's menu</a>`);
      }
      if (!row || row.status !== "active") {
        return page("Unsubscribed", `<h1>You're not on the list</h1><p>This address won't get the Monday email.</p><a class="b" href="${SITE}">See today's menu</a>`);
      }
      return page("Unsubscribe", `<h1>Stop the Monday email?</h1><p>You'll stop getting the weekly menu. You can sign up again any time.</p>
<form method="post" action="/unsubscribe?t=${t}"><button type="submit">Unsubscribe</button></form>`);
    }

    // The Monday email with today's menu: public preview, and a test send (Bearer MEDIA_KEY)
    if (url.pathname === "/newsletter/preview" && request.method === "GET") {
      try {
        const msg = weeklyEmail(await weeklyMenu(utcToday()), "you@example.com", "0".repeat(36));
        return new Response(url.searchParams.get("confirm") ? confirmEmail("you@example.com", "0".repeat(36)).html : msg.html,
          { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      } catch (e) {
        return json({ error: e.message }, 503);
      }
    }
    if (url.pathname === "/newsletter/test" && request.method === "POST") {
      if (!bearerOk(request, env)) return json({ error: "Unauthorized" }, 401);
      if (!env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY secret is not set" }, 503);
      const to = cleanEmail(url.searchParams.get("to"));
      if (!emailOk(to)) return json({ error: "Add ?to=you@example.com" }, 400);
      try {
        const msg = weeklyEmail(await weeklyMenu(utcToday()), to, "0".repeat(36));
        msg.subject = "[Test] " + msg.subject;
        return json({ ok: true, id: (await resend(env, "/emails", msg)).id });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // -------- /ig (manual post and status, private) --------
    if (url.pathname === "/ig/publish" || url.pathname === "/ig/status") {
      if (!env || !env.DB) return json({ error: "Not set up" }, 503);
      if (!bearerOk(request, env)) return json({ error: "Unauthorized" }, 401);

      if (url.pathname === "/ig/publish" && request.method === "POST") {
        const day = url.searchParams.get("day") || utcToday();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "Invalid day" }, 400);
        return json(await publishDay(env, day));
      }
      if (url.pathname === "/ig/status" && request.method === "GET") {
        await ensureFbColumns(env);
        const posts = await env.DB.prepare("SELECT day, media_id, story_id, attempts, error, posted_at, fb_post_id, fb_story_id, fb_attempts, fb_error, reel_id, reel_attempts, reel_error FROM ig_posts ORDER BY day DESC LIMIT 7").all();
        const token = await getSetting(env, "ig_token");
        const media = await env.DB.prepare("SELECT key, length(data) AS bytes FROM media ORDER BY key DESC LIMIT 20").all();
        let account;
        try {
          const t = await igToken(env);
          account = isSystemToken(t)
            ? (env.IG_USER_ID ? await igCall(env.IG_USER_ID, { fields: "username" }, t, "GET") : { error: "IG_USER_ID secret is not set" })
            : await igCall("me", { fields: "user_id,username" }, t, "GET");
        } catch (e) {
          account = { error: e.message };
        }
        let facebook_page = null;
        if (env.FB_PAGE_ID) {
          const fbToken = env.FB_TOKEN || await igToken(env);
          try {
            const pageToken = await pageAccessToken(fbToken, env.FB_PAGE_ID);
            facebook_page = { ...(await fbCall(env.FB_PAGE_ID, { fields: "name" }, pageToken, "GET")), can_post: true };
          } catch (e) {
            facebook_page = { can_post: false, error: e.message };
          }
        }
        const dispatch = await getSetting(env, "dispatch");
        await ensureSubscribers(env);
        const subs = (await env.DB.prepare("SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status").all()).results || [];
        const news = await getSetting(env, "newsletter");
        return json({
          email: {
            resend_key: Boolean(env.RESEND_API_KEY),
            subscribers: Object.fromEntries(subs.map(r => [r.status, r.n])),
            this_week: news ? JSON.parse(news.value) : null,
          },
          today: utcToday(),
          site_shows: await siteDay(),
          last_job_start: dispatch ? JSON.parse(dispatch.value) : null,
          github_token: Boolean(env.GH_TOKEN),
          account,
          facebook_page,
          posts: posts.results,
          token: token ? (isSystemToken(token.value) ? { kind: "system user, never expires" } : { kind: "Instagram, renewed weekly", renewed_days_ago: Math.floor((Date.now() - token.updated_at) / 86400000) }) : null,
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
