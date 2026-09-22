/**
 * Runs one loaded tree for one robot, one physics step at a time.
 */
import { exec, Failure, isFailure, type Behavior, type Bindings, type Rt } from './core';
import type { TreeDef } from './load';
import type { Recorder, Span } from './trace';

export type TreeStatus =
  | { state: 'running' }
  | { state: 'success'; value: unknown }
  | { state: 'failure'; failure: Failure }
  /** A node threw something other than a failure: a bug in a leaf or in the host. The tree stops. */
  | { state: 'error'; error: unknown }
  | { state: 'halted' };

export interface RunnerOptions<E> {
  /** The environment that leaves and expressions read. The host keeps it current before each step. */
  env: E;
  /** The simulation time in seconds. */
  now: () => number;
  recorder?: Recorder;
}

const NO_BINDINGS: Bindings = new Map();

export class TreeRunner<E = unknown> {
  status: TreeStatus = { state: 'running' };
  private readonly rt: RtImpl<E>;
  private gen: Behavior | null = null;

  constructor(readonly def: TreeDef, opts: RunnerOptions<E>) { this.rt = new RtImpl(def, opts); }

  /**
   * Runs the tree for one physics step: it resumes the running nodes until each one waits for the next step. Call
   * it once per step. After the tree ends, it returns the final status and does nothing.
   */
  step(): TreeStatus {
    if (this.status.state !== 'running') return this.status;
    this.rt.stepId++;
    this.gen ??= exec(this.def.root, this.rt, null, NO_BINDINGS);
    try {
      const r = this.gen.next();
      if (r.done) this.status = { state: 'success', value: r.value };
    } catch (e) {
      this.status = isFailure(e) ? { state: 'failure', failure: e } : { state: 'error', error: e };
    }
    return this.status;
  }

  /** Stops the tree. Every running node's cleanup runs. */
  halt() {
    if (this.status.state !== 'running') return;
    this.gen?.return(undefined); this.status = { state: 'halted' };
  }
}

class RtImpl<E> implements Rt<E> {
  readonly env: E; readonly now: () => number; readonly rec: Recorder | null;
  stepId = 0; span: Span | null = null;
  private readonly mems = new Map<number, Record<string, unknown>>();
  private readonly defVals: unknown[]; private readonly defAt: number[];

  constructor(private readonly tree: TreeDef, opts: RunnerOptions<E>) {
    this.env = opts.env; this.now = opts.now; this.rec = opts.recorder ?? null;
    this.defVals = tree.defs.map(() => null); this.defAt = tree.defs.map(() => -1);
  }

  mem(node: number) { let m = this.mems.get(node); if (!m) { m = {}; this.mems.set(node, m); } return m; }

  /** Definitions read the environment, so each is evaluated at most once per step. */
  def(i: number): unknown {
    if (this.defAt[i] !== this.stepId) { this.defVals[i] = this.tree.defs[i].eval({ rt: this, input: null, b: NO_BINDINGS }); this.defAt[i] = this.stepId; }
    return this.defVals[i];
  }
}
