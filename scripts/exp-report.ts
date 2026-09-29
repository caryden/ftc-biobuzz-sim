// Summarizes experiments/results.jsonl: the mean and the standard error per configuration, over every seed run so far.
// Rows with a tag replace untagged rows of the same id, because a tag marks a rerun after a fix.
// The change is paired: each match is set against the baseline's match on the same seed, and seeds that the baseline
// lacks are left out. For the `follow` and `path` groups, whose settings apply to all four robots, the change is in the
// combined red plus blue score, against `path-base`. For every other group, it is in red's score, against `shoot-dual`.
// Run: npx tsx scripts/exp-report.ts [group]
import fs from 'node:fs';
import { SPECS } from './exp-specs';
type Row = Record<string, number | string>;
const all: Row[] = fs.readFileSync('experiments/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1), se = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2)) / Math.max(1, v.length - 1)); };
const latest = (id: string) => { const rows = all.filter(r => r.id === id), tags = [...new Set(rows.map(r => r.tag || ''))].filter(Boolean); return tags.length ? rows.filter(r => r.tag === tags[tags.length - 1]) : rows; };
const GLOBAL = new Set(['follow', 'path']);
for (const group of [...new Set(Object.values(SPECS).map(s => s.group))].filter(g => !process.argv[2] || g === process.argv[2])) {
  const global = GLOBAL.has(group), score = (r: Row) => Number(r.red) + (global ? Number(r.blue) : 0), base = new Map(latest(global ? 'path-base' : 'shoot-dual').map(r => [Number(r.seed), score(r)]));
  console.log(`\n### ${group}\n${global ? '\nThese settings apply to all four robots, so the change is in the combined score.\n' : ''}\n| Configuration | Matches | Red score | ± SE | Change | ± SE, paired | Red + blue | Margin | ± SE | Red TIPS | FLOWER pts | AUTO pts | Stalls | Wins |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const [id, spec] of Object.entries(SPECS)) { if (spec.group !== group) continue;
    const rows = latest(id), n = (k: string) => rows.map(r => Number(r[k])); if (!rows.length) continue;
    const d = rows.filter(r => base.has(Number(r.seed))).map(r => score(r) - base.get(Number(r.seed))!), change = d.length > 1 ? `${mean(d) >= 0 ? '+' : ''}${mean(d).toFixed(1)} | ${se(d).toFixed(1)}` : '| ';
    console.log(`| ${spec.label} | ${rows.length} | ${mean(n('red')).toFixed(0)} | ${se(n('red')).toFixed(0)} | ${change} | ${(mean(n('red')) + mean(n('blue'))).toFixed(0)} | ${mean(n('margin')).toFixed(0)} | ${se(n('margin')).toFixed(0)} | ${mean(n('redTips')).toFixed(1)} | ${mean(n('redFlowerPts')).toFixed(0)} | ${mean(n('redAuto')).toFixed(0)} | ${mean(n('stalls')).toFixed(0)} | ${n('margin').filter(m => m > 0).length}/${rows.length} |`); }
}
