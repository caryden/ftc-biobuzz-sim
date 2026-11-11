/**
 * Structure editing of a tree file: add, delete, move, and wrap nodes, and edit the settings of control nodes, such
 * as a `parallel` node's policy. Everything here works on the tree file's JSON and has no DOM, so tests can run it.
 * Each function returns an edited copy, or the tree itself when the edit doesn't apply.
 *
 * A node's path names it by its id, or by `INDEX.LABEL` when it has none, so a node without an id gets a new path when
 * a sibling before it moves. `ensureIds` gives every such node an id first, and the field editor calls it before the
 * first structure edit of a plan. It assigns ids in tree order from the structure alone, so running it on the source
 * plan gives the same ids, and the editor's change marks still match the steps.
 */
import { NODE_KINDS } from '../bt';
import { findNode } from './auto-edit';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The keys of a node's single children, in the order that the loader reads them. */
const SLOTS = ['child', 'cleanup', 'otherwise'] as const;
/** The node types whose children are a list. */
export const CONTAINERS = ['sequence', 'parallel', 'fallback', 'chain'] as const;

/** Gets a node's type: the key that names it, such as `sequence` or `ref`, or null if it has none. */
export const kindOf = (node: Json): string | null => NODE_KINDS.find(k => k in node) ?? null;
/** Gets a node's label as the loader makes it: a leaf's type, such as `drive.driveTo`, or the node type. */
const labelOf = (node: Json) => { const k = kindOf(node); return k === 'ref' ? String(node.ref) : k ?? 'node'; };

/** Gets the children of a node, each with the path segment that the loader gives it, and where it sits in the file. */
function childrenOf(node: Json): { node: Json; seg: string; key: string; index?: number }[] {
  const kind = kindOf(node); if (!kind || kind === 'ref') return [];
  const spec = node[kind]; if (!isObj(spec)) return [];
  const out: { node: Json; seg: string; key: string; index?: number }[] = [];
  if (Array.isArray(spec.children)) (spec.children as unknown[]).forEach((c, i) => { if (isObj(c)) out.push({ node: c, seg: typeof c.id === 'string' ? c.id : `${i}.${labelOf(c)}`, key: 'children', index: i }); });
  for (const k of SLOTS) if (isObj(spec[k])) out.push({ node: spec[k] as Json, seg: k, key: k });
  return out;
}

/** Calls `f` with every node of a tree and its path, in tree order. */
export function eachNode(tree: Json, f: (node: Json, path: string) => void) {
  const walk = (n: Json, path: string) => { f(n, path); for (const c of childrenOf(n)) walk(c.node, `${path}/${c.seg}`); };
  if (isObj(tree.root)) walk(tree.root, 'root');
}

/**
 * Gives every node in a list of children that has no id an id: `n1`, `n2`, and so on, in tree order, skipping the
 * ids that the tree already uses. A single child, such as a `timeout` node's `child`, keeps its path without an id.
 */
export function ensureIds(tree: Json): Json {
  const out = structuredClone(tree), used = new Set<string>();
  eachNode(out, n => { if (typeof n.id === 'string') used.add(n.id); });
  let k = 0; const next = () => { do k++; while (used.has(`n${k}`)); used.add(`n${k}`); return `n${k}`; };
  const walk = (n: Json) => { for (const c of childrenOf(n)) { if (c.key === 'children' && typeof c.node.id !== 'string') c.node.id = next(); walk(c.node); } };
  if (isObj(out.root)) walk(out.root);
  return out;
}

/**
 * Gets a function that hands out ids that the tree doesn't use, and no two the same: `s1`, `s2`, and so on for a drive
 * step, as the tree files number them, and `n1`, `n2` for the rest.
 */
export function idsFor(tree: Json): (prefix: 's' | 'n') => string {
  const used = new Set<string>(); eachNode(tree, n => { if (typeof n.id === 'string') used.add(n.id); });
  return prefix => { let k = 1; while (used.has(`${prefix}${k}`)) k++; used.add(`${prefix}${k}`); return `${prefix}${k}`; };
}
/** Gets one new id that the tree doesn't use. See `idsFor`. */
export const newId = (tree: Json, prefix: 's' | 'n') => idsFor(tree)(prefix);

/** Gets where the node at `path` sits: its parent node and the key and index in the parent's settings. Null for the root and for an unknown path. */
function locate(tree: Json, path: string): { parent: Json; key: string; index?: number } | null {
  const i = path.lastIndexOf('/'); if (i < 0) return null;
  const parent = findNode(tree, path.slice(0, i)); if (!parent) return null;
  const seg = path.slice(i + 1), c = childrenOf(parent).find(q => q.seg === seg);
  return c ? { parent, key: c.key, index: c.index } : null;
}
const specOf = (node: Json) => node[kindOf(node)!] as Json;

/** Gets where the node at `path` sits in a list of children: the container's path and the node's index. Null for the root and for a single child, such as a `timeout` node's `child`. */
export function positionOf(tree: Json, path: string): { parent: string; index: number } | null {
  const at = locate(tree, path); return at && at.key === 'children' ? { parent: path.slice(0, path.lastIndexOf('/')), index: at.index! } : null;
}

/** Gets how many children the container at `path` holds, or 0 for a node that isn't a container. */
export function childCount(tree: Json, path: string): number {
  const n = findNode(tree, path); if (!n || !isContainer(tree, path)) return 0;
  const kids = specOf(n).children; return Array.isArray(kids) ? kids.length : 0;
}

/** Checks whether the node at `path` holds a list of children, so that a node can go inside it. */
export function isContainer(tree: Json, path: string): boolean {
  const n = findNode(tree, path); return !!n && (CONTAINERS as readonly string[]).includes(kindOf(n) ?? '');
}

/** Gets the path of a child that `insert` puts at `index` of the container at `parent`. */
const childPath = (parent: string, node: Json, index: number) => `${parent}/${typeof node.id === 'string' ? node.id : `${index}.${labelOf(node)}`}`;

/** Inserts `node` into the container at `parent`, at `index`, or at the end. Returns the tree and the new node's path. */
export function insertNode(tree: Json, parent: string, node: Json, index?: number): { tree: Json; path: string } | null {
  const out = structuredClone(tree), p = findNode(out, parent); if (!p || !isContainer(out, parent)) return null;
  const spec = specOf(p), kids = (Array.isArray(spec.children) ? spec.children : (spec.children = [])) as Json[];
  const at = index === undefined ? kids.length : Math.max(0, Math.min(kids.length, index));
  kids.splice(at, 0, structuredClone(node));
  return { tree: out, path: childPath(parent, node, at) };
}

/** Inserts `node` after the node at `path`, in the same container. Returns null if the node isn't in a list, such as the root or a `timeout` node's child. */
export function insertAfter(tree: Json, path: string, node: Json): { tree: Json; path: string } | null {
  const at = locate(tree, path); if (!at || at.key !== 'children') return null;
  return insertNode(tree, path.slice(0, path.lastIndexOf('/')), node, at.index! + 1);
}

/** Deletes the node at `path` and everything under it. The root can't be deleted. A container left with no children, or a `timeout` node left with no child, is a problem of the draft until something goes there. */
export function deleteNode(tree: Json, path: string): Json {
  const out = structuredClone(tree), at = locate(out, path); if (!at) return tree;
  const spec = specOf(at.parent);
  if (at.key === 'children') (spec.children as unknown[]).splice(at.index!, 1); else delete spec[at.key];
  return out;
}

/**
 * Moves the node at `path` into the container at `parent`, before the child that is at `index` now, or to the end.
 * Returns the tree and the node's new path, or null for a move into the node's own subtree, or of the root.
 */
export function moveNode(tree: Json, path: string, parent: string, index?: number): { tree: Json; path: string } | null {
  if (parent === path || parent.startsWith(`${path}/`)) return null;
  const at = locate(tree, path), node = findNode(tree, path); if (!at || !node || !isContainer(tree, parent)) return null;
  // Removing the node first shifts the later siblings in the same container down by one.
  const from = path.slice(0, path.lastIndexOf('/')), same = from === parent && at.key === 'children';
  const cut = deleteNode(tree, path), target = same && index !== undefined && index > at.index! ? index - 1 : index;
  return insertNode(cut, parent, node, target);
}

/** Moves the node at `path` one place up (-1) or down (+1) among its siblings. Returns null at either end. */
export function moveBy(tree: Json, path: string, delta: -1 | 1): { tree: Json; path: string } | null {
  const at = locate(tree, path); if (!at || at.key !== 'children') return null;
  const n = (specOf(at.parent).children as unknown[]).length, to = at.index! + delta; if (to < 0 || to >= n) return null;
  return moveNode(tree, path, path.slice(0, path.lastIndexOf('/')), delta > 0 ? to + 1 : to);
}

/** The node types that `wrapNode` can put around a node, with their settings. */
export const WRAPS: Readonly<Record<string, (child: Json, id: string) => Json>> = {
  sequence: (c, id) => ({ id, sequence: { children: [c] } }),
  parallel: (c, id) => ({ id, parallel: { policy: 'any', children: [c] } }),
  fallback: (c, id) => ({ id, fallback: { children: [c] } }),
  timeout: (c, id) => ({ id, timeout: { sec: 3, child: c } }),
  guard: (c, id) => ({ id, guard: { when: 'true', child: c } }),
};

/** Wraps the node at `path` in a new node of type `kind`, one of `WRAPS`. Returns the tree and the wrapper's path. */
export function wrapNode(tree: Json, path: string, kind: keyof typeof WRAPS): { tree: Json; path: string } | null {
  const at = locate(tree, path), node = findNode(tree, path), make = WRAPS[kind]; if (!node || !make) return null;
  const out = structuredClone(tree), id = newId(tree, 'n'), wrapped = make(structuredClone(node), id);
  if (!at) { out.root = wrapped; return { tree: out, path: 'root' }; }
  const parent = findNode(out, path.slice(0, path.lastIndexOf('/')))!, spec = specOf(parent);
  if (at.key === 'children') (spec.children as unknown[])[at.index!] = wrapped; else spec[at.key] = wrapped;
  const parentPath = path.slice(0, path.lastIndexOf('/'));
  return { tree: out, path: at.key === 'children' ? `${parentPath}/${id}` : `${parentPath}/${at.key}` };
}

/** One setting of a control node, as a form field: a number or an expression, a choice, or an expression that must be true or false. */
export interface ControlField {
  key: string;
  label: string;
  doc: string;
  control: 'number' | 'enum' | 'expr';
  values?: readonly string[];
  /** The value as the tree writes it, or an empty string when the tree doesn't set it. */
  text: string;
  required: boolean;
  defaultText: string | null;
}

const CONTROL_FIELDS: Readonly<Record<string, readonly Omit<ControlField, 'text'>[]>> = {
  parallel: [{ key: 'policy', label: 'policy', control: 'enum', values: ['all', 'any'], required: false, defaultText: 'all', doc: '`all` ends when every child succeeds, and `any` when the first one does, which stops the rest. A child that fails ends the node.' }],
  fallback: [{ key: 'recheckSec', label: 'recheckSec', control: 'number', required: false, defaultText: null, doc: 'Seconds between checks of the guards above the running child. Without it, the fallback tries each child in turn, once.' }],
  timeout: [{ key: 'sec', label: 'sec', control: 'number', required: true, defaultText: null, doc: 'Seconds before the child stops. The node then fails.' }],
  hold: [{ key: 'sec', label: 'sec', control: 'number', required: true, defaultText: null, doc: 'Seconds that the child keeps running at least, even after the fallback above would switch.' }],
  cooldown: [
    { key: 'sec', label: 'sec', control: 'number', required: true, defaultText: null, doc: 'Seconds before the child can run again.' },
    { key: 'from', label: 'from', control: 'enum', values: ['failure', 'start'], required: false, defaultText: 'failure', doc: 'Counts the seconds from the child\'s failure, or from its start.' },
  ],
  retry: [{ key: 'attempts', label: 'attempts', control: 'number', required: true, defaultText: null, doc: 'How many times the child runs, at most, until it succeeds.' }],
  repeat: [
    { key: 'times', label: 'times', control: 'number', required: false, defaultText: null, doc: 'How many times the child runs. Without it, it repeats until `stopOn`.' },
    { key: 'stopOn', label: 'stopOn', control: 'enum', values: ['failure', 'success', 'never'], required: false, defaultText: 'failure', doc: 'The result of the child that ends the repeat.' },
  ],
  guard: [{ key: 'when', label: 'when', control: 'expr', required: true, defaultText: null, doc: 'An expression that must be true for the child to start or keep running.' }],
};

/** Gets the settings of the control node at `path` as form fields, or null for a leaf or a node type without settings. */
export function controlFields(tree: Json, path: string): ControlField[] | null {
  const n = findNode(tree, path), kind = n && kindOf(n); if (!n || !kind) return null;
  if (kind === 'condition') return [{ key: '', label: 'condition', control: 'expr', required: true, defaultText: null, text: typeof n.condition === 'string' ? n.condition : '', doc: 'An expression that is true for success and false for failure.' }];
  const fields = CONTROL_FIELDS[kind]; if (!fields) return null;
  const spec = isObj(n[kind]) ? (n[kind] as Json) : {};
  return fields.map(f => ({ ...f, text: spec[f.key] === undefined ? '' : typeof spec[f.key] === 'string' ? String(spec[f.key]) : JSON.stringify(spec[f.key]) }));
}

/** Sets one setting of the control node at `path`. Undefined removes it. A `condition` node's expression has the key `''`. */
export function setControl(tree: Json, path: string, key: string, value: unknown): Json {
  const out = structuredClone(tree), n = findNode(out, path), kind = n && kindOf(n); if (!n || !kind || kind === 'ref') return tree;
  if (kind === 'condition') { if (key === '') n.condition = value ?? ''; return out; }
  const spec = (isObj(n[kind]) ? n[kind] : (n[kind] = {})) as Json;
  if (value === undefined) delete spec[key]; else spec[key] = value;
  return out;
}
