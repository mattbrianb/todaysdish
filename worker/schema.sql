/* D1 database for the "I'm eating this" counter (worker/worker.js, binding name DB).
   One row per device, meal and day; the primary key makes a repeat tap a no-op.
   Block comments on purpose: the D1 dashboard console joins pasted lines into one. */
CREATE TABLE IF NOT EXISTS eats (
  day TEXT NOT NULL,
  meal TEXT NOT NULL,
  device TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, meal, device)
);
CREATE INDEX IF NOT EXISTS eats_by_ip ON eats (day, ip_hash);
