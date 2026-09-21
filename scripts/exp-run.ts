// Runs every spec of a group over several seeds, in parallel worker processes, and prints a summary table.
// Results append to experiments/results.jsonl. A group can also be a comma-separated list of spec ids.
// Run: npx tsx scripts/exp-run.ts <group|all|id,id> [seeds=8] [parallel=8] [firstSeed=101] [tag]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { SPECS } from './exp-specs';

const [group = 'all', seedsArg = '8', parArg = '8', firstSeed = '101', tag = ''] = process.argv.slice(2), seeds = Number(seedsArg), parallel = Number(parArg);
const ids = Object.keys(SPECS).filter(id => group === 'all' || SPECS[id].group === group || group.split(',').includes(id));
// A tagged run resumes: a match that results.jsonl already has under this tag isn't run again, and it still counts in the summary.
const had: Record<string, number | string>[] = tag && fs.existsSync('experiments/results.jsonl') ? fs.readFileSync('experiments/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.tag === tag && ids.includes(r.id)) : [];
const jobs = ids.flatMap(id => Array.from({ length: seeds }, (_, k) => ({ id, seed: Number(firstSeed) + 13 * k }))).filter(j => !had.some(r => r.id === j.id && r.seed === j.seed)); const rows: Record<string, number | string>[] = [...had]; let next = 0, done = 0;
const t0 = Date.now();
await new Promise<void>(resolve => {
  const launch = () => {
    if (next >= jobs.length) { if (done === jobs.length) resolve(); return; }
    const job = jobs[next++], child = spawn('npx', ['tsx', 'scripts/exp-worker.ts', job.id, String(job.seed)], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', () => { done++; const line = out.trim().split('\n').pop() ?? ''; try { const row = { ...JSON.parse(line), tag }; rows.push(row); fs.appendFileSync('experiments/results.jsonl', JSON.stringify(row) + '\n'); } catch { console.error(`FAILED ${job.id} seed ${job.seed}: ${err.slice(-300)}`); }
      if (done % 10 === 0) console.error(`${done}/${jobs.length} matches, ${Math.round((Date.now() - t0) / 1000)} s`); launch(); });
  };
  for (let i = 0; i < parallel; i++) launch();
});
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1), sd = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
const num = (id: string, k: string) => rows.filter(r => r.id === id).map(r => Number(r[k]));
console.log(`\n${group}: ${seeds} seeds per row, ${Math.round((Date.now() - t0) / 1000)} s\n`);
console.log('| Configuration | Red | ± | Blue | Margin | ± | Red TIPS | FLOWER pts | AUTO pts | Hopper after AUTO | Stalls | RP | Wins |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const id of ids) { const f = (k: string, d = 1) => mean(num(id, k)).toFixed(d);
  console.log(`| ${SPECS[id].label} | ${f('red')} | ${sd(num(id, 'red')).toFixed(0)} | ${f('blue')} | ${f('margin')} | ${(sd(num(id, 'margin')) / Math.sqrt(seeds)).toFixed(0)} | ${f('redTips')} | ${f('redFlowerPts')} | ${f('redAuto')} | ${f('redHopperAfterAuto')} | ${f('stalls')} | ${f('rp')} | ${num(id, 'margin').filter(m => m > 0).length}/${num(id, 'red').length} |`); }
