/**
 * Completion for the expression language: what an editor can offer at a cursor position. It reads the names in an
 * `ExprContext`, so it offers what the checker accepts, and it knows nothing about BIOBUZZ.
 */
import type { ExprContext } from './load';
import { describe, typeAt, type Type } from './schema';

/** One completion: a name, what kind of name it is, and its type as the loader describes it. */
export interface Completion { label: string; kind: 'field' | 'def' | 'fn' | 'keyword'; type?: string; path: string }

/** The words of the language, which complete like names. `if`, `exists`, and `coalesce` are called like functions. */
const KEYWORDS = ['and', 'or', 'not', 'true', 'false', 'null', 'if', 'exists', 'coalesce'];
const strip = (t: Type): Type => (t.kind === 'nullable' ? strip(t.of) : t);

/**
 * Gets the completions at character `pos` of `source`: the start of the word being typed, and the names that fit
 * there. After a dot, such as `bots.me.`, the names are the fields of that path. Elsewhere, they're the environment's
 * top-level fields, the definitions, the functions, and the words of the language. Returns null inside a string or a
 * number, and after a path that has no fields.
 */
export function completeAt(source: string, pos: number, ctx: ExprContext): { from: number; options: Completion[] } | null {
  const before = source.slice(0, pos);
  // An odd number of quotes before the cursor means that it is inside a string.
  if ((before.match(/'/g)?.length ?? 0) % 2 === 1 || (before.match(/"/g)?.length ?? 0) % 2 === 1) return null;
  const word = /[A-Za-z0-9_.]*$/.exec(before)![0];
  if (/^\d/.test(word)) return null;
  const dot = word.lastIndexOf('.');
  if (dot < 0) {
    const options: Completion[] = [
      ...Object.entries(ctx.env.fields).map(([k, t]) => ({ label: k, kind: 'field' as const, type: describe(t), path: k })),
      ...ctx.defs.map(d => ({ label: d.name, kind: 'def' as const, type: d.type.kind === 'any' ? undefined : describe(d.type), path: d.name })),
      ...Object.entries(ctx.fns).map(([k, f]) => ({ label: k, kind: 'fn' as const, type: describe(f.returns), path: k })),
      ...KEYWORDS.map(k => ({ label: k, kind: 'keyword' as const, path: k })),
    ];
    return { from: pos - word.length, options };
  }
  const base = word.slice(0, dot), [head, ...rest] = base.split('.');
  const def = ctx.defs.find(d => d.name === head);
  const root = def ? def.type : ctx.env.fields[head];
  const at = root && (rest.length ? typeAt(root, rest.join('.')) : root);
  const t = at && strip(at);
  if (!t || t.kind !== 'object') return null;
  const options = Object.entries(t.fields).map(([k, ft]) => ({ label: k, kind: 'field' as const, type: describe(ft), path: `${base}.${k}` }));
  return { from: pos - (word.length - dot - 1), options };
}
