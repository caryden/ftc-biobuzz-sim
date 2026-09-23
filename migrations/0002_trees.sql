-- The tree catalog: every AUTO and TELEOP tree. A system tree ships with the site. The deployment that is live writes
-- the system rows itself, from its own files, so that they always match its code: see functions/api/trees.js.
-- Trees that people save come later, as rows with `system` 0 and an owner.
CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'teleop')),
  env TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Host data from the tree file, as JSON, for example an AUTO tree's start position.
  meta TEXT NOT NULL DEFAULT '{}',
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  owner TEXT,
  -- The SHA-256 of the tree file's text, in hexadecimal.
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Settings of the catalog. `system_hash` is the hash of the system trees that the rows hold now.
CREATE TABLE IF NOT EXISTS catalog (key TEXT PRIMARY KEY, value TEXT NOT NULL);
