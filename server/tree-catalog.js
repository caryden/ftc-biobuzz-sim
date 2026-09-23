// The tree catalog in D1, for the Pages Functions under functions/api/trees.
//
// A deployment's system trees are the files in src/auto/trees/auto/ and src/auto/trees/teleop/ that it was built from. The build writes them to
// trees/catalog.json, with a SHA-256 per file and one hash over the set (see treeCatalog in vite.config.ts). The first
// request that reads the catalog after a deployment goes live finds that D1 holds a different set, and replaces the
// system rows in one batch, which D1 runs as a transaction. So the system rows always match the live code, including
// after a rollback, and no second pipeline can fall out of step with the deployment. Two requests that sync at once
// write the same rows. Rows that people save later have `system` 0, and a sync never touches them.

const SYSTEM_HASH = 'system_hash';

/** Reads the deployment's own trees/catalog.json through the Pages assets binding. */
export async function deploymentCatalog(env, request) {
  const res = await env.ASSETS.fetch(new URL('/trees/catalog.json', request.url));
  if (!res.ok) throw new Error(`trees/catalog.json: HTTP ${res.status}`);
  return res.json();
}

/**
 * Writes the deployment's system trees into D1 if the rows hold a different set.
 * @returns True if it wrote the rows; false if they already matched.
 */
export async function syncSystemTrees(db, catalog, now = Date.now()) {
  const current = await db.prepare('SELECT value FROM catalog WHERE key = ?1').bind(SYSTEM_HASH).first('value');
  if (current === catalog.hash) return false;
  // The WHERE clause keeps a system tree from ever replacing a tree that someone saved under the same id.
  const upsert = db.prepare(`INSERT INTO trees (id, kind, env, name, description, meta, system, owner, hash, json, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, ?7, ?8, ?9)
    ON CONFLICT(id) DO UPDATE SET kind = ?2, env = ?3, name = ?4, description = ?5, meta = ?6, hash = ?7, json = ?8, updated_at = ?9
    WHERE trees.system = 1`);
  await db.batch([
    ...catalog.trees.map(t => upsert.bind(t.id, t.kind, t.env, t.name, t.description, JSON.stringify(t.meta), t.hash, t.json, now)),
    // A system tree that this deployment doesn't have is gone from the site, so it leaves the catalog too.
    db.prepare('DELETE FROM trees WHERE system = 1 AND id NOT IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(catalog.trees.map(t => t.id))),
    db.prepare('INSERT INTO catalog (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(SYSTEM_HASH, catalog.hash),
  ]);
  return true;
}

/** True if a D1 error says that the catalog tables don't exist, which means that the migrations haven't run. */
export const missingTables = e => /no such table/i.test(String(e?.message ?? e));

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
