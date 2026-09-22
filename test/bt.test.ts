import { beforeEach, describe, expect, it } from 'vitest';
import { defineLeaf, Failure, loadTree, Recorder, t, TreeLoadError, TreeRunner, type Registry } from '../src/bt';

// A toy environment and toy leaves. Steps are 0.25 s, so that timer tests can count steps.
const DT = 0.25;
const coreFields = {
  flag: t.boolean(), other: t.boolean(), count: t.number(), side: t.enum('rear', 'audience'),
  partner: t.nullable(t.object({ x: t.number() })),
};
const fullEnv = t.object({ ...coreFields, camera: t.object({ sees: t.fn([t.enum('rear', 'audience')], t.boolean()) }) });
const bareEnv = t.object(coreFields);
interface Env { flag: boolean; other: boolean; count: number; side: 'rear' | 'audience'; partner: { x: number } | null; camera: { sees: (c: string) => boolean } }
const makeEnv = (): Env => ({ flag: false, other: false, count: 0, side: 'rear', partner: null, camera: { sees: () => true } });

let events: string[] = [];
beforeEach(() => { events = []; });

const leaf = defineLeaf<Env>();
const wait = leaf({
  id: 'test.wait', version: 1, doc: 'Waits `steps` steps and succeeds with `steps`. It logs its start, end, and halt.',
  params: { name: { type: t.string(), default: 'w' }, steps: { type: t.number(), default: 1, min: 0 } },
  *run(ctx) {
    let done = false; events.push(`${ctx.params.name}:start`);
    try { for (let i = 0; i < ctx.params.steps; i++) yield; done = true; events.push(`${ctx.params.name}:done`); return ctx.params.steps; }
    finally { if (!done) events.push(`${ctx.params.name}:halt`); }
  },
});
const fail = leaf({
  id: 'test.fail', version: 1, doc: 'Waits `steps` steps and fails with `tag`.',
  params: { tag: { type: t.string(), default: 'Nope' }, steps: { type: t.number(), default: 0 } },
  *run(ctx) { for (let i = 0; i < ctx.params.steps; i++) yield; events.push(`fail:${ctx.params.tag}`); throw new Failure(ctx.params.tag); },
});
const flaky = leaf({
  id: 'test.flaky', version: 1, doc: 'Fails with Flaky until the environment count reaches `until`, and counts each try.',
  params: { until: { type: t.number() } },
  *run(ctx) { ctx.env.count++; if (ctx.env.count < ctx.params.until) throw new Failure('Flaky'); return ctx.env.count; },
});
const emit = leaf({ id: 'test.emit', version: 1, doc: 'Succeeds with `value` at once.', params: { value: { type: t.number() } }, output: t.number(), *run(ctx) { return ctx.params.value; } });
const text = leaf({ id: 'test.text', version: 1, doc: 'Succeeds with a string.', params: {}, output: t.string(), *run() { return 'hi'; } });
const double = leaf({ id: 'test.double', version: 1, doc: 'Doubles its number input.', params: {}, input: t.number(), output: t.number(), *run(ctx) { return (ctx.input as number) * 2; } });
const drive = leaf({ id: 'test.drive', version: 1, doc: 'Commands the drive for `steps` steps.', params: { steps: { type: t.number(), default: 1 } }, uses: ['drive'], *run(ctx) { for (let i = 0; i < ctx.params.steps; i++) yield; return true; } });
const intake = leaf({ id: 'test.intake', version: 1, doc: 'Runs the intake until halted.', params: {}, uses: ['intake'], *run() { try { for (;;) yield; } finally { events.push('intake:off'); } } });
const camera = leaf({ id: 'test.camera', version: 1, doc: 'Needs the camera.', params: {}, needs: ['camera'], *run(ctx) { return ctx.env.camera.sees('rear'); } });
const logger = leaf({ id: 'test.log', version: 1, doc: 'Logs an event and waits a step.', params: {}, *run(ctx) { ctx.log('hello', { n: 1 }); yield; return 1; } });
const pose = leaf({
  id: 'test.pose', version: 1, doc: 'Succeeds with its pose parameter and its mode.',
  params: { at: { type: t.object({ x: t.number(), z: t.number(), headingDeg: t.number() }) }, mode: { type: t.enum('all', 'none'), default: 'none' } },
  *run(ctx) { return { ...ctx.params.at, mode: ctx.params.mode }; },
});
const REG: Registry = {
  envs: { full: fullEnv, bare: bareEnv },
  leaves: Object.fromEntries([wait, fail, flaky, emit, text, double, drive, intake, camera, logger, pose].map(l => [l.id, l])),
};

const tree = (root: unknown, extra: Record<string, unknown> = {}) => ({ kind: 'bt.tree', name: 'test', env: 'full', root, ...extra });
const W = (name: string, steps = 1) => ({ ref: 'test.wait', params: { name, steps } });

/** Loads a tree and runs it, one step per 0.25 s. `each` runs before each step, with the step number. */
function harness(src: unknown, env: Env = makeEnv()) {
  const def = loadTree(src, REG), rec = new Recorder(); let time = 0;
  const r = new TreeRunner(def, { env, now: () => time, recorder: rec });
  return {
    def, rec, env, r,
    run(max = 200, each?: (k: number) => void) {
      let k = 0;
      for (; k < max; k++) { time = k * DT; each?.(k); if (r.step().state !== 'running') break; }
      return { status: r.status, steps: k + 1 };
    },
  };
}
const issues = (src: unknown): string[] => {
  try { loadTree(src, REG); } catch (e) { if (e instanceof TreeLoadError) return e.issues.map(i => `${i.path}: ${i.message}`); throw e; }
  return [];
};

describe('sequence and fallback', () => {
  it('runs a sequence in order, starts the next child in the same step, and succeeds with every output', () => {
    const h = harness(tree({ sequence: { children: [W('a', 2), W('b', 0), W('c', 1)] } }));
    const { status, steps } = h.run();
    expect(status).toEqual({ state: 'success', value: [2, 0, 1] });
    expect(events).toEqual(['a:start', 'a:done', 'b:start', 'b:done', 'c:start', 'c:done']);
    expect(steps).toBe(4); // a waits 2 steps, b takes none, c waits 1.
  });
  it('fails a sequence with the first failure, and never starts the later children', () => {
    const { status } = harness(tree({ sequence: { children: [W('a'), { ref: 'test.fail', params: { tag: 'Stalled' } }, W('c')] } })).run();
    expect(status.state === 'failure' && status.failure.tag).toBe('Stalled');
    expect(events).not.toContain('c:start');
  });
  it('tries the next child of a fallback after a failure, and fails with every tag when all fail', () => {
    expect(harness(tree({ fallback: { children: [{ ref: 'test.fail' }, W('b')] } })).run().status).toEqual({ state: 'success', value: 1 });
    const { status } = harness(tree({ fallback: { children: [{ ref: 'test.fail', params: { tag: 'A' } }, { ref: 'test.fail', params: { tag: 'B' } }] } })).run();
    expect(status.state === 'failure' && status.failure.tag).toBe('AllFailed');
    expect(status.state === 'failure' && status.failure.detail).toEqual({ tags: ['A', 'B'] });
  });
  it("doesn't catch a bug: the tree stops with an error", () => {
    const def = loadTree(tree({ fallback: { children: [{ ref: 'test.camera' }, W('b')] } }), REG);
    const env = makeEnv(); env.camera = { sees: () => { throw new TypeError('broken camera'); } };
    const r = new TreeRunner(def, { env, now: () => 0 });
    const s = r.step();
    expect(s.state).toBe('error');
    expect(events).not.toContain('b:start');
  });
});

describe('reactive fallback', () => {
  const reactive = (recheckSec: number) => tree({ fallback: { recheckSec, children: [
    { guard: { when: 'flag', child: W('high', 100) } },
    { guard: { when: 'not other', child: W('mid', 100) } },
    W('low', 100),
  ] } });

  it('with recheckSec 0, preempts the running child on the first step that a higher guard passes', () => {
    const h = harness(reactive(0));
    h.run(10, k => { if (k === 3) h.env.flag = true; });
    expect(events).toEqual(['mid:start', 'mid:halt', 'high:start']);
    const mid = h.rec.spans.find(s => s.label === 'test.wait' && s.result === 'halted');
    expect(mid?.end).toBe(3 * DT);
  });
  it('with recheckSec 1, checks only once per second after a child starts', () => {
    const h = harness(reactive(1));
    let preemptedAt = -1;
    h.run(12, k => { if (k === 1) h.env.flag = true; if (preemptedAt < 0 && events.includes('mid:halt')) preemptedAt = k; });
    expect(events.slice(0, 3)).toEqual(['mid:start', 'mid:halt', 'high:start']);
    expect(preemptedAt).toBe(5); // The check at 1.0 s runs in step 4; the next callback sees it.
  });
  it("halts the running child when its own guard fails, and starts the next one", () => {
    const h = harness(reactive(0));
    h.run(6, k => { if (k === 2) h.env.other = true; });
    expect(events).toEqual(['mid:start', 'mid:halt', 'low:start']);
  });
  it('needs a guard child to recheck', () => {
    expect(issues(tree({ fallback: { recheckSec: 0, children: [W('a')] } }))[0]).toMatch(/needs at least one guard child/);
  });
});

describe('parallel', () => {
  it('with all, waits for every child and succeeds with their values in order', () => {
    const { status, steps } = harness(tree({ parallel: { children: [W('a', 3), W('b', 1)] } })).run();
    expect(status).toEqual({ state: 'success', value: [3, 1] });
    expect(steps).toBe(4);
  });
  it('with any, succeeds with the first value and halts the others', () => {
    const { status } = harness(tree({ parallel: { policy: 'any', children: [W('slow', 9), W('fast', 2), { ref: 'test.intake' }] } })).run();
    expect(status).toEqual({ state: 'success', value: 2 });
    expect(events).toEqual(expect.arrayContaining(['slow:halt', 'intake:off']));
  });
  it('with a quorum, succeeds with the first n values', () => {
    const { status } = harness(tree({ parallel: { policy: { quorum: 2 }, children: [W('a', 5), W('b', 1), W('c', 2)] } })).run();
    expect(status).toEqual({ state: 'success', value: [1, 2] });
    expect(events).toContain('a:halt');
  });
  it('with all, fails with the first failure and halts the others', () => {
    const { status } = harness(tree({ parallel: { children: [W('a', 9), { ref: 'test.fail', params: { tag: 'Stalled', steps: 1 } }] } })).run();
    expect(status.state === 'failure' && status.failure.tag).toBe('Stalled');
    expect(events).toContain('a:halt');
  });
  it('rejects two children that command the same subsystem', () => {
    const src = (b: unknown) => tree({ parallel: { children: [{ sequence: { children: [W('x'), { ref: 'test.drive' }] } }, b] } });
    expect(issues(src({ ref: 'test.drive' }))[0]).toMatch(/children 0 and 1 both command drive/);
    expect(issues(src({ ref: 'test.intake' }))).toEqual([]);
  });
});

describe('chain and dataflow', () => {
  it("passes each child's output to the next child", () => {
    const { status } = harness(tree({ chain: { children: [{ ref: 'test.emit', params: { value: 3 } }, { ref: 'test.double' }, { map: 'input + 1' }] } })).run();
    expect(status).toEqual({ state: 'success', value: 7 });
  });
  it('lets later children of a chain read a bound name', () => {
    const { status } = harness(tree({ chain: { children: [
      { ref: 'test.emit', params: { value: 2 } }, { bind: 'a' }, { ref: 'test.emit', params: { value: 5 } },
      { sequence: { children: [{ condition: 'a == 2' }] } }, { map: 'a * 10' },
    ] } })).run();
    expect(status).toEqual({ state: 'success', value: 20 });
  });
  it('keeps a bound name inside its chain, and a bind outside a chain is an error', () => {
    expect(issues(tree({ sequence: { children: [{ chain: { children: [{ ref: 'test.emit', params: { value: 1 } }, { bind: 'a' }] } }, { condition: 'a == 1' }] } }))[0]).toMatch(/unknown name 'a'/);
    expect(issues(tree({ sequence: { children: [{ bind: 'a' }] } }))[0]).toMatch(/only be a direct child of a chain/);
    expect(issues(tree({ chain: { children: [{ guard: { when: 'true', child: { bind: 'a' } } }] } }))[0]).toMatch(/only be a direct child of a chain/);
  });
  it("checks that each child's input type matches the previous output", () => {
    expect(issues(tree({ chain: { children: [{ ref: 'test.text' }, { ref: 'test.double' }] } }))[0]).toMatch(/needs an input of type number, but gets string/);
    expect(issues(tree({ chain: { children: [{ ref: 'test.text' }, { map: 'input * 2' }] } }))[0]).toMatch(/needs numbers/);
  });
  it('fails matches and validate on a value that is wrong', () => {
    const m = harness(tree({ chain: { children: [{ ref: 'test.emit', params: { value: 3 } }, { matches: 'input > 5' }] } })).run().status;
    expect(m.state === 'failure' && m.failure.tag).toBe('MatchFailed');
    const v = harness(tree({ chain: { children: [{ ref: 'test.text' }, { validate: 'number' }] } })).run().status;
    expect(v.state === 'failure' && v.failure.tag).toBe('ValidationFailed');
  });
});

describe('supervisors', () => {
  it('fails a guard with ConditionFalse', () => {
    const { status } = harness(tree({ guard: { when: 'flag', child: W('a') } })).run();
    expect(status.state === 'failure' && status.failure.tag).toBe('ConditionFalse');
  });
  it('halts a child that runs past its timeout', () => {
    const { status, steps } = harness(tree({ timeout: { sec: 1, child: W('a', 100) } })).run();
    expect(status.state === 'failure' && status.failure.tag).toBe('TimedOut');
    expect(events).toEqual(['a:start', 'a:halt']);
    expect(steps).toBe(6); // Started at 0 s; 1.25 s is the first check past 1 s.
    expect(harness(tree({ timeout: { sec: 'count + 1', child: W('b', 2) } })).run().status.state).toBe('success');
  });
  it('times out after the same number of steps from any start time', () => {
    const at240 = (startStep: number, sec: number) => {
      const def = loadTree(tree({ timeout: { sec, child: W('a', 100_000) } }), REG);
      let k = startStep; const r = new TreeRunner(def, { env: makeEnv(), now: () => k / 240 });
      let steps = 0; do { k++; steps++; } while (r.step().state === 'running');
      return steps;
    };
    for (const sec of [1.2, 2.2, 2.5, 3.5, 5]) {
      // One step starts the timeout. It ends on the first step after exactly `sec` seconds: for 2.5 s, the 601st after the start.
      const expected = Math.round(sec * 240) + 2;
      for (const start of [0, 1234, 7777, 30_000]) expect(at240(start, sec)).toBe(expected);
    }
  });
  it('retries only the listed failures, up to the number of attempts', () => {
    const h = harness(tree({ retry: { attempts: 5, child: { ref: 'test.flaky', params: { until: 3 } } } }));
    expect(h.run().status).toEqual({ state: 'success', value: 3 });
    const h2 = harness(tree({ retry: { attempts: 2, child: { ref: 'test.flaky', params: { until: 3 } } } }));
    expect(h2.run().status.state).toBe('failure');
    expect(h2.env.count).toBe(2);
    const h3 = harness(tree({ retry: { attempts: 5, on: ['Stalled'], child: { ref: 'test.flaky', params: { until: 3 } } } }));
    expect(h3.run().status.state).toBe('failure');
    expect(h3.env.count).toBe(1);
  });
  it('repeats a set number of times, and a repeat of an instant child waits a step between iterations', () => {
    expect(harness(tree({ repeat: { times: 3, child: W('a', 1) } })).run().status).toEqual({ state: 'success', value: 1 });
    expect(events.filter(e => e === 'a:start')).toHaveLength(3);
    events = [];
    const h = harness(tree({ repeat: { stopOn: 'never', child: { ref: 'test.fail' } } }));
    h.run(5);
    expect(events).toHaveLength(5);
  });
  it('fails at once while cooling down after a failure', () => {
    const h = harness(tree({ repeat: { stopOn: 'never', child: { fallback: { children: [{ cooldown: { sec: 1, child: { ref: 'test.fail', params: { tag: 'Stalled' } } } }, W('rest', 0)] } } } }));
    h.run(9);
    // The failing child runs at 0 s, then cools down until 1 s, runs at 1 s, and cools down until 2 s.
    expect(events.filter(e => e === 'fail:Stalled')).toHaveLength(3);
  });
  it('holds a decision even when the environment changes', () => {
    const h = harness(tree({ repeat: { stopOn: 'never', child: { fallback: { children: [{ hold: { sec: 1, child: { condition: 'flag' } } }, W('no', 0)] } } } }));
    const seen: number[] = [];
    h.run(10, k => { h.env.flag = k === 1 || k === 4; seen.push(events.filter(e => e === 'no:start').length); });
    // The condition is false at 0 s and held until 1 s, so the true flag at 0.25 s changes nothing and 'no' runs in
    // steps 0 to 3. At 1 s it's true and held until 2 s, so 'no' doesn't run in steps 4 to 7 although the flag is
    // false again. At 2 s the condition is checked again and is false.
    expect(seen.slice(1, 9)).toEqual([1, 2, 3, 4, 4, 4, 4, 4]);
    expect(seen[9]).toBe(5);
  });
  it('runs an ensure cleanup after success, after failure, and after a halt', () => {
    const ens = (child: unknown) => tree({ ensure: { child, cleanup: W('clean', 0) } });
    harness(ens(W('a'))).run(); expect(events.slice(-2)).toEqual(['clean:start', 'clean:done']);
    events = []; harness(ens({ ref: 'test.fail' })).run(); expect(events).toEqual(['fail:Nope', 'clean:start', 'clean:done']);
    events = []; const h = harness(ens(W('a', 99))); h.run(3); h.r.halt(); expect(events).toEqual(['a:start', 'a:halt', 'clean:start', 'clean:done']);
  });
  it('recovers the listed failures with a value or another child', () => {
    expect(harness(tree({ recover: { on: ['Nope'], value: '42', child: { ref: 'test.fail' } } })).run().status).toEqual({ state: 'success', value: 42 });
    expect(harness(tree({ recover: { otherwise: W('alt', 0), child: { ref: 'test.fail' } } })).run().status).toEqual({ state: 'success', value: 0 });
    expect(harness(tree({ recover: { on: ['Other'], value: '1', child: { ref: 'test.fail' } } })).run().status.state).toBe('failure');
  });
});

describe('halting and determinism', () => {
  it('runs the cleanup of every running descendant when the tree halts', () => {
    const h = harness(tree({ sequence: { children: [{ parallel: { children: [W('a', 9), { ref: 'test.intake' }] } }] } }));
    h.run(3); h.r.halt();
    expect(events).toEqual(['a:start', 'a:halt', 'intake:off']);
    expect(h.r.status.state).toBe('halted');
  });
  it('gives the same trace for the same inputs', () => {
    const src = tree({ fallback: { recheckSec: 0, children: [{ guard: { when: 'flag', child: W('h', 3) } }, { timeout: { sec: 2, child: W('l', 50) } }] } });
    const once = () => { const h = harness(src); h.run(40, k => { h.env.flag = k === 5; }); return JSON.stringify(h.rec.spans); };
    expect(once()).toBe(once());
  });
});

describe('parameters and definitions', () => {
  it('compiles a pose that mixes numbers, expressions, and definitions, and takes an enum as plain text', () => {
    const src = tree({ ref: 'test.pose', params: { at: { x: 'base + 1', z: -0.5, headingDeg: "if(side == 'rear', 90, -90)" }, mode: 'all' } }, { defs: { base: '0.25 * 2' } });
    expect(harness(src).run().status).toEqual({ state: 'success', value: { x: 1.5, z: -0.5, headingDeg: 90, mode: 'all' } });
  });
  it('evaluates parameters when the leaf starts', () => {
    const h = harness(tree({ repeat: { times: 2, child: { ref: 'test.wait', params: { name: 'w', steps: 'count' } } } }));
    h.env.count = 2;
    const { steps } = h.run(200, k => { if (k === 1) h.env.count = 0; });
    // The first activation starts with count 2 and keeps waiting 2 steps after count changes. The second starts with
    // count 0 and doesn't wait, so the tree ends in step 3.
    expect(steps).toBe(3);
    expect(events).toEqual(['w:start', 'w:done', 'w:start', 'w:done']);
  });
  it('lets a definition read earlier definitions, but not later ones', () => {
    expect(issues(tree({ condition: 'b > 0' }, { defs: { a: '1', b: 'a + 1' } }))).toEqual([]);
    expect(issues(tree({ condition: 'true' }, { defs: { a: 'b + 1', b: '1' } }))[0]).toMatch(/defs\.a: unknown name 'b'/);
    expect(issues(tree({ condition: 'true' }, { defs: { flag: '1' } }))[0]).toMatch(/already the name of a field/);
  });
});

describe('loading', () => {
  it('reports every problem, with its path', () => {
    const found = issues(tree({ sequence: { children: [
      { ref: 'test.nope' }, { ref: 'test.wait', params: { steps: -1, speed: 2 } }, { ref: 'test.emit' },
      { ref: 'test.pose', params: { at: { x: 1, z: 'side + 1' } } }, { dance: {} }, { id: 'x', condition: 'flag' }, { id: 'x', condition: 'bogus' },
    ] } }));
    expect(found).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknown leaf type 'test.nope'/),
      expect.stringMatching(/test.wait has no parameter 'speed'/),
      expect.stringMatching(/params.steps: must be at least 0/),
      expect.stringMatching(/test.emit needs the parameter 'value'/),
      expect.stringMatching(/'headingDeg' is required/),
      expect.stringMatching(/params.at.z: .*needs numbers/),
      expect.stringMatching(/a node needs one of these fields/),
      expect.stringMatching(/two children have the id 'x'/),
      expect.stringMatching(/root\/x\.condition: unknown name 'bogus'/),
    ]));
  });
  it('reports a leaf type whose default has the wrong type', () => {
    const broken = defineLeaf<Env>()({ id: 'test.broken', version: 1, doc: 'A wrong default.', params: { n: { type: t.number(), default: 'three' as unknown as number } }, *run() { return 1; } });
    expect(() => loadTree(tree({ ref: 'test.broken' }), { ...REG, leaves: { ...REG.leaves, [broken.id]: broken } })).toThrow(/test.broken is defined wrongly: the default of 'n' must be a number/);
  });
  it("rejects a leaf that needs something the tree's environment doesn't have", () => {
    expect(issues(tree({ ref: 'test.camera' }, { env: 'bare' }))[0]).toMatch(/needs 'camera', which the bare environment doesn't have/);
    expect(issues(tree({ ref: 'test.camera' }))).toEqual([]);
  });
  it('enforces the size limits', () => {
    const deep = (n: number): unknown => (n === 0 ? W('a') : { sequence: { children: [deep(n - 1)] } });
    expect(issues(tree(deep(45))).some(i => /nest at most 40 deep/.test(i))).toBe(true);
    expect(() => loadTree(tree({ sequence: { children: Array.from({ length: 30 }, () => W('a')) } }), REG, { maxNodes: 10 })).toThrow(/at most 10 nodes/);
    // The root is node 1, so child 9 is node 11. Past the limit, the loader stops: the bad leaf after it isn't reported.
    const big = tree({ sequence: { children: [...Array.from({ length: 30 }, () => W('a')), { ref: 'test.nope' }] } });
    expect(() => loadTree(big, REG, { maxNodes: 10 })).toThrow(/^root\/9: a tree can have at most 10 nodes$/);
  });
  it('rejects a file that isn\'t a tree', () => {
    expect(issues({ kind: 'bt.tree', name: 'x', env: 'nowhere', root: W('a') })[0]).toMatch(/'env' must be one of "full", "bare"/);
    expect(issues({ ...tree(W('a')), extra: 1 })[0]).toMatch(/unknown field 'extra'/);
  });
});

describe('trace', () => {
  it('records nested spans with their results, and puts a leaf\'s log events on its own span', () => {
    const h = harness(tree({ fallback: { children: [{ ref: 'test.fail', params: { tag: 'Stalled' } }, { ref: 'test.log' }] } }));
    h.run();
    const [root, failed, logged] = h.rec.spans;
    expect(root).toMatchObject({ kind: 'fallback', parent: null, result: 'success', path: 'root' });
    expect(failed).toMatchObject({ label: 'test.fail', parent: root.id, result: 'failure', tag: 'Stalled', path: 'root/0.test.fail' });
    expect(logged).toMatchObject({ label: 'test.log', parent: root.id, result: 'success', output: 1 });
    expect(logged.events).toEqual([{ t: 0, event: 'hello', data: { n: 1 } }]);
    expect(h.rec.activeAt(0).map(s => s.label)).toEqual(['fallback', 'test.fail', 'test.log']);
    expect(h.rec.activeAt(DT).map(s => s.label)).toEqual(['fallback', 'test.log']);
  });
  it('uses node ids in paths', () => {
    const h = harness(tree({ id: 'top', sequence: { children: [{ id: 'first', ...W('a') }] } }));
    h.run();
    expect(h.rec.spans.map(s => s.path)).toEqual(['root', 'root/first']);
  });
});
