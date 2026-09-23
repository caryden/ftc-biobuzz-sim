// The tree catalog.
//   GET /api/trees              lists every tree: { source, synced, trees: [{ id, kind, env, name, description, meta, system, hash }] }.
//   GET /api/trees?kind=auto    lists the AUTO trees only. `kind` is `auto` or `teleop`.
// `source` is `catalog` when the list comes from D1. It is `deployment` when there is no database, as in a preview, or
// when the catalog tables don't exist yet: then the list comes from this deployment's own files, and `reason` says why.
// `synced` is true when this request wrote the deployment's system trees into D1. See server/tree-catalog.js.
import { deploymentCatalog, json, missingTables, syncSystemTrees } from '../../server/tree-catalog.js';

const summary = t => ({ id: t.id, kind: t.kind, env: t.env, name: t.name, description: t.description, meta: t.meta, system: true, hash: t.hash });

export async function onRequestGet({ env, request }) {
  const kind = new URL(request.url).searchParams.get('kind');
  if (kind !== null && kind !== 'auto' && kind !== 'teleop') return json({ error: "kind must be 'auto' or 'teleop'" }, 400);
  const catalog = await deploymentCatalog(env, request);
  const fromDeployment = reason => json({ source: 'deployment', reason, synced: false, trees: catalog.trees.filter(t => !kind || t.kind === kind).map(summary) });
  if (!env.DB) return fromDeployment('This deployment has no database binding.');
  try {
    const synced = await syncSystemTrees(env.DB, catalog);
    const rows = (await env.DB.prepare('SELECT id, kind, env, name, description, meta, system, hash FROM trees WHERE ?1 IS NULL OR kind = ?1 ORDER BY system DESC, kind, name').bind(kind).all()).results;
    return json({ source: 'catalog', synced, trees: rows.map(r => ({ ...r, meta: JSON.parse(r.meta), system: r.system === 1 })) });
  } catch (e) {
    if (missingTables(e)) return fromDeployment('The catalog tables are missing. Apply the D1 migrations in migrations/.');
    throw e;
  }
}
