// Summarizes a saved match trace for analysis: coordination metrics for every robot, and what each robot was doing in
// the seconds around every annotation. Run: npx tsx scripts/trace-report.ts [traces/<name>.json]  (default: the newest)
import fs from 'node:fs';
import type { Note, Trace } from '../src/trace';

const dir = 'traces', arg = process.argv[2];
const file = arg ?? `${dir}/${fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('annotations')).sort().pop()}`;
const trace: Trace = JSON.parse(fs.readFileSync(file, 'utf8')), notesFile = file.replace(/\.json$/, '.annotations.json');
const notes: Note[] = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes : [];
const F = trace.frames, ids = F[0].robots.map(r => r.id), last = F[F.length - 1];
console.log(`# ${trace.name}: ${F.length} frames, ${last.t.toFixed(0)} s, final ${last.score.red} to ${last.score.blue}, TIPS red ${last.hives.red.tips} blue ${last.hives.blue.tips}`);
console.log(`settings: ${JSON.stringify(trace.settings)}\n`);

console.log('## Per robot, TELEOP only\n');
console.log('| Robot | Idle s | Goal changes | Abandoned goals | Stall frames | Meters | Pickups | Side crossings | Own-half % |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const tele = F.filter(f => f.phase === 'teleop');
ids.forEach((id, i) => {
  let idle = 0, changes = 0, abandoned = 0, stall = 0, meters = 0, picks = 0, cross = 0, own = 0, goal = '', goalCarried = 0;
  tele.forEach((f, k) => { const r = f.robots[i], p = tele[k - 1]?.robots[i]; if (r.speed < 0.05) idle += 0.1; if (r.stall) stall++;
    if (p) { meters += Math.hypot(r.x - p.x, r.z - p.z); if (r.carried.length > p.carried.length) picks += r.carried.length - p.carried.length; if (Math.sign(r.z) !== Math.sign(p.z) && Math.abs(r.x) > 0.7) cross++; }
    if ((id[0] === 'R') === r.x < 0) own++;
    if (r.goalKey && r.goalKey !== goal) { changes++; if (goal && r.carried.length === goalCarried) abandoned++; goal = r.goalKey; goalCarried = r.carried.length; } });
  console.log(`| ${id} | ${idle.toFixed(0)} | ${changes} | ${abandoned} | ${stall} | ${meters.toFixed(0)} | ${picks} | ${cross} | ${Math.round((100 * own) / Math.max(1, tele.length))} |`);
});

console.log('\n## Robot pairs: seconds closer than 0.55 m, center to center\n');
for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
  const close = F.filter(f => Math.hypot(f.robots[a].x - f.robots[b].x, f.robots[a].z - f.robots[b].z) < 0.55); if (close.length < 5) continue;
  // The longest single contact tells a wedge from a brush.
  let run = 0, best = 0, bestAt = 0; F.forEach(f => { const c = Math.hypot(f.robots[a].x - f.robots[b].x, f.robots[a].z - f.robots[b].z) < 0.55; run = c ? run + 1 : 0; if (run > best) { best = run; bestAt = f.t; } });
  console.log(`- ${ids[a]} and ${ids[b]}: ${(close.length / 10).toFixed(1)} s in total, longest ${(best / 10).toFixed(1)} s ending at t=${bestAt.toFixed(1)}`);
}

console.log('\n## TIP times (match seconds) and the gap before each\n');
for (const a of ['red', 'blue'] as const) { const times: number[] = []; F.forEach((f, k) => { if (k && f.hives[a].tips > F[k - 1].hives[a].tips) times.push(f.t); });
  console.log(`- ${a}: ${times.map((t, k) => `${t.toFixed(0)}${k ? ` (+${(t - times[k - 1]).toFixed(0)})` : ''}`).join(', ')}`); }

for (const n of notes) {
  console.log(`\n## Annotation at t=${n.t.toFixed(1)} s (${n.phase}, clock ${n.clock.toFixed(0)})${n.robot ? `, ${n.robot}` : ''}: ${n.text || '(no text)'}\n`);
  for (const f of F.filter(q => q.t >= n.t - 4 && q.t <= n.t + 3 && Math.abs((q.t * 10) % 10) < 0.5)) {
    console.log(`t=${f.t.toFixed(0)} hive red ${f.hives.red.up}/${f.hives.red.load} blue ${f.hives.blue.up}/${f.hives.blue.load}`);
    for (const r of f.robots) if (!n.robot || r.id === n.robot || r.id[0] === n.robot[0]) console.log(`   ${r.id} (${r.x},${r.z}) h${Math.round((r.h * 180) / Math.PI)} v${r.speed} [${r.carried.join('')}] ${r.tactic} ${r.status} -> ${r.goalKey}${r.goal ? `(${r.goal})` : ''} ${r.note}${r.stall ? ` STALL ${r.stall}` : ''}`);
  }
}
