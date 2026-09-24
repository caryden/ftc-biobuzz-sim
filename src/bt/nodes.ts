/**
 * The run-time behavior of each node type. The loader in `load.ts` checks a tree file and calls these builders.
 * See docs/behavior-trees.md for what each node type does.
 */
import { exec, Failure, isFailure, type Behavior, type Bindings, type CNode, type Rt, type Scope } from './core';
import type { LeafCtx, LeafType } from './leaf';
import { mismatch, type Type } from './schema';

/** The fields that every node has. The builders add `run`. */
export type Base = Omit<CNode, 'run' | 'test'>;
export type Ex = (s: Scope) => unknown;
type Run = (rt: Rt, input: unknown, b: Bindings) => Behavior;

const node = (base: Base, run: Run, extra: Partial<CNode> = {}): CNode => ({ ...base, ...extra, run });
const sc = (rt: Rt, input: unknown, b: Bindings): Scope => ({ rt, input, b });
const numberOf = (f: Ex, s: Scope, what: string): number => {
  const v = f(s); if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`${what} isn't a number: ${String(v)}`); return v;
};
const allFailed = (failures: Failure[]) => new Failure('AllFailed', 'every alternative failed', { tags: failures.map(f => f.tag) });
/** Halts a child that may still run. Calling `return` on a finished generator does nothing. */
const halt = (g: Behavior) => { g.return(undefined); };

export function sequence(base: Base): CNode {
  const kids = base.children;
  return node(base, function* (rt, input, b) {
    const out: unknown[] = [];
    for (const c of kids) out.push(yield* exec(c, rt, input, b));
    return out;
  });
}

/**
 * A fallback. With `recheckSec` null, it tries each child once, in order. With a number, it's reactive: while a child
 * runs, every `recheckSec` seconds it checks the guards of the higher-priority children and of the running child. A
 * higher-priority guard that passes halts the running child and starts that one. A running child whose own guard
 * fails is halted, and the next child starts. Only guard children take part in the check. The check interval starts
 * again whenever a child starts, as the coach's once-per-second review does.
 */
export function fallback(base: Base, recheckSec: number | null): CNode {
  const kids = base.children;
  if (recheckSec === null) {
    return node(base, function* (rt, input, b) {
      const failures: Failure[] = [];
      for (const c of kids) {
        try { return yield* exec(c, rt, input, b); } catch (e) { if (!isFailure(e)) throw e; failures.push(e); }
      }
      throw allFailed(failures);
    });
  }
  // A higher-priority child must be able to start. The running child must only still meet its own guard: a cooldown that
  // began when it started doesn't stop it.
  const passes = (c: CNode, s: Scope) => c.test ? c.test(s) : true, stillHolds = (c: CNode, s: Scope) => c.holds ? c.holds(s) : passes(c, s);
  return node(base, function* (rt, input, b) {
    const failures: Failure[] = [], s = sc(rt, input, b);
    let i = 0;
    next: while (i < kids.length) {
      const g = exec(kids[i], rt, input, b); let lastCheck = rt.now();
      try {
        let r = g.next();
        while (!r.done) {
          yield;
          if (rt.now() - lastCheck >= recheckSec - 1e-9) {
            lastCheck = rt.now();
            let j = 0; while (j < i && !passes(kids[j], s)) j++;
            if (j < i) { halt(g); i = j; continue next; }
            if (!stillHolds(kids[i], s)) { halt(g); failures.push(new Failure('ConditionFalse', 'the running guard became false')); i++; continue next; }
          }
          r = g.next();
        }
        return r.value;
      } catch (e) {
        if (!isFailure(e)) throw e;
        failures.push(e); i++;
      } finally { halt(g); }
    }
    throw allFailed(failures);
  });
}

export type ParallelPolicy = { type: 'all' } | { type: 'any' } | { type: 'quorum'; n: number };

/**
 * Runs every child each step, in order. It stops as soon as the policy is decided, and halts the children that are
 * still running. `all` succeeds with every value, in child order. `any` succeeds with the first value. `quorum`
 * succeeds with the first `n` values, in child order.
 */
export function parallel(base: Base, policy: ParallelPolicy): CNode {
  const kids = base.children, need = policy.type === 'all' ? kids.length : policy.type === 'any' ? 1 : policy.n;
  return node(base, function* (rt, input, b) {
    const gens = kids.map(c => exec(c, rt, input, b)), running = kids.map(() => true);
    const ok: { i: number; v: unknown }[] = [], failures: Failure[] = [];
    let left = kids.length;
    try {
      for (;;) {
        for (let i = 0; i < gens.length; i++) {
          if (!running[i]) continue;
          try { const r = gens[i].next(); if (r.done) { running[i] = false; left--; ok.push({ i, v: r.value }); } }
          catch (e) { if (!isFailure(e)) throw e; running[i] = false; left--; failures.push(e); }
          if (ok.length >= need) {
            const vals = ok.sort((x, y) => x.i - y.i).map(x => x.v);
            return policy.type === 'any' ? vals[0] : vals.slice(0, need);
          }
          if (ok.length + left < need) {
            if (policy.type === 'all' && failures.length === 1) throw failures[0];
            throw new Failure('QuorumFailed', `${ok.length} of ${need} children succeeded`, { tags: failures.map(f => f.tag) });
          }
        }
        yield;
      }
    } finally { gens.forEach(halt); }
  });
}

/** Runs its children in order and passes each child's output to the next child. It succeeds with the last output. */
export function chain(base: Base): CNode {
  const kids = base.children;
  return node(base, function* (rt, input, b) {
    let cur = input; const own: Bindings = new Map(b);
    for (const c of kids) cur = yield* exec(c, rt, cur, own);
    return cur;
  });
}

/**
 * Runs its child only if a condition passes. Its `test`, which a reactive fallback checks, also asks the child when
 * the child can say whether it's ready, for example a cooldown, so that a fallback doesn't start a branch that can't run.
 */
export function guard(base: Base, when: Ex, source: string): CNode {
  const [child] = base.children, holds = (s: Scope) => when(s) === true, test = (s: Scope) => holds(s) && (child.test ? child.test(s) : true);
  return node(base, function* (rt, input, b) {
    if (!test(sc(rt, input, b))) throw new Failure('ConditionFalse', `the guard is false: ${source}`);
    return yield* exec(child, rt, input, b);
  }, { test, holds });
}

/**
 * Halts its child and fails with `TimedOut` when more than `sec` seconds have passed since it started. Exactly `sec`
 * seconds isn't more: at 240 steps per second, a 2.5 s timeout halts its child on the 601st step after it started.
 */
export function timeout(base: Base, sec: Ex): CNode {
  const [child] = base.children;
  return node(base, function* (rt, input, b) {
    const limit = numberOf(sec, sc(rt, input, b), 'timeout sec'), t0 = rt.now(), g = exec(child, rt, input, b);
    try {
      let r = g.next();
      while (!r.done) {
        yield;
        // The tolerance makes the length the same from any start time: (s0 + k) * dt - s0 * dt isn't exactly k * dt.
        if (rt.now() - t0 > limit + 1e-9) { halt(g); throw new Failure('TimedOut', `timed out after ${limit} s`); }
        r = g.next();
      }
      return r.value;
    } finally { halt(g); }
  });
}

/** Runs its child up to `attempts` times in all. It retries only failures whose tag is in `on`, or any failure if `on` is null. */
export function retry(base: Base, attempts: Ex, on: readonly string[] | null): CNode {
  const [child] = base.children;
  return node(base, function* (rt, input, b) {
    const n = numberOf(attempts, sc(rt, input, b), 'retry attempts');
    for (let k = 1; ; k++) {
      try { return yield* exec(child, rt, input, b); }
      catch (e) { if (!isFailure(e) || k >= n || (on && !on.includes(e.tag))) throw e; }
    }
  });
}

/**
 * Runs its child again each time it finishes, `times` times in all, or forever if `times` is null.
 * `stopOn` ends the repeat early: on the child's first `failure`, which it passes on; on its first `success`; or `never`.
 * An iteration that finishes within the step that it started in waits for the next step, so a repeat can't loop
 * forever within one step.
 */
export function repeat(base: Base, times: Ex | null, stopOn: 'failure' | 'success' | 'never'): CNode {
  const [child] = base.children;
  return node(base, function* (rt, input, b) {
    const n = times ? numberOf(times, sc(rt, input, b), 'repeat times') : Infinity;
    let last: unknown = null;
    for (let k = 0; k < n; k++) {
      const startedAt = rt.stepId;
      try { last = yield* exec(child, rt, input, b); if (stopOn === 'success') return last; }
      catch (e) { if (!isFailure(e) || stopOn === 'failure') throw e; }
      if (rt.stepId === startedAt && k + 1 < n) yield;
    }
    return last;
  });
}

/**
 * Fails at once with `CoolingDown` for `sec` seconds after its child fails, or, with `from` set to `start`, after its
 * child starts. The time holds across activations. Its `test` is false while it cools down, so a reactive fallback
 * doesn't start it then.
 */
export function cooldown(base: Base, sec: Ex, from: 'failure' | 'start' = 'failure'): CNode {
  const [child] = base.children;
  const mem = (rt: Rt) => rt.mem(base.idx) as { until?: number };
  const ready = (rt: Rt) => { const m = mem(rt); return m.until === undefined || rt.now() >= m.until - 1e-9; };
  return node(base, function* (rt, input, b) {
    const m = mem(rt);
    if (!ready(rt)) throw new Failure('CoolingDown', `cooling down until ${m.until!.toFixed(2)} s`);
    if (from === 'start') m.until = rt.now() + numberOf(sec, sc(rt, input, b), 'cooldown sec');
    try { return yield* exec(child, rt, input, b); }
    catch (e) { if (from === 'failure' && isFailure(e)) m.until = rt.now() + numberOf(sec, sc(rt, input, b), 'cooldown sec'); throw e; }
  }, { test: s => ready(s.rt) && (child.test ? child.test(s) : true) });
}

/**
 * Reuses its child's last result, a value or a failure, for `sec` seconds after the child finished. Use it on a
 * condition or a choice, so that a decision can't flip every step. The result holds across activations.
 */
export function hold(base: Base, sec: Ex): CNode {
  const [child] = base.children;
  return node(base, function* (rt, input, b) {
    const m = rt.mem(base.idx) as { at?: number; value?: unknown; failure?: Failure };
    if (m.at !== undefined && rt.now() - m.at < numberOf(sec, sc(rt, input, b), 'hold sec')) { if (m.failure) throw m.failure; return m.value; }
    try { const v = yield* exec(child, rt, input, b); m.at = rt.now(); m.value = v; m.failure = undefined; return v; }
    catch (e) { if (isFailure(e)) { m.at = rt.now(); m.failure = e; } throw e; }
  });
}

/**
 * Runs `cleanup` after its child succeeds, fails, or is halted. The cleanup must finish within the step: if it
 * doesn't, it's halted. A cleanup's own failure is recorded in the trace and doesn't change the result.
 */
export function ensure(base: Base): CNode {
  const [child, cleanup] = base.children;
  return node(base, function* (rt, input, b) {
    try { return yield* exec(child, rt, input, b); }
    finally {
      const g = exec(cleanup, rt, input, b);
      try { const r = g.next(); if (!r.done) { rt.rec?.log(rt.span, rt.now(), 'cleanup halted: it didn\'t finish within one step'); halt(g); } }
      catch (e) { if (!isFailure(e)) throw e; rt.rec?.log(rt.span, rt.now(), `cleanup failed: ${e.tag}`); }
    }
  });
}

/**
 * Turns a failure of its child into a success. It handles failures whose tag is in `on`, or any failure if `on` is
 * null. It succeeds with `value`, or runs the `otherwise` child when there is one.
 */
export function recover(base: Base, on: readonly string[] | null, value: Ex | null): CNode {
  const [child, otherwise] = base.children;
  return node(base, function* (rt, input, b) {
    try { return yield* exec(child, rt, input, b); }
    catch (e) {
      if (!isFailure(e) || (on && !on.includes(e.tag))) throw e;
      return otherwise ? yield* exec(otherwise, rt, input, b) : value ? value(sc(rt, input, b)) : null;
    }
  });
}

export function map(base: Base, f: Ex): CNode {
  return node(base, function* (rt, input, b) { return f(sc(rt, input, b)); });
}

export function matches(base: Base, f: Ex, source: string): CNode {
  return node(base, function* (rt, input, b) {
    if (f(sc(rt, input, b)) !== true) throw new Failure('MatchFailed', `the value doesn't match: ${source}`);
    return input;
  });
}

export function bind(base: Base, name: string): CNode {
  return node(base, function* (_rt, input, b) { b.set(name, input); return input; });
}

export function validate(base: Base, type: Type): CNode {
  return node(base, function* (_rt, input) {
    const m = mismatch(input, type); if (m) throw new Failure('ValidationFailed', m);
    return input;
  });
}

export function condition(base: Base, f: Ex, source: string): CNode {
  return node(base, function* (rt, input, b) {
    if (f(sc(rt, input, b)) !== true) throw new Failure('ConditionFalse', `the condition is false: ${source}`);
    return true;
  });
}

export function leaf(base: Base, type: LeafType, params: Readonly<Record<string, Ex>>): CNode {
  const keys = Object.keys(params);
  return node(base, function* (rt, input, b) {
    const s = sc(rt, input, b), values: Record<string, unknown> = {};
    for (const k of keys) { const f = params[k]; values[k] = type.params[k]?.live ? () => f(s) : f(s); }
    const ctx: LeafCtx<unknown, Record<string, unknown>> = {
      env: rt.env, params: values, input, path: base.path,
      now: () => rt.now(), log: (event, data) => rt.rec?.log(rt.span, rt.now(), event, data),
    };
    return yield* type.run(ctx);
  }, { leaf: { type, params } });
}
