/**
 * Loads a tree file: checks it against the registry and the environment's schema, and compiles it into nodes.
 *
 * A tree file is JSON with the shape `{ kind: "bt.tree", id, name, env, description?, meta?, defs?, root }`. `id` is a
 * stable slug, `name` is for people, and `meta` holds host data that the loader doesn't check. Each node is an object
 * with one key that names its type, plus an optional `id` and `note`. A leaf is `{ ref, params }`. See
 * docs/behavior-trees.md for the node types.
 *
 * The loader reports every problem that it finds, not only the first, so that an editor can show them all.
 */
import { Failure, type CNode, type Scope } from './core';
import { compile, ExprError, MATH_FNS, RESERVED, type Compiled, type FnSpec, type StaticScope } from './expr';
import type { LeafType, ParamBase, Registry } from './leaf';
import * as N from './nodes';
import { assignable, describe, mismatch, t, typeAt, type Type } from './schema';

export interface Limits {
  /** The most nodes in a tree. Default: 2,000. */
  maxNodes: number;
  /** The deepest nesting of nodes. Default: 40. */
  maxDepth: number;
  /** The longest expression, in characters. Default: 400. */
  maxExpr: number;
  /** The most definitions. Default: 100. */
  maxDefs: number;
}
export const DEFAULT_LIMITS: Limits = { maxNodes: 2000, maxDepth: 40, maxExpr: 400, maxDefs: 100 };

export interface LoadIssue { path: string; message: string }

export class TreeLoadError extends Error {
  constructor(readonly issues: readonly LoadIssue[]) { super(issues.map(i => `${i.path}: ${i.message}`).join('\n')); }
}

/** A checked, compiled tree. One definition can run for any number of robots. */
export interface TreeDef {
  /** A stable slug, for example `wall-sweep-pair-right`. Settings and the catalog refer to a tree by it. */
  id: string;
  /** The name that people see, for example `Wall-sweep pair: right robot`. */
  name: string;
  env: string;
  description?: string;
  /** Host data, for example an AUTO tree's start position. The loader checks only that it is an object. */
  meta: Readonly<Record<string, unknown>>;
  root: CNode;
  nodeCount: number;
  /** Definitions in file order. `Rt.def(i)` evaluates definition `i`. */
  defs: readonly Compiled<Scope>[];
  defNames: readonly string[];
}

const NODE_KINDS = ['sequence', 'fallback', 'parallel', 'chain', 'guard', 'timeout', 'retry', 'repeat', 'cooldown', 'hold', 'ensure', 'recover', 'map', 'matches', 'bind', 'validate', 'condition', 'ref'] as const;
const VALIDATE_TYPES: Record<string, Type> = { number: t.number(), string: t.string(), boolean: t.boolean(), list: t.array(t.any()), object: t.object({}) };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TREE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringy = (type: Type): boolean => type.kind === 'string' || type.kind === 'enum' || (type.kind === 'nullable' && stringy(type.of));

interface Ctx { path: string; depth: number; input: Type; bindings: ReadonlyMap<string, Type>; inChain: boolean }

/**
 * Checks and compiles a tree file.
 * @param source The parsed JSON of the file.
 * @throws TreeLoadError If the file has any problem. The error lists all of them.
 */
export function loadTree(source: unknown, reg: Registry, limits: Partial<Limits> = {}): TreeDef {
  const lim = { ...DEFAULT_LIMITS, ...limits }, issues: LoadIssue[] = [];
  const issue = (path: string, message: string) => { issues.push({ path, message }); };
  const fns: Record<string, FnSpec> = { ...MATH_FNS, ...reg.fns };
  if (!isObj(source)) throw new TreeLoadError([{ path: 'tree', message: 'a tree file must be a JSON object' }]);
  for (const k of Object.keys(source)) if (!['kind', 'id', 'name', 'env', 'description', 'meta', 'defs', 'root'].includes(k)) issue('tree', `unknown field '${k}'`);
  if (source.kind !== 'bt.tree') issue('tree', "'kind' must be \"bt.tree\"");
  const id = typeof source.id === 'string' && TREE_ID.test(source.id) ? source.id : (issue('tree', "'id' must be 1 to 64 lowercase letters, digits, and '-', starting with a letter or digit"), '');
  const name = typeof source.name === 'string' && source.name.trim() && source.name.length <= 80 ? source.name : (issue('tree', "'name' must be a non-empty string of at most 80 characters"), '');
  const envName = typeof source.env === 'string' ? source.env : '';
  const envType = reg.envs[envName];
  if (!envType || envType.kind !== 'object') {
    issue('tree', `'env' must be one of ${Object.keys(reg.envs).map(e => `"${e}"`).join(', ')}`);
    throw new TreeLoadError(issues);
  }
  const envFields = envType.fields;
  if (source.description !== undefined && typeof source.description !== 'string') issue('tree', "'description' must be a string");
  if (source.meta !== undefined && !isObj(source.meta)) issue('tree', "'meta' must be an object");

  // ---- Expressions ----
  const defTypes = new Map<string, { i: number; type: Type }>(), defs: Compiled<Scope>[] = [], defNames: string[] = [];
  const scopeFor = (c: Ctx | null): StaticScope<Scope> => ({
    fns,
    lookup(n) {
      if (c?.bindings.has(n)) { const type = c.bindings.get(n)!; return { type, get: s => s.b.get(n) ?? null }; }
      if (n === 'input' && c) return { type: c.input, get: s => s.input ?? null };
      const d = defTypes.get(n); if (d) { const i = d.i; return { type: d.type, get: s => s.rt.def(i) }; }
      const f = envFields[n]; if (f) return { type: f, get: s => (s.rt.env as Record<string, unknown>)[n] ?? null };
      return undefined;
    },
  });
  const expr = (src: unknown, c: Ctx | null, path: string, expected?: Type): Compiled<Scope> => {
    if (typeof src !== 'string') { issue(path, 'an expression must be a string'); return { source: '', type: expected ?? t.any(), eval: () => null }; }
    try { return compile(src, scopeFor(c), expected, lim.maxExpr); }
    catch (e) { if (!(e instanceof ExprError)) throw e; issue(path, e.message); return { source: src, type: expected ?? t.any(), eval: () => null }; }
  };
  /** A number, or an expression that gives a number. */
  const numberish = (v: unknown, c: Ctx, path: string): N.Ex => {
    if (typeof v === 'number') return () => v;
    if (typeof v === 'string') return expr(v, c, path, t.number()).eval;
    issue(path, 'must be a number or an expression'); return () => 0;
  };
  const nameOk = (n: unknown, path: string, what: string): n is string => {
    if (typeof n !== 'string' || !NAME.test(n)) { issue(path, `a ${what} name must be letters, digits, and underscores, and can't start with a digit`); return false; }
    if (RESERVED.has(n) || fns[n] || envFields[n]) { issue(path, `'${n}' is already the name of a field or a function`); return false; }
    return true;
  };

  // ---- Definitions ----
  if (source.defs !== undefined) {
    if (!isObj(source.defs)) issue('defs', "'defs' must be an object of name: expression");
    else {
      const entries = Object.entries(source.defs);
      if (entries.length > lim.maxDefs) issue('defs', `a tree can have at most ${lim.maxDefs} definitions`);
      for (const [n, src] of entries.slice(0, lim.maxDefs)) {
        const path = `defs.${n}`;
        if (!nameOk(n, path, 'definition')) continue;
        const c = expr(src, null, path); defTypes.set(n, { i: defs.length, type: c.type }); defs.push(c); defNames.push(n);
      }
    }
  }

  // ---- Nodes ----
  let count = 0;
  const one = (spec: Record<string, unknown>, key: string, c: Ctx, path: string): CNode => {
    if (!(key in spec)) { issue(path, `'${key}' is required`); return build({ condition: 'true' }, c, `${path}.${key}`, 0); }
    // A single child isn't a direct child of a chain, so it can't `bind`.
    return build(spec[key], { ...c, depth: c.depth + 1, inChain: false }, `${c.path}/${key}`, 0, true);
  };
  const children = (spec: Record<string, unknown>, c: Ctx, path: string, threaded: boolean): CNode[] => {
    const list = spec.children;
    if (!Array.isArray(list) || list.length === 0) { issue(path, "'children' must be a list of at least one node"); return []; }
    const out: CNode[] = [], seen = new Set<string>();
    let input = c.input; const bindings = new Map(c.bindings);
    list.forEach((raw, i) => {
      const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : null;
      if (id !== null) { if (seen.has(id)) issue(path, `two children have the id '${id}'`); seen.add(id); }
      const child = build(raw, { path: c.path, depth: c.depth + 1, input, bindings: threaded ? new Map(bindings) : c.bindings, inChain: threaded }, c.path, i);
      out.push(child);
      if (threaded) {
        if (child.kind === 'bind' && isObj(raw) && typeof raw.bind === 'string') bindings.set(raw.bind, input);
        input = child.out;
      }
    });
    return out;
  };
  const checkKeys = (spec: Record<string, unknown>, allowed: string[], path: string) => {
    for (const k of Object.keys(spec)) if (!allowed.includes(k)) issue(path, `unknown field '${k}'; the fields are ${allowed.join(', ')}`);
  };
  const tags = (v: unknown, path: string): string[] | null => {
    if (v === undefined) return null;
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[];
    issue(path, "'on' must be a list of failure tags"); return null;
  };

  /** Compiles one node. `index` numbers it among its siblings; `named` means that the path segment is already set. */
  function build(raw: unknown, c: Ctx, parentPath: string, index: number, named = false): CNode {
    const idx = count++;
    const fallbackPath = named ? parentPath : `${parentPath}/${index}`;
    // Past the limit, stop compiling, so that a huge shared tree costs no more than the limit.
    if (count > lim.maxNodes) { if (count === lim.maxNodes + 1) issue(fallbackPath, `a tree can have at most ${lim.maxNodes} nodes`); return stub(idx, fallbackPath); }
    if (c.depth > lim.maxDepth) { issue(fallbackPath, `nodes can nest at most ${lim.maxDepth} deep`); return stub(idx, fallbackPath); }
    if (!isObj(raw)) { issue(fallbackPath, 'a node must be an object'); return stub(idx, fallbackPath); }
    const kinds = NODE_KINDS.filter(k => k in raw);
    if (kinds.length !== 1) {
      issue(fallbackPath, kinds.length === 0 ? `a node needs one of these fields: ${NODE_KINDS.join(', ')}` : `a node can have only one type, but this one has ${kinds.join(' and ')}`);
      return stub(idx, fallbackPath);
    }
    const kind = kinds[0], id = raw.id;
    if (id !== undefined && (typeof id !== 'string' || !ID.test(id))) issue(fallbackPath, "'id' must be 1 to 64 letters, digits, '-', or '_'");
    const label = kind === 'ref' && typeof raw.ref === 'string' ? raw.ref : kind;
    const path = named ? parentPath : `${parentPath}/${typeof id === 'string' && ID.test(id) ? id : `${index}.${label}`}`;
    const common = ['id', 'note', kind];
    if (raw.note !== undefined && typeof raw.note !== 'string') issue(path, "'note' must be a string");
    const here: Ctx = { ...c, path };
    const spec = raw[kind], specPath = `${path}.${kind}`;
    const base = (kids: CNode[], out: Type, uses?: ReadonlySet<string>): N.Base => ({
      idx, kind, label, path, note: typeof raw.note === 'string' ? raw.note : undefined, detail: detailOf(kind, raw, spec), children: kids, out,
      uses: uses ?? new Set(kids.flatMap(k => [...k.uses])),
    });

    switch (kind) {
      case 'ref': {
        checkKeys(raw, [...common, 'params'], path);
        const lt: LeafType | undefined = typeof raw.ref === 'string' ? reg.leaves[raw.ref] : undefined;
        if (!lt) { issue(path, `unknown leaf type '${String(raw.ref)}'`); return stub(idx, path); }
        for (const need of lt.needs ?? []) if (!typeAt(envType, need)) issue(path, `${lt.id} needs '${need}', which the ${envName} environment doesn't have`);
        if (lt.input && !assignable(c.input, lt.input)) issue(path, `${lt.id} needs an input of type ${describe(lt.input)}, but gets ${describe(c.input)}`);
        const given = raw.params === undefined ? {} : raw.params;
        if (!isObj(given)) { issue(path, "'params' must be an object"); return stub(idx, path); }
        for (const k of Object.keys(given)) if (!(k in lt.params)) issue(`${path}.params`, `${lt.id} has no parameter '${k}'; its parameters are ${Object.keys(lt.params).join(', ') || 'none'}`);
        const params: Record<string, N.Ex> = {};
        for (const [k, ps] of Object.entries(lt.params)) {
          const d = ps.default;
          // TypeScript doesn't check a default against its type (see ParamSpecs), so the loader does.
          const bad = d === undefined ? null : mismatch(d, ps.type, `the default of '${k}'`);
          if (bad) issue(path, `${lt.id} is defined wrongly: ${bad}`);
          if (k in given) params[k] = param(given[k], ps.type, here, `${path}.params.${k}`, ps);
          else if (d !== undefined) params[k] = () => d;
          else issue(`${path}.params`, `${lt.id} needs the parameter '${k}'`);
        }
        return N.leaf(base([], lt.output ?? t.any(), new Set(lt.uses ?? [])), lt, params);
      }
      case 'condition': case 'map': case 'matches': {
        checkKeys(raw, common, path);
        const e = expr(spec, here, specPath, kind === 'map' ? undefined : t.boolean());
        if (kind === 'map') return N.map(base([], e.type), e.eval);
        if (kind === 'matches') return N.matches(base([], c.input), e.eval, e.source);
        return N.condition(base([], t.boolean()), e.eval, e.source);
      }
      case 'bind': {
        checkKeys(raw, common, path);
        if (!c.inChain) issue(path, "'bind' can only be a direct child of a chain");
        else if (nameOk(spec, specPath, 'binding') && defTypes.has(spec)) issue(specPath, `'${spec}' is already a definition`);
        return N.bind(base([], c.input), typeof spec === 'string' ? spec : '_');
      }
      case 'validate': {
        checkKeys(raw, common, path);
        const type = typeof spec === 'string' ? VALIDATE_TYPES[spec] : undefined;
        if (!type) { issue(specPath, `'validate' must be one of ${Object.keys(VALIDATE_TYPES).join(', ')}`); return stub(idx, path); }
        return N.validate(base([], type), type);
      }
    }

    // The remaining node types take an object of settings.
    checkKeys(raw, common, path);
    if (!isObj(spec)) { issue(specPath, `'${kind}' must be an object`); return stub(idx, path); }
    switch (kind) {
      case 'sequence': { checkKeys(spec, ['children'], specPath); const k = children(spec, here, specPath, false); return N.sequence(base(k, t.array(t.any()))); }
      case 'chain': { checkKeys(spec, ['children'], specPath); const k = children(spec, here, specPath, true); return N.chain(base(k, k.length ? k[k.length - 1].out : t.any())); }
      case 'fallback': {
        checkKeys(spec, ['children', 'recheckSec'], specPath);
        let recheck: number | null = null;
        if (spec.recheckSec !== undefined) { if (typeof spec.recheckSec === 'number' && spec.recheckSec >= 0) recheck = spec.recheckSec; else issue(specPath, "'recheckSec' must be a number of seconds, 0 or more"); }
        const k = children(spec, here, specPath, false);
        if (recheck !== null && !k.some(x => x.kind === 'guard')) issue(specPath, "a fallback with 'recheckSec' needs at least one guard child, because only guards are rechecked");
        return N.fallback(base(k, t.any()), recheck);
      }
      case 'parallel': {
        checkKeys(spec, ['children', 'policy'], specPath);
        const k = children(spec, here, specPath, false);
        let policy: N.ParallelPolicy = { type: 'all' };
        const p = spec.policy;
        if (p === 'any') policy = { type: 'any' };
        else if (isObj(p) && typeof p.quorum === 'number' && Number.isInteger(p.quorum) && p.quorum >= 1 && p.quorum <= k.length) policy = { type: 'quorum', n: p.quorum };
        else if (p !== undefined && p !== 'all') issue(specPath, `'policy' must be "all", "any", or { "quorum": n } with n from 1 to ${k.length}`);
        // Two children that command the same subsystem would fight over it.
        for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) {
          const both = [...k[i].uses].filter(u => k[j].uses.has(u));
          if (both.length) issue(specPath, `children ${i} and ${j} both command ${both.join(' and ')}`);
        }
        return N.parallel(base(k, policy.type === 'any' ? t.any() : t.array(t.any())), policy);
      }
      case 'guard': {
        checkKeys(spec, ['when', 'child'], specPath);
        const when = expr(spec.when, here, `${specPath}.when`, t.boolean()), k = one(spec, 'child', here, specPath);
        return N.guard(base([k], k.out), when.eval, when.source);
      }
      case 'timeout': case 'hold': {
        checkKeys(spec, ['sec', 'child'], specPath);
        const sec = numberish(spec.sec, here, `${specPath}.sec`), k = one(spec, 'child', here, specPath);
        return (kind === 'timeout' ? N.timeout : N.hold)(base([k], k.out), sec);
      }
      case 'cooldown': {
        checkKeys(spec, ['sec', 'from', 'child'], specPath);
        const sec = numberish(spec.sec, here, `${specPath}.sec`), k = one(spec, 'child', here, specPath), from = spec.from ?? 'failure';
        if (from !== 'failure' && from !== 'start') issue(specPath, "'from' must be \"failure\" or \"start\"");
        return N.cooldown(base([k], k.out), sec, from as 'failure' | 'start');
      }
      case 'retry': {
        checkKeys(spec, ['attempts', 'on', 'child'], specPath);
        const n = numberish(spec.attempts, here, `${specPath}.attempts`), k = one(spec, 'child', here, specPath);
        return N.retry(base([k], k.out), n, tags(spec.on, specPath));
      }
      case 'repeat': {
        checkKeys(spec, ['times', 'stopOn', 'child'], specPath);
        const times = spec.times === undefined ? null : numberish(spec.times, here, `${specPath}.times`);
        const stopOn = spec.stopOn ?? 'failure';
        if (stopOn !== 'failure' && stopOn !== 'success' && stopOn !== 'never') issue(specPath, "'stopOn' must be \"failure\", \"success\", or \"never\"");
        const k = one(spec, 'child', here, specPath);
        return N.repeat(base([k], k.out), times, stopOn as 'failure' | 'success' | 'never');
      }
      case 'ensure': {
        checkKeys(spec, ['child', 'cleanup'], specPath);
        const k = one(spec, 'child', here, specPath), cl = one(spec, 'cleanup', here, specPath);
        return N.ensure(base([k, cl], k.out));
      }
      case 'recover': {
        checkKeys(spec, ['on', 'value', 'otherwise', 'child'], specPath);
        const k = one(spec, 'child', here, specPath);
        if ((spec.value === undefined) === (spec.otherwise === undefined)) issue(specPath, "'recover' needs exactly one of 'value' and 'otherwise'");
        const value = spec.value === undefined ? null : expr(spec.value, here, `${specPath}.value`).eval;
        const kids = spec.otherwise === undefined ? [k] : [k, one(spec, 'otherwise', here, specPath)];
        return N.recover(base(kids, t.any()), tags(spec.on, specPath), value);
      }
    }
    return stub(idx, path);
  }

  /** A placeholder for a node that failed to load. The tree never runs, because the loader throws. */
  function stub(idx: number, path: string): CNode {
    return { idx, kind: 'invalid', label: 'invalid', path, children: [], uses: new Set(), out: t.any(), run: function* () { throw new Failure('Invalid'); } };
  }

  /**
   * Compiles a parameter value of type `type`. A string where the type isn't a string or an enum is an expression.
   * An object or a list is compiled field by field, so a pose can mix numbers and expressions.
   */
  function param(v: unknown, type: Type, c: Ctx, path: string, ps?: ParamBase): N.Ex {
    if (typeof v === 'string' && !stringy(type) && type.kind !== 'any') return expr(v, c, path, type).eval;
    if (type.kind === 'nullable') return v === null ? () => null : param(v, type.of, c, path);
    if (type.kind === 'object' && isObj(v)) {
      for (const k of Object.keys(v)) if (!(k in type.fields)) issue(path, `unknown field '${k}'; the fields are ${Object.keys(type.fields).join(', ')}`);
      const parts = Object.entries(type.fields).map(([k, ft]) => {
        if (!(k in v)) { if (ft.kind !== 'nullable') issue(path, `'${k}' is required`); return [k, () => null] as const; }
        return [k, param(v[k], ft, c, `${path}.${k}`)] as const;
      });
      return s => { const o: Record<string, unknown> = {}; for (const [k, f] of parts) o[k] = f(s); return o; };
    }
    if (type.kind === 'array' && Array.isArray(v)) {
      const parts = v.map((x, i) => param(x, type.of, c, `${path}[${i}]`));
      return s => parts.map(f => f(s));
    }
    const m = mismatch(v, type, 'the value');
    if (m) issue(path, m);
    if (typeof v === 'number' && ps) {
      if (ps.min !== undefined && v < ps.min) issue(path, `must be at least ${ps.min}`);
      if (ps.max !== undefined && v > ps.max) issue(path, `must be at most ${ps.max}`);
    }
    return () => v;
  }

  if (!('root' in source)) issue('tree', "'root' is required");
  const root = build(source.root, { path: '', depth: 1, input: t.any(), bindings: new Map(), inChain: false }, 'root', 0, true);
  if (issues.length) throw new TreeLoadError(issues);
  return { id, name, env: envName, description: source.description as string | undefined, meta: isObj(source.meta) ? source.meta : {}, root, nodeCount: count, defs, defNames };
}

/** Describes a node's settings in a few words, for a tree view. Expressions are shown as they are written. */
function detailOf(kind: string, raw: Record<string, unknown>, spec: unknown): string | undefined {
  const o = isObj(spec) ? spec : {}, show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (kind) {
    case 'guard': return o.when === undefined ? undefined : show(o.when);
    case 'condition': case 'map': case 'matches': return show(spec);
    case 'bind': return `as ${show(spec)}`;
    case 'validate': return show(spec);
    case 'timeout': case 'hold': return o.sec === undefined ? undefined : `${show(o.sec)} s`;
    case 'cooldown': return o.sec === undefined ? undefined : `${show(o.sec)} s from ${o.from ?? 'failure'}`;
    case 'retry': return o.attempts === undefined ? undefined : `${show(o.attempts)} attempts`;
    case 'repeat': return [o.times !== undefined ? `${show(o.times)} times` : '', `stop on ${o.stopOn ?? 'failure'}`].filter(Boolean).join(', ');
    case 'fallback': return o.recheckSec === undefined ? undefined : `recheck every ${show(o.recheckSec)} s`;
    case 'parallel': return o.policy === undefined ? 'all' : show(o.policy);
    case 'ref': {
      const params = isObj(raw.params) ? Object.entries(raw.params).filter(([k]) => k !== 'lanes') : [];
      return params.length ? params.map(([k, v]) => `${k} ${show(v)}`).join(', ') : undefined;
    }
    default: return undefined;
  }
}
