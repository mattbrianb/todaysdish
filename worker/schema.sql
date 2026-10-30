/* D1 database for the Today's Dish Worker (worker/worker.js, binding name DB).
   Block comments on purpose: the D1 dashboard console joins pasted lines into one.
   Every statement is safe to run again. */

/* "I'm eating this" counter: one row per device, meal and day; a repeat tap is a no-op */
CREATE TABLE IF NOT EXISTS eats (
  day TEXT NOT NULL,
  meal TEXT NOT NULL,
  device TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, meal, device)
);
CREATE INDEX IF NOT EXISTS eats_by_ip ON eats (day, ip_hash);

/* Instagram: today's slides and caption, uploaded by the daily job, deleted after 3 days */
CREATE TABLE IF NOT EXISTS media (
  key TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

/* Daily posts: one row per day, Instagram and Facebook Page tracked separately.
   (The Worker adds the fb_ columns itself on databases created before Facebook support.) */
CREATE TABLE IF NOT EXISTS ig_posts (
  day TEXT PRIMARY KEY,
  media_id TEXT,
  story_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  posted_at INTEGER,
  fb_post_id TEXT,
  fb_story_id TEXT,
  fb_attempts INTEGER NOT NULL DEFAULT 0,
  fb_error TEXT
);

/* Instagram: the renewed access token */
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
