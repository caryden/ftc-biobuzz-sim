// One tree file from the catalog.
//   GET /api/trees/:id   returns the tree file as JSON, or an HTTP 404 status code if no tree has that id.
// Like /api/trees, it reads D1 when it can and this deployment's own files otherwise. See server/tree-catalog.js.
import { deploymentCatalog, json, missingTables, syncSystemTrees } from '../../../server/tree-catalog.js';

const file = text => new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequestGet({ env, request, params }) {
  const catalog = await deploymentCatalog(env, request), id = String(params.id);
  const missing = () => json({ error: `no tree has the id '${id}'` }, 404);
  const fromDeployment = () => { const t = catalog.trees.find(q => q.id === id); return t ? file(t.json) : missing(); };
  if (!env.DB) return fromDeployment();
  try {
    await syncSystemTrees(env.DB, catalog);
    const text = await env.DB.prepare('SELECT json FROM trees WHERE id = ?1').bind(id).first('json');
    return text === null ? missing() : file(text);
  } catch (e) {
    if (missingTables(e)) return fromDeployment();
    throw e;
  }
}
