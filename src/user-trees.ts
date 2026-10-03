/**
 * The AUTO trees that the field editor saves, kept in this browser's local storage under `biobuzz.trees.v2` as a map
 * from tree id to tree file. Storage is a convenience: in a private window, or with site data blocked, an edited tree
 * lasts until the page reloads. Sharing a tree needs the catalog and accounts. See docs/behavior-trees.md. The key
 * changed to v2 when trees moved from the simulator's x and z to FIELD x and y, so trees saved before then are ignored.
 */
import { addAutoTree, BUILT_IN_AUTO, removeAutoTree } from './auto/onboard';

const KEY = 'biobuzz.trees.v2';

function read(): Record<string, unknown> {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function write(all: Record<string, unknown>) { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* The tree lasts for this page only. */ } }

/**
 * Adds the saved trees to `AUTO_TREES`. A saved tree with problems, for example after a leaf changed, is added as a draft
 * with its problems in `AUTO_PROBLEMS`, and doesn't run. A saved value that isn't a tree is left out and stays saved.
 * Returns the ids added.
 */
export function loadUserTrees(): string[] {
  const ids: string[] = [];
  for (const [id, src] of Object.entries(read())) {
    if (BUILT_IN_AUTO.has(id)) continue;
    try { ids.push(addAutoTree(src, true).id); } catch (e) { console.warn(`The saved AUTO tree '${id}' doesn't load:`, e); }
  }
  return ids;
}

/** Saves a tree file under its id, replacing the tree saved under that id. */
export function saveUserTree(src: Record<string, unknown>) { const all = read(); all[String(src.id)] = src; write(all); }

/** Deletes a saved tree and removes it from `AUTO_TREES`. */
export function deleteUserTree(id: string) { const all = read(); delete all[id]; write(all); removeAutoTree(id); }
