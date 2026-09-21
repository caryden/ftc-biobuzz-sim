-- The match counter of the site. It starts at the number of matches that we had simulated when the counter went live on
-- September 21, 2026: 2,304 in experiments/results.jsonl and 1,164 in experiments/policy-loop.jsonl.
CREATE TABLE IF NOT EXISTS counter (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO counter (name, n) VALUES ('matches', 3468);
-- One row per visitor, to count at most one match per 25 s from one address. `who` is a salted hash, not an address.
CREATE TABLE IF NOT EXISTS recent (who TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS secret (name TEXT PRIMARY KEY, value TEXT NOT NULL);
