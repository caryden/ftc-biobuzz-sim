/**
 * The field editor's forms: a leaf's parameters as form fields, the tree's definitions as rows, and the loader's
 * problems sorted onto the steps, parameters, and definitions that they belong to. Everything here works on the tree
 * file's JSON and has no DOM, so tests can run it.
 *
 * A form field shows a value as it is written in the tree file. A number field takes a number or an expression, such
 * as `len / 2 + 0.1`, because the loader compiles a string where a number goes as an expression. An empty field
 * removes the parameter, so the leaf gets its default, or the loader reports that the parameter is required.
 */
import { describe, type LoadIssue, type ParamBase, type Registry, type TreeDef, type Type } from '../bt';
import { findNode } from './auto-edit';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The loader's problems, by what they belong to. */
export interface Problems {
  /** Problems of the whole file, such as its name. */
  tree: string[];
  /** Problems of each node, by node path. `param` names the parameter, or is null for the node itself. */
  nodes: Map<string, { param: string | null; message: string }[]>;
  /** Problems of each definition, by name. */
  defs: Map<string, string[]>;
  count: number;
}

/**
 * Writes a loader message as a sentence: `must be at least 0` becomes `Must be at least 0.` A message that starts with a
 * name, such as `pose() takes 3 values`, keeps the name as it is written.
 */
const sentence = (m: string) => { const s = /^[a-z]+ /.test(m) ? m.charAt(0).toUpperCase() + m.slice(1) : m; return /[.!?]$/.test(s) ? s : `${s}.`; };

/**
 * Sorts the loader's problems onto nodes, parameters, and definitions. A problem belongs to the node with the longest
 * path that the problem's path starts with, such as `root/steps/1.sequence/s3` for `root/steps/1.sequence/s3.params.pose`.
 * A problem that fits no node belongs to the tree.
 */
export function sortProblems(def: TreeDef | null, issues: readonly LoadIssue[]): Problems {
  const paths: string[] = [];
  const walk = (n: TreeDef['root']) => { paths.push(n.path); n.children.forEach(walk); };
  if (def) walk(def.root);
  paths.sort((a, b) => b.length - a.length);
  const out: Problems = { tree: [], nodes: new Map(), defs: new Map(), count: issues.length };
  for (const { path, message } of issues) {
    const msg = sentence(message);
    const d = /^defs\.(.+)$/.exec(path);
    if (d) { out.defs.set(d[1], [...(out.defs.get(d[1]) ?? []), msg]); continue; }
    const node = paths.find(p => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}/`));
    if (!node) { out.tree.push(msg); continue; }
    const rest = path.slice(node.length);
    let param: string | null = rest.startsWith('.params.') ? rest.slice(8).split(/[.[]/)[0] : null;
    if (rest === '.params') param = /needs the parameter '(\w+)'/.exec(message)?.[1] ?? null;
    out.nodes.set(node, [...(out.nodes.get(node) ?? []), { param, message: msg }]);
  }
  return out;
}

/** One parameter of a leaf, as a form field. */
export interface ParamField {
  key: string;
  doc?: string;
  /** A display unit, such as `s`. */
  unit?: string;
  min?: number;
  max?: number;
  /**
   * The kind of control: `number` takes a number or an expression, `expr` an expression, `enum` one of `values`,
   * `text` any text, and `list` is a list that the FIELD handles edit, such as a path's waypoints.
   */
  control: 'number' | 'expr' | 'enum' | 'text' | 'list';
  values?: readonly string[];
  /** True if the parameter can be null: an empty choice, or the word `null`. */
  nullable: boolean;
  /** True if the tree must set the parameter, because it has no default. */
  required: boolean;
  /** The default, as text, or null for a required parameter. */
  defaultText: string | null;
  /** True if the leaf evaluates the parameter on every step, as `waitUntil` does its condition. */
  live: boolean;
  /** The type, as the loader describes it, such as `number` or `'rear' | 'audience'`. */
  typeText: string;
  /** The value as the tree writes it, or an empty string when the tree doesn't set it. */
  text: string;
}

const unwrap = (t: Type): Type => (t.kind === 'nullable' ? unwrap(t.of) : t);
/** Writes a value for a form field: a string as it is, and anything else as JSON, with a pose as `pose(x, y, h)`. */
function valueText(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (isObj(v) && 'x' in v && 'y' in v && 'headingDeg' in v && Object.keys(v).length === 3) return `pose(${v.x}, ${v.y}, ${v.headingDeg})`;
  return JSON.stringify(v);
}

/** Gets the form fields of the leaf at `path` in the tree file, in the leaf type's parameter order, or null for a node that isn't a known leaf. */
export function paramFields(tree: Json, path: string, reg: Registry): ParamField[] | null {
  const node = findNode(tree, path); if (!node || typeof node.ref !== 'string') return null;
  const lt = reg.leaves[node.ref]; if (!lt) return null;
  const given = isObj(node.params) ? node.params : {};
  return Object.entries(lt.params).map(([key, ps]: [string, ParamBase]) => {
    const base = unwrap(ps.type);
    const control: ParamField['control'] = base.kind === 'number' ? 'number' : base.kind === 'enum' ? 'enum' : base.kind === 'string' ? 'text' : base.kind === 'array' ? 'list' : 'expr';
    return {
      key, doc: ps.doc, unit: ps.unit, min: ps.min, max: ps.max, control, values: base.kind === 'enum' ? base.values : undefined,
      nullable: ps.type.kind === 'nullable', required: ps.default === undefined, defaultText: ps.default === undefined ? null : ps.default === '' ? "''" : valueText(ps.default),
      live: !!ps.live, typeText: describe(ps.type), text: key in given ? valueText(given[key]) : '',
    };
  });
}

/**
 * Reads a form field's text as a parameter value: undefined for an empty field, which removes the parameter; null for
 * `null` in a field that can be null; a number for a number field that holds one; `true` or `false` for an expression
 * field that holds only that word; and otherwise the text, which the loader compiles as an expression where the type
 * isn't text.
 */
export function readField(f: Pick<ParamField, 'control' | 'nullable'>, text: string): unknown {
  const s = f.control === 'text' ? text : text.trim();
  if (s === '') return undefined;
  if (f.nullable && s === 'null') return null;
  if (f.control === 'number' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
  if (f.control === 'expr' && (s === 'true' || s === 'false')) return s === 'true';
  return s;
}

/**
 * Sets one parameter of the leaf at `path`, and returns the edited copy. Undefined removes the parameter. Returns the
 * tree itself if no leaf has that path.
 */
export function setParam(tree: Json, path: string, key: string, value: unknown): Json {
  const out = structuredClone(tree), node = findNode(out, path); if (!node || node.ref === undefined) return tree;
  const params = (isObj(node.params) ? node.params : (node.params = {})) as Json;
  if (value === undefined) delete params[key]; else params[key] = value;
  if (!Object.keys(params).length) delete node.params;
  return out;
}

/** One definition, as a row of the definitions panel. */
export interface DefRow {
  name: string;
  /** The expression as the tree writes it. */
  text: string;
  /** The type, as the loader describes it, or null if the definition didn't compile. */
  typeText: string | null;
  /** True if the definition's value is a pose, so that it is a reference point on the FIELD. */
  pose: boolean;
}

/** Gets the rows of the definitions panel, in file order. */
export function defRows(tree: Json, def: TreeDef | null): DefRow[] {
  const defs = isObj(tree.defs) ? tree.defs : {};
  return Object.entries(defs).map(([name, v]) => {
    const i = def?.defNames.indexOf(name) ?? -1, type = i >= 0 ? def!.defs[i].type : null;
    const pose = type?.kind === 'object' && ['x', 'y', 'headingDeg'].every(k => (type.fields[k] as Type | undefined)?.kind === 'number');
    return { name, text: typeof v === 'string' ? v : JSON.stringify(v), typeText: type && type.kind !== 'any' ? describe(type) : null, pose };
  });
}

/** Sets a definition's expression, and returns the edited copy. Returns the tree itself if it has no definition `name`. */
export function setDef(tree: Json, name: string, source: string): Json {
  if (!isObj(tree.defs) || !(name in tree.defs)) return tree;
  const out = structuredClone(tree); (out.defs as Json)[name] = source.trim(); return out;
}

/**
 * Adds a definition at the end of the tree's definitions. Returns the tree, or the problem with the name. The loader
 * also rejects a name that the environment or a function already has, which then shows as a problem of the draft.
 */
export function addDef(tree: Json, name: string, source: string): { tree: Json } | { error: string } {
  const n = name.trim();
  if (!NAME.test(n)) return { error: 'A name is letters, digits, and underscores, and starts with a letter.' };
  if (isObj(tree.defs) && tree.defs[n] !== undefined) return { error: `The plan already has a definition named ${n}.` };
  if (!source.trim()) return { error: 'Give the definition an expression, such as 0.5 or pose(0, 1, 90).' };
  const out = structuredClone(tree); out.defs = { ...(isObj(out.defs) ? out.defs : {}), [n]: source.trim() };
  return { tree: out };
}
