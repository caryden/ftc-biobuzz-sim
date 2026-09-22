/**
 * Leaf types: the actions and checks that a host, such as the BIOBUZZ simulator, registers for its trees.
 */
import type { Behavior } from './core';
import type { FnSpec } from './expr';
import type { Infer, Type } from './schema';
import type { LogData } from './trace';

/** One parameter of a leaf type. The editor draws a form field from it. */
export interface ParamBase {
  type: Type;
  /** The value when a tree doesn't set the parameter. A parameter with no default is required. */
  default?: unknown;
  doc?: string;
  /** A display unit, for example `s` or `m`. Values are always in SI units. */
  unit?: string;
  /** Bounds that the loader checks on a literal number. An expression's value isn't checked. */
  min?: number;
  max?: number;
}

/** A parameter whose default has the parameter's type. */
export type ParamSpec<T extends Type = Type> = ParamBase & { type: T; default?: Infer<T> };

/**
 * A leaf's parameters. The constraint uses `ParamBase`, because `Infer` of the whole `Type` union is too deep for
 * TypeScript to expand.
 */
export type ParamSpecs = Readonly<Record<string, ParamBase>>;
export type InferParams<S extends ParamSpecs> = { -readonly [K in keyof S]: Infer<S[K]['type']> };

/** What a leaf gets when it starts. Parameters are evaluated once, when the leaf starts. */
export interface LeafCtx<E, P> {
  env: E;
  params: P;
  /** The value that an enclosing chain passes in, or null. */
  input: unknown;
  /** The leaf's path in its tree. */
  path: string;
  /** The simulation time in seconds. */
  now(): number;
  /** Adds an event to the leaf's span in the trace. */
  log(event: string, data?: LogData): void;
}

export interface LeafType<E = any, P = any> {
  /** A dotted id that tree files use in `ref`, for example `biobuzz.navigate`. */
  id: string;
  version: number;
  doc: string;
  params: ParamSpecs;
  /** The input type that the leaf needs from an enclosing chain. Omit it for a leaf that ignores its input. */
  input?: Type;
  /** The type of the leaf's success value. Default: any. */
  output?: Type;
  /** The subsystems that the leaf commands. Two children of a parallel node can't command the same subsystem. */
  uses?: readonly string[];
  /** Paths in the environment that the leaf reads, for example `sensors.camera`. A tree whose environment lacks one fails to load. */
  needs?: readonly string[];
  run(ctx: LeafCtx<E, P>): Behavior;
}

/**
 * Defines a leaf type for environment type `E`, with parameter types inferred from `params`.
 * Call it in two steps, because TypeScript can't infer the parameters while `E` is given:
 * `defineLeaf<MyEnv>()({ id: 'wait', ... })`.
 */
export const defineLeaf = <E>() =>
  <const S extends ParamSpecs>(leaf: Omit<LeafType<E, InferParams<S>>, 'params'> & { params: S }): LeafType<E, InferParams<S>> => leaf;

/** What a host registers for its trees. */
export interface Registry {
  /** Environment schemas by name, for example `driver` and `onboard`. Each is an object type. */
  envs: Readonly<Record<string, Type>>;
  leaves: Readonly<Record<string, LeafType>>;
  /** Functions that expressions can call, in addition to the math functions. */
  fns?: Readonly<Record<string, FnSpec>>;
}
