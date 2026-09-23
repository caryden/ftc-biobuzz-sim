/**
 * Records one span each time a node runs: when it started and ended in simulation seconds, how it ended, its input,
 * its output, and its log events. A match's spans form a timeline of the whole tree. The tree view reads them live,
 * and review mode reads them to show the nodes that were running at any moment.
 */
import { isFailure, type CNode } from './core';

export type LogData = Readonly<Record<string, number | string | boolean>>;
export interface SpanEvent { t: number; event: string; data?: LogData }

export interface Span {
  id: number;
  /** The id of the parent node's span, or null for the root. */
  parent: number | null;
  /** The node's number in its tree. */
  node: number;
  path: string;
  kind: string;
  label: string;
  start: number;
  /** Null while the node runs. */
  end: number | null;
  result: 'running' | 'success' | 'failure' | 'halted' | 'error';
  /** The failure tag, for a failure. */
  tag?: string;
  message?: string;
  input?: unknown;
  output?: unknown;
  events: SpanEvent[];
}

export interface RecorderOptions {
  /** The most spans kept. Later spans are counted in `dropped` but not stored. Default: 200,000. */
  maxSpans?: number;
  /** If true, stores each node's input and output. Default: true. */
  values?: boolean;
  /** The most log events kept per span. Default: 50. */
  maxEvents?: number;
}

export class Recorder {
  readonly spans: Span[] = [];
  /** Spans that weren't stored because the recorder was full. */
  dropped = 0;
  private readonly max: number; private readonly values: boolean; private readonly maxEvents: number;

  constructor(opts: RecorderOptions = {}) {
    this.max = opts.maxSpans ?? 200_000; this.values = opts.values ?? true; this.maxEvents = opts.maxEvents ?? 50;
  }

  /** Called by the runtime when a node starts. Returns null if the recorder is full. */
  open(node: CNode, parent: Span | null, t: number, input: unknown): Span | null {
    if (this.spans.length >= this.max) { this.dropped++; return null; }
    const span: Span = { id: this.spans.length, parent: parent?.id ?? null, node: node.idx, path: node.path, kind: node.kind, label: node.label, start: t, end: null, result: 'running', events: [] };
    if (this.values && input !== undefined && input !== null) span.input = input;
    this.spans.push(span);
    return span;
  }

  /** Called by the runtime when a node ends. */
  close(span: Span, t: number, result: Exclude<Span['result'], 'running'>, value?: unknown) {
    span.end = t; span.result = result;
    if (result === 'success') { if (this.values && value !== undefined) span.output = value; }
    else if (isFailure(value)) { span.tag = value.tag; span.message = value.message; }
    else if (value instanceof Error) span.message = value.message;
    else if (value !== undefined) span.message = String(value);
  }

  /** Adds a log event to a span. Called through a leaf's `log` function. */
  log(span: Span | null, t: number, event: string, data?: LogData) {
    if (!span || span.events.length >= this.maxEvents) return;
    span.events.push(data ? { t, event, data } : { t, event });
  }

  /** Gets the spans that were running at time `t`: started at or before `t`, and not ended before it. */
  activeAt(t: number): Span[] {
    return this.spans.filter(s => s.start <= t && (s.end === null || s.end >= t));
  }
}
