/**
 * Type descriptors for the behavior-tree runtime. One descriptor gives three things: the TypeScript type (through
 * `Infer`), the static checks that the loader and the expression checker run, and the run-time check that the
 * `validate` chain operator uses. This module knows nothing about BIOBUZZ.
 */

export type Type =
  | { readonly kind: 'number'; readonly unit?: string }
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'object'; readonly fields: { readonly [name: string]: Type } }
  | { readonly kind: 'array'; readonly of: Type }
  | { readonly kind: 'nullable'; readonly of: Type }
  | { readonly kind: 'fn'; readonly args: readonly Type[]; readonly returns: Type }
  | { readonly kind: 'any' };

/** Builders for type descriptors. Each builder keeps the literal type, so that `Infer` can read it. */
export const t = {
  number: (unit?: string) => ({ kind: 'number', unit }) as const,
  string: () => ({ kind: 'string' }) as const,
  boolean: () => ({ kind: 'boolean' }) as const,
  enum: <const V extends readonly string[]>(...values: V) => ({ kind: 'enum', values }) as const,
  object: <const F extends { readonly [name: string]: Type }>(fields: F) => ({ kind: 'object', fields }) as const,
  array: <const O extends Type>(of: O) => ({ kind: 'array', of }) as const,
  nullable: <const O extends Type>(of: O) => ({ kind: 'nullable', of }) as const,
  fn: <const A extends readonly Type[], const R extends Type>(args: A, returns: R) => ({ kind: 'fn', args, returns }) as const,
  any: () => ({ kind: 'any' }) as const,
};

/** Gets the TypeScript type that a descriptor describes. */
export type Infer<T> =
  T extends { kind: 'number' } ? number
  : T extends { kind: 'string' } ? string
  : T extends { kind: 'boolean' } ? boolean
  : T extends { kind: 'enum'; values: readonly (infer V)[] } ? V
  : T extends { kind: 'object'; fields: infer F } ? { -readonly [K in keyof F]: Infer<F[K]> }
  : T extends { kind: 'array'; of: infer O } ? Infer<O>[]
  : T extends { kind: 'nullable'; of: infer O } ? Infer<O> | null
  : T extends { kind: 'fn'; returns: infer R } ? (...args: any[]) => Infer<R>
  : unknown;

/** Formats a type for error messages, for example `number`, `'rear' | 'audience'`, or `{ x, z }`. */
export function describe(type: Type): string {
  switch (type.kind) {
    case 'enum': return type.values.map(v => `'${v}'`).join(' | ');
    case 'object': return `{ ${Object.keys(type.fields).join(', ')} }`;
    case 'array': return `${describe(type.of)}[]`;
    case 'nullable': return `${describe(type.of)} or null`;
    case 'fn': return `function(${type.args.map(describe).join(', ')})`;
    default: return type.kind;
  }
}

/** Checks whether a value of type `from` can be used where type `to` is expected. */
export function assignable(from: Type, to: Type): boolean {
  if (from.kind === 'any' || to.kind === 'any') return true;
  if (to.kind === 'nullable') return from.kind === 'nullable' ? assignable(from.of, to.of) : assignable(from, to.of);
  if (from.kind === 'nullable') return false;
  switch (to.kind) {
    case 'string': return from.kind === 'string' || from.kind === 'enum';
    case 'enum': return from.kind === 'enum' && from.values.every(v => to.values.includes(v));
    case 'object': return from.kind === 'object' && Object.entries(to.fields).every(([k, f]) => k in from.fields && assignable(from.fields[k], f));
    case 'array': return from.kind === 'array' && assignable(from.of, to.of);
    case 'fn': return from.kind === 'fn' && from.args.length === to.args.length && assignable(from.returns, to.returns);
    default: return from.kind === to.kind;
  }
}

/** Checks whether a value has a type at run time. Returns null if it does, or the reason that it doesn't. */
export function mismatch(value: unknown, type: Type, at = 'value'): string | null {
  switch (type.kind) {
    case 'any': return null;
    case 'nullable': return value === null ? null : mismatch(value, type.of, at);
    case 'number': return typeof value === 'number' && !Number.isNaN(value) ? null : `${at} must be a number`;
    case 'string': return typeof value === 'string' ? null : `${at} must be a string`;
    case 'boolean': return typeof value === 'boolean' ? null : `${at} must be true or false`;
    case 'enum': return typeof value === 'string' && type.values.includes(value) ? null : `${at} must be one of ${describe(type)}`;
    case 'fn': return typeof value === 'function' ? null : `${at} must be a function`;
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be a list`;
      for (let i = 0; i < value.length; i++) { const m = mismatch(value[i], type.of, `${at}[${i}]`); if (m) return m; }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
      for (const [k, f] of Object.entries(type.fields)) { const m = mismatch((value as Record<string, unknown>)[k], f, `${at}.${k}`); if (m) return m; }
      return null;
    }
  }
}

/** Gets the type at a dotted path, for example `bots.me.drive`, or undefined if the path doesn't exist. */
export function typeAt(type: Type, path: string): Type | undefined {
  let cur: Type | undefined = type;
  for (const part of path.split('.')) {
    while (cur?.kind === 'nullable') cur = cur.of;
    if (cur?.kind !== 'object') return undefined;
    cur = cur.fields[part];
  }
  return cur;
}
