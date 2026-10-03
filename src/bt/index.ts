/**
 * A behavior-tree runtime that runs on simulated time. It has no DOM dependency and knows nothing about BIOBUZZ:
 * a host registers its environment schemas and leaf types.
 *
 * Nodes are written like asynchronous code: each is a generator that returns a value or throws a typed failure, and
 * each `yield` waits for the next physics step. They run on a fixed tick: `TreeRunner.step()` resumes the paused chain
 * from the root to the running leaf once per step, without re-traversing the tree. So a tree is deterministic and
 * synchronous. See "How a step runs" in docs/behavior-trees.md.
 */
export { completeAt, type Completion } from './complete';
export { Failure, isFailure, type Behavior, type CNode } from './core';
export { compile, ExprError, literalNumber, MATH_FNS, RESERVED, splitCall, type FnSpec } from './expr';
export { defineLeaf, type LeafCtx, type LeafType, type ParamBase, type ParamSpec, type Registry } from './leaf';
export { checkExpr, checkTree, DEFAULT_LIMITS, exprContext, loadTree, TreeLoadError, type Limits, type ExprContext, type LoadIssue, type TreeDef } from './load';
export { TreeRunner, type RunnerOptions, type TreeStatus } from './runner';
export { assignable, describe, mismatch, t, typeAt, type Infer, type Type } from './schema';
export { Recorder, type LogData, type RecorderOptions, type Span } from './trace';
