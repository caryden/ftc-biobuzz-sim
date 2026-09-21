// Runs the planner on a fixed seed set and prints the mean score, its standard error, and the waste account.
// Both alliances run the same planner, so the combined score is the measure, and all four robots are samples.
// Run: npx tsx scripts/eval.ts [label] [seeds=24] [parallel=12]. Results append to experiments/policy-loop.jsonl.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [label = 'run', seedsArg = '24', parArg = '12'] = process.argv.slice(2), seeds = Array.from({ length: Number(seedsArg) }, (_, k) => 1001 + 37 * k);
interface Row { seed: number; red: number; blue: number; redTips: number; blueTips: number; auto: { red: number; blue: number } | null; park: number; stalls: number[]; launched: number[]; waste: Record<string, number>[] }
const rows: Row[] = []; let next = 0;
await new Promise<void>(done => { let live = 0; const launch = () => {
  if (next >= seeds.length) { if (live === 0) done(); return; } const seed = seeds[next++]; live++;
  const child = spawn('npx', ['tsx', 'scripts/eval-worker.ts', String(seed)], { stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; child.stdout.on('data', d => { out += d; });
  child.on('close', () => { live--; try { rows.push(JSON.parse(out.trim().split('\n').pop()!)); } catch { console.error(`seed ${seed}: no result`); } launch(); }); };
  for (let i = 0; i < Number(parArg); i++) launch(); });
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1), se = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + (b - mean(v)) ** 2, 0) / Math.max(1, v.length - 1) / (v.length || 1));
const combined = rows.map(q => q.red + q.blue), keys = Object.keys(rows[0]?.waste[0] ?? {});
const waste = Object.fromEntries(keys.map(k => [k, +mean(rows.flatMap(q => q.waste.map(w => w[k]))).toFixed(1)]));
const margin = rows.map(q => q.red - q.blue), foulPts = (a: 'red' | 'blue') => +mean(rows.map(q => (q as unknown as { fouls?: Record<string, number> }).fouls?.[a] ?? 0)).toFixed(1);
const summary = { label, n: rows.length, combined: +mean(combined).toFixed(1), se: +se(combined).toFixed(1), red: +mean(rows.map(q => q.red)).toFixed(1), blue: +mean(rows.map(q => q.blue)).toFixed(1), margin: +mean(margin).toFixed(1), marginSe: +se(margin).toFixed(1), foulPointsTo: { red: foulPts('red'), blue: foulPts('blue') }, tips: +mean(rows.map(q => q.redTips + q.blueTips)).toFixed(1), auto: +mean(rows.map(q => (q.auto?.red ?? 0) + (q.auto?.blue ?? 0))).toFixed(1),
  park: +mean(rows.map(q => q.park)).toFixed(1), stallsPerRobot: +mean(rows.flatMap(q => q.stalls)).toFixed(1), launchedPerRobot: +mean(rows.flatMap(q => q.launched)).toFixed(1), wasteSecPerRobot: waste };
fs.appendFileSync('experiments/policy-loop.jsonl', JSON.stringify({ at: new Date().toISOString(), ...summary, perSeed: rows.sort((a, b) => a.seed - b.seed).map(q => q.red + q.blue), perSeedRed: rows.map(q => q.red), perSeedBlue: rows.map(q => q.blue) }) + '\n');
console.log(JSON.stringify(summary, null, 1));
