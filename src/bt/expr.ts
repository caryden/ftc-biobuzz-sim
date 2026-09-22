/**
 * The expression language of tree files: conditions, `map`, `matches`, definitions, and parameter values.
 *
 * An expression reads field paths, numbers, strings, `true`, `false`, and `null`. It has the operators `+ - * / %`,
 * `< <= > >= == !=`, and the words `and`, `or`, and `not`, plus function calls. It can't change anything. The checker
 * types every expression against a schema before it runs, so a tree that names a missing field fails to load.
 *
 * Null rules: a field of `null` is `null`, a comparison with `null` is false except `==` and `!=`, and arithmetic on a
 * value that can be null is a type error. `exists(x)` and `coalesce(x, fallback)` handle a value that can be null.
 */
import { assignable, describe, t, type Type } from './schema';

/** A compile error, with the character position in the source. */
export class ExprError extends Error {
  constructor(readonly reason: string, readonly source: string, readonly pos: number) {
    super(`${reason}, at character ${pos + 1} of "${source}"`);
  }
}

/** A function that expressions can call. `args` is a fixed list, or one type that repeats at least `min` times. */
export interface FnSpec {
  args: readonly Type[] | { readonly variadic: Type; readonly min?: number };
  returns: Type;
  impl: (...args: any[]) => unknown;
}

/** A name that an expression can read: its type, and how to get its value from the run-time scope `S`. */
export interface VarInfo<S> { type: Type; get: (scope: S) => unknown }

/** The names and functions that expressions can use where they're compiled. */
export interface StaticScope<S> {
  lookup(name: string): VarInfo<S> | undefined;
  fns: Readonly<Record<string, FnSpec>>;
}

export interface Compiled<S> { source: string; type: Type; eval: (scope: S) => unknown }

const num = t.number();
const bool = t.boolean();

/** Math functions. A host adds its own, for example `pose` and `offset`. */
export const MATH_FNS: Record<string, FnSpec> = {
  min: { args: { variadic: num, min: 1 }, returns: num, impl: Math.min },
  max: { args: { variadic: num, min: 1 }, returns: num, impl: Math.max },
  hypot: { args: { variadic: num, min: 1 }, returns: num, impl: Math.hypot },
  abs: { args: [num], returns: num, impl: Math.abs },
  sqrt: { args: [num], returns: num, impl: Math.sqrt },
  floor: { args: [num], returns: num, impl: Math.floor },
  ceil: { args: [num], returns: num, impl: Math.ceil },
  round: { args: [num], returns: num, impl: Math.round },
  sin: { args: [num], returns: num, impl: Math.sin },
  cos: { args: [num], returns: num, impl: Math.cos },
  tan: { args: [num], returns: num, impl: Math.tan },
  atan2: { args: [num, num], returns: num, impl: Math.atan2 },
  clamp: { args: [num, num, num], returns: num, impl: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)) },
  rad: { args: [num], returns: num, impl: (deg: number) => (deg * Math.PI) / 180 },
  deg: { args: [num], returns: num, impl: (rad: number) => (rad * 180) / Math.PI },
};

/** Names that the language itself uses. No definition, binding, or function can take them. */
export const RESERVED = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'if', 'exists', 'coalesce', 'input']);

// ---- Tokens and syntax ----

type Tok =
  | { k: 'num'; v: number; p: number } | { k: 'str'; v: string; p: number } | { k: 'id'; v: string; p: number }
  | { k: 'op'; v: string; p: number } | { k: 'end'; p: number };

type Ast =
  | { t: 'lit'; v: number | string | boolean | null; p: number }
  | { t: 'id'; name: string; p: number }
  | { t: 'member'; obj: Ast; key: string; p: number }
  | { t: 'index'; obj: Ast; index: Ast; p: number }
  | { t: 'call'; callee: Ast; args: Ast[]; p: number }
  | { t: 'unary'; op: '-' | 'not'; arg: Ast; p: number }
  | { t: 'bin'; op: string; l: Ast; r: Ast; p: number };

const OPS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '%', '(', ')', '[', ']', '.', ','];

function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    const numM = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (numM) { out.push({ k: 'num', v: Number(numM[0]), p: i }); i += numM[0].length; continue; }
    const idM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (idM) { out.push({ k: 'id', v: idM[0], p: i }); i += idM[0].length; continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1); if (end < 0) throw new ExprError('this text has no closing quote', src, i);
      out.push({ k: 'str', v: src.slice(i + 1, end), p: i }); i = end + 1; continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw new ExprError(c === '=' ? "use '==' to compare" : c === '&' || c === '|' ? "use 'and' or 'or'" : c === '!' ? "use 'not'" : `unexpected character '${c}'`, src, i);
    out.push({ k: 'op', v: op, p: i }); i += op.length;
  }
  out.push({ k: 'end', p: src.length });
  return out;
}

function parse(src: string): Ast {
  const toks = tokenize(src); let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => { const k = toks[i]; return k.k === 'op' && k.v === v; };
  const isWord = (v: string) => { const k = toks[i]; return k.k === 'id' && k.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new ExprError(`expected '${v}'`, src, peek().p); i++; };

  const or = (): Ast => { let l = and(); while (isWord('or')) { const p = peek().p; i++; l = { t: 'bin', op: 'or', l, r: and(), p }; } return l; };
  const and = (): Ast => { let l = not(); while (isWord('and')) { const p = peek().p; i++; l = { t: 'bin', op: 'and', l, r: not(), p }; } return l; };
  const not = (): Ast => { if (isWord('not')) { const p = peek().p; i++; return { t: 'unary', op: 'not', arg: not(), p }; } return cmp(); };
  const cmp = (): Ast => {
    const l = add(), k = peek();
    if (k.k === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(k.v)) {
      i++; const r = add(), n = peek();
      if (n.k === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(n.v)) throw new ExprError("comparisons can't be chained; join them with 'and'", src, n.p);
      return { t: 'bin', op: k.v, l, r, p: k.p };
    }
    return l;
  };
  const add = (): Ast => { let l = mul(); for (let k = peek(); k.k === 'op' && (k.v === '+' || k.v === '-'); k = peek()) { i++; l = { t: 'bin', op: k.v, l, r: mul(), p: k.p }; } return l; };
  const mul = (): Ast => { let l = unary(); for (let k = peek(); k.k === 'op' && (k.v === '*' || k.v === '/' || k.v === '%'); k = peek()) { i++; l = { t: 'bin', op: k.v, l, r: unary(), p: k.p }; } return l; };
  const unary = (): Ast => { if (isOp('-')) { const p = peek().p; i++; return { t: 'unary', op: '-', arg: unary(), p }; } return postfix(); };
  const postfix = (): Ast => {
    let e = primary();
    for (;;) {
      const k = peek();
      if (isOp('.')) { i++; const n = peek(); if (n.k !== 'id') throw new ExprError('expected a field name after "."', src, n.p); i++; e = { t: 'member', obj: e, key: n.v, p: n.p }; }
      else if (isOp('[')) { i++; const index = or(); expect(']'); e = { t: 'index', obj: e, index, p: k.p }; }
      else if (isOp('(')) {
        i++; const args: Ast[] = [];
        if (!isOp(')')) { args.push(or()); while (isOp(',')) { i++; args.push(or()); } }
        expect(')'); e = { t: 'call', callee: e, args, p: k.p };
      } else return e;
    }
  };
  const primary = (): Ast => {
    const k = peek();
    if (k.k === 'num') { i++; return { t: 'lit', v: k.v, p: k.p }; }
    if (k.k === 'str') { i++; return { t: 'lit', v: k.v, p: k.p }; }
    if (k.k === 'id') {
      i++;
      if (k.v === 'true' || k.v === 'false') return { t: 'lit', v: k.v === 'true', p: k.p };
      if (k.v === 'null') return { t: 'lit', v: null, p: k.p };
      if (k.v === 'and' || k.v === 'or' || k.v === 'not') throw new ExprError(`'${k.v}' needs a value before it`, src, k.p);
      return { t: 'id', name: k.v, p: k.p };
    }
    if (isOp('(')) { i++; const e = or(); expect(')'); return e; }
    throw new ExprError(k.k === 'end' ? 'the expression ends too early' : `unexpected '${k.v}'`, src, k.p);
  };

  const ast = or();
  if (peek().k !== 'end') throw new ExprError(`unexpected '${(peek() as { v: unknown }).v}'`, src, peek().p);
  return ast;
}

// ---- Checking and compiling ----

type Fn<S> = (s: S) => unknown;
const strip = (type: Type): Type => (type.kind === 'nullable' ? strip(type.of) : type);
const isNum = (type: Type) => type.kind === 'number' || type.kind === 'any';
const nullable = (type: Type): Type => (type.kind === 'nullable' || type.kind === 'any' ? type : { kind: 'nullable', of: type });
const orNull = (v: unknown) => (v === undefined ? null : v);

/**
 * Compiles an expression. Throws `ExprError` if the expression doesn't parse, names something that the scope
 * doesn't have, or doesn't give the `expected` type.
 * @param maxLength The longest source accepted, in characters. Default: 400.
 */
export function compile<S>(source: string, scope: StaticScope<S>, expected?: Type, maxLength = 400): Compiled<S> {
  if (source.length > maxLength) throw new ExprError(`the expression is longer than ${maxLength} characters`, source, maxLength);
  const err = (reason: string, p: number): never => { throw new ExprError(reason, source, p); };

  const walk = (a: Ast): { type: Type; fn: Fn<S> } => {
    switch (a.t) {
      case 'lit': {
        const v = a.v;
        const type: Type = v === null ? { kind: 'nullable', of: t.any() } : typeof v === 'number' ? num : typeof v === 'boolean' ? bool : { kind: 'enum', values: [v] };
        return { type, fn: () => v };
      }
      case 'id': {
        const info = scope.lookup(a.name);
        if (!info) return err(scope.fns[a.name] || RESERVED.has(a.name) ? `'${a.name}' is a function; call it with ( )` : `unknown name '${a.name}'`, a.p);
        return { type: info.type, fn: info.get };
      }
      case 'member': {
        const o = walk(a.obj), base = strip(o.type), key = a.key;
        let type: Type;
        if (base.kind === 'any') type = base;
        else if (base.kind === 'array' && key === 'length') type = num;
        else if (base.kind === 'object') { const f = base.fields[key]; if (!f) return err(`there is no field '${key}'; the fields are ${Object.keys(base.fields).join(', ')}`, a.p); type = f; }
        else return err(`a ${describe(base)} has no field '${key}'`, a.p);
        if (o.type.kind === 'nullable') type = nullable(type);
        const get = o.fn;
        return { type, fn: s => { const v = get(s) as Record<string, unknown> | null; return v == null ? null : orNull(v[key]); } };
      }
      case 'index': {
        const o = walk(a.obj), ix = walk(a.index), base = strip(o.type);
        if (base.kind !== 'array' && base.kind !== 'any') return err(`only a list can be indexed, not a ${describe(base)}`, a.p);
        if (!isNum(ix.type)) return err('a list index must be a number', a.index.p);
        const get = o.fn, gi = ix.fn;
        return { type: base.kind === 'array' ? nullable(base.of) : base, fn: s => { const v = get(s) as unknown[] | null; return v == null ? null : orNull(v[gi(s) as number]); } };
      }
      case 'call': return call(a);
      case 'unary': {
        const x = walk(a.arg), fx = x.fn;
        if (a.op === '-') { if (!isNum(x.type)) return err(`'-' needs a number, not a ${describe(x.type)}`, a.p); return { type: num, fn: s => -(fx(s) as number) }; }
        if (x.type.kind !== 'boolean' && x.type.kind !== 'any') return err(`'not' needs true or false, not a ${describe(x.type)}`, a.p);
        return { type: bool, fn: s => !fx(s) };
      }
      case 'bin': {
        const l = walk(a.l), r = walk(a.r), fl = l.fn, fr = r.fn;
        if (a.op === 'and' || a.op === 'or') {
          for (const [x, at] of [[l, a.l], [r, a.r]] as const) if (x.type.kind !== 'boolean' && x.type.kind !== 'any') err(`'${a.op}' needs true or false on both sides, not a ${describe(x.type)}`, at.p);
          return { type: bool, fn: a.op === 'and' ? s => fl(s) === true && fr(s) === true : s => fl(s) === true || fr(s) === true };
        }
        if (a.op === '==' || a.op === '!=') {
          if (!assignable(l.type, r.type) && !assignable(r.type, l.type)) err(`a ${describe(l.type)} can't be compared with a ${describe(r.type)}`, a.p);
          return { type: bool, fn: a.op === '==' ? s => fl(s) === fr(s) : s => fl(s) !== fr(s) };
        }
        if (['<', '<=', '>', '>='].includes(a.op)) {
          for (const [x, at] of [[l, a.l], [r, a.r]] as const) if (!isNum(strip(x.type))) err(`'${a.op}' compares numbers, not a ${describe(x.type)}`, at.p);
          const cmp = a.op === '<' ? (x: number, y: number) => x < y : a.op === '<=' ? (x: number, y: number) => x <= y : a.op === '>' ? (x: number, y: number) => x > y : (x: number, y: number) => x >= y;
          return { type: bool, fn: s => { const x = fl(s), y = fr(s); return x != null && y != null && cmp(x as number, y as number); } };
        }
        for (const [x, at] of [[l, a.l], [r, a.r]] as const) if (!isNum(x.type)) err(x.type.kind === 'nullable' ? `this value can be null; use coalesce(value, fallback) before '${a.op}'` : `'${a.op}' needs numbers, not a ${describe(x.type)}`, at.p);
        const op = a.op;
        const f = op === '+' ? (s: S) => (fl(s) as number) + (fr(s) as number)
          : op === '-' ? (s: S) => (fl(s) as number) - (fr(s) as number)
          : op === '*' ? (s: S) => (fl(s) as number) * (fr(s) as number)
          : op === '/' ? (s: S) => (fl(s) as number) / (fr(s) as number)
          : (s: S) => (fl(s) as number) % (fr(s) as number);
        return { type: num, fn: f };
      }
    }
  };

  const call = (a: Extract<Ast, { t: 'call' }>): { type: Type; fn: Fn<S> } => {
    const args = a.args.map(walk);
    if (a.callee.t === 'id') {
      const name = a.callee.name;
      if (name === 'if') {
        if (args.length !== 3) return err('if(test, then, otherwise) takes three values', a.p);
        const [c, x, y] = args;
        if (c.type.kind !== 'boolean' && c.type.kind !== 'any') return err('the first value of if() must be true or false', a.args[0].p);
        const type = assignable(y.type, x.type) ? x.type : assignable(x.type, y.type) ? y.type : err(`if() gives a ${describe(x.type)} or a ${describe(y.type)}; both must have one type`, a.p);
        const fc = c.fn, fx = x.fn, fy = y.fn;
        return { type, fn: s => (fc(s) === true ? fx(s) : fy(s)) };
      }
      if (name === 'exists') {
        if (args.length !== 1) return err('exists(value) takes one value', a.p);
        const fx = args[0].fn; return { type: bool, fn: s => fx(s) != null };
      }
      if (name === 'coalesce') {
        if (args.length !== 2) return err('coalesce(value, fallback) takes two values', a.p);
        const [x, y] = args, inner = strip(x.type);
        if (!assignable(y.type, inner)) return err(`the fallback must be a ${describe(inner)}`, a.args[1].p);
        const fx = x.fn, fy = y.fn; return { type: inner, fn: s => fx(s) ?? fy(s) };
      }
      const spec = scope.fns[name];
      if (!spec) return err(scope.lookup(name) ? `'${name}' isn't a function` : `unknown function '${name}'`, a.p);
      checkArgs(name, spec.args, args, a);
      const impl = spec.impl, fs = args.map(x => x.fn);
      return { type: spec.returns, fn: s => impl(...fs.map(f => f(s))) };
    }
    if (a.callee.t === 'member') {
      const o = walk(a.callee.obj), base = strip(o.type), key = a.callee.key;
      const ft = base.kind === 'object' ? base.fields[key] : undefined;
      if (!ft || ft.kind !== 'fn') return err(`'${key}' isn't a function`, a.callee.p);
      checkArgs(key, ft.args, args, a);
      const get = o.fn, fs = args.map(x => x.fn);
      return { type: o.type.kind === 'nullable' ? nullable(ft.returns) : ft.returns, fn: s => { const v = get(s) as Record<string, (...x: unknown[]) => unknown> | null; return v == null ? null : orNull(v[key](...fs.map(f => f(s)))); } };
    }
    return err('only a function name or a field can be called', a.p);
  };

  const checkArgs = (name: string, spec: FnSpec['args'], args: { type: Type }[], a: Extract<Ast, { t: 'call' }>) => {
    if ('variadic' in spec) {
      if (args.length < (spec.min ?? 0)) err(`${name}() needs at least ${spec.min} values`, a.p);
      args.forEach((x, i) => { if (!assignable(x.type, spec.variadic)) err(`${name}() takes ${describe(spec.variadic)} values, not a ${describe(x.type)}`, a.args[i].p); });
    } else {
      if (args.length !== spec.length) err(`${name}() takes ${spec.length} values, not ${args.length}`, a.p);
      args.forEach((x, i) => { if (!assignable(x.type, spec[i])) err(`value ${i + 1} of ${name}() must be a ${describe(spec[i])}, not a ${describe(x.type)}`, a.args[i].p); });
    }
  };

  const out = walk(parse(source));
  if (expected && !assignable(out.type, expected)) err(`this expression gives a ${describe(out.type)}, but a ${describe(expected)} is needed`, 0);
  return { source, type: out.type, eval: out.fn };
}
