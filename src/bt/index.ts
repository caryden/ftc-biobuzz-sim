/**
 * A behavior-tree runtime that runs on simulated time. It has no DOM dependency and knows nothing about BIOBUZZ:
 * a host registers its environment schemas and leaf types. See docs/behavior-trees.md.
 */
export { Failure, isFailure, type Behavior, type CNode } from './core';
export { compile, ExprError, MATH_FNS, type FnSpec } from './expr';
export { defineLeaf, type LeafCtx, type LeafType, type ParamSpec, type Registry } from './leaf';
export { DEFAULT_LIMITS, loadTree, TreeLoadError, type Limits, type LoadIssue, type TreeDef } from './load';
export { TreeRunner, type RunnerOptions, type TreeStatus } from './runner';
export { assignable, describe, mismatch, t, typeAt, type Infer, type Type } from './schema';
export { Recorder, type LogData, type RecorderOptions, type Span } from './trace';
