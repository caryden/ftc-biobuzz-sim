// Measures what the behavior-tree runtime costs per MATCH, without physics. Four robots each run a tree shaped like
// the TELEOP policy for 37,920 steps, which is a MATCH at 240 steps per second: a repeat over a fallback that
// rechecks five guards once per second, where each guard runs a timeout over a sequence of leaves.
// Run it with `npx tsx scripts/bt-bench.ts`.
import { defineLeaf, loadTree, Recorder, t, TreeRunner } from '../src/bt';

const DT = 1 / 240, STEPS = 37_920, ROBOTS = 4;
interface Env { tick: number; want: number }
const work = defineLeaf<Env>()({
  id: 'bench.work', version: 1, doc: 'Waits `steps` steps, reading the environment each step.',
  params: { steps: { type: t.number() } },
  *run(ctx) { let acc = 0; for (let i = 0; i < ctx.params.steps; i++) { acc += ctx.env.tick & 1; yield; } return acc; },
});
const reg = { envs: { bench: t.object({ tick: t.number(), want: t.number() }) }, leaves: { [work.id]: work } };
const branch = (k: number) => ({ guard: { when: `want == ${k}`, child: { timeout: { sec: 20, child: { sequence: { children: [
  { ref: 'bench.work', params: { steps: 300 + 50 * k } }, { ref: 'bench.work', params: { steps: 200 } }, { ref: 'bench.work', params: { steps: 'tick % 7 + 100' } },
] } } } } } });
const src = { kind: 'bt.tree', name: 'bench', env: 'bench', root: { repeat: { stopOn: 'never', child: { fallback: { recheckSec: 1, children: [0, 1, 2, 3, 4].map(branch) } } } } };
const def = loadTree(src, reg);

function match(record: boolean) {
  const envs = Array.from({ length: ROBOTS }, (_, r) => ({ tick: 0, want: r % 5 }));
  let time = 0; const recs: Recorder[] = [];
  const runners = envs.map(env => { const rec = record ? new Recorder() : undefined; if (rec) recs.push(rec); return new TreeRunner(def, { env, now: () => time, recorder: rec }); });
  for (let s = 0; s < STEPS; s++) {
    time = s * DT;
    for (let r = 0; r < ROBOTS; r++) { envs[r].tick = s; if (s % 2400 === 0) envs[r].want = (envs[r].want + 1) % 5; runners[r].step(); }
  }
  return recs.reduce((n, r) => n + r.spans.length, 0);
}

for (const record of [false, true]) {
  match(record); // Warm up.
  const times: number[] = []; let spans = 0;
  for (let i = 0; i < 7; i++) { const t0 = performance.now(); spans = match(record); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  console.log(`${record ? 'with a recorder' : 'no recorder    '}  median ${times[3].toFixed(1)} ms per match${record ? `, ${spans} spans` : ''}`);
}
