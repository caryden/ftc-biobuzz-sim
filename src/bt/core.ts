/**
 * The core of the behavior-tree runtime: behaviors, failures, and the wrapper that runs every node.
 *
 * A behavior is a generator. Each `yield` waits for the next physics step, and the generator's return value is the
 * node's success value. A node fails by throwing a `Failure`. Anything else that a node throws is a bug: it stops the
 * tree. Halting a node calls its generator's `return` method, which runs its `finally` blocks.
 */
import type { LeafType } from './leaf';
import type { Type } from './schema';
import type { Recorder, Span } from './trace';

/** A running node. Each `yield` waits for the next physics step. */
export type Behavior<T = unknown> = Generator<void, T, void>;

/**
 * A node's typed failure. Fallbacks, retries, and recovers act on failures; they never catch other errors.
 * The class doesn't extend `Error`, so a failure that happens every step doesn't build a stack trace every step.
 */
export class Failure {
  constructor(readonly tag: string, readonly message: string = tag, readonly detail?: Readonly<Record<string, unknown>>) {}
}

/** Checks whether a thrown value is a node failure rather than a bug. */
export const isFailure = (e: unknown): e is Failure => e instanceof Failure;

/** Values that a chain's `bind` operators name. Only later children of that chain can read them. */
export type Bindings = Map<string, unknown>;

/** The run-time state of one tree for one robot. */
export interface Rt<E = unknown> {
  readonly env: E;
  /** The simulation time in seconds. Every timer in the runtime reads this clock. */
  now(): number;
  /** Counts `step` calls. A loop that finishes an iteration within one step waits for the next step. */
  readonly stepId: number;
  readonly rec: Recorder | null;
  /** The span of the node that is running now, so that a leaf's log events go to its own span. */
  span: Span | null;
  /** Gets state that a node keeps across activations, such as a cooldown's end time. */
  mem(node: number): Record<string, unknown>;
  /** Gets the value of the tree's definition number `i` for this step. */
  def(i: number): unknown;
}

/** What an expression reads when it runs. */
export interface Scope { rt: Rt; input: unknown; b: Bindings }

/** A compiled node. The loader builds these from a tree file. */
export interface CNode {
  /** The node's number in the tree, in depth-first order. */
  readonly idx: number;
  readonly kind: string;
  /** The node type, or the leaf type for a leaf, for example `sequence` or `biobuzz.navigate`. */
  readonly label: string;
  /** The node's path from the root, for example `root/1.sequence/0.biobuzz.navigate`. */
  readonly path: string;
  readonly note?: string;
  readonly children: readonly CNode[];
  /** The subsystems that the node and its descendants command. */
  readonly uses: ReadonlySet<string>;
  /** The type of the node's success value. */
  readonly out: Type;
  run(rt: Rt, input: unknown, b: Bindings): Behavior;
  /**
   * Checks whether the node could start now: a guard's condition, and whether its child is ready, for example not
   * cooling down. A reactive fallback starts a higher-priority child only if this is true.
   */
  test?(s: Scope): boolean;
  /** Guards only: checks the guard's own condition. A reactive fallback keeps a running guard only while this is true. */
  holds?(s: Scope): boolean;
  /** Leaves only: the leaf type and its compiled parameters. Tools read them, for example to preview an AUTO path. */
  readonly leaf?: { readonly type: LeafType; readonly params: Readonly<Record<string, (s: Scope) => unknown>> };
}

/**
 * Runs a node, and records its span if the tree has a recorder. Every parent starts its children through this
 * function, so every node gets a span and halting a parent halts its running descendants.
 */
export function* exec(node: CNode, rt: Rt, input: unknown, b: Bindings): Behavior {
  const rec = rt.rec, parent = rt.span;
  const span = rec ? rec.open(node, parent, rt.now(), input) : null;
  const own = span ?? parent;
  const g = node.run(rt, input, b);
  let settled = false;
  try {
    for (;;) {
      rt.span = own;
      let r: IteratorResult<void, unknown>;
      try { r = g.next(); } finally { rt.span = parent; }
      if (r.done) { settled = true; if (span) rec!.close(span, rt.now(), 'success', r.value); return r.value; }
      yield;
    }
  } catch (e) {
    settled = true;
    if (span) rec!.close(span, rt.now(), isFailure(e) ? 'failure' : 'error', e);
    throw e;
  } finally {
    // A parent halted this node while it waited for the next step.
    if (!settled) {
      rt.span = own;
      try { g.return(undefined); } finally { rt.span = parent; }
      if (span) rec!.close(span, rt.now(), 'halted');
    }
  }
}
