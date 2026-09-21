// Summarizes experiments/results.jsonl: the mean and the standard error per configuration, over every seed run so far.
// Rows with a tag replace untagged rows of the same id, because a tag marks a rerun after a fix.
// Run: npx tsx scripts/exp-report.ts [group]
import fs from 'node:fs';
import { SPECS } from './exp-specs';
type Row = Record<string, number | string>;
const all: Row[] = fs.readFileSync('experiments/results.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1), se = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2)) / Math.max(1, v.length - 1)); };
for (const group of [...new Set(Object.values(SPECS).map(s => s.group))].filter(g => !process.argv[2] || g === process.argv[2])) {
  console.log(`\n### ${group}\n\n| Configuration | Matches | Red score | ± SE | Red + blue | Margin | ± SE | Red TIPS | FLOWER pts | AUTO pts | Stalls | Wins |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const [id, spec] of Object.entries(SPECS)) { if (spec.group !== group) continue;
    let rows = all.filter(r => r.id === id); const tags = [...new Set(rows.map(r => r.tag || ''))].filter(Boolean); if (tags.length) rows = rows.filter(r => r.tag === tags[tags.length - 1]);
    const n = (k: string) => rows.map(r => Number(r[k])); if (!rows.length) continue;
    console.log(`| ${spec.label} | ${rows.length} | ${mean(n('red')).toFixed(0)} | ${se(n('red')).toFixed(0)} | ${(mean(n('red')) + mean(n('blue'))).toFixed(0)} | ${mean(n('margin')).toFixed(0)} | ${se(n('margin')).toFixed(0)} | ${mean(n('redTips')).toFixed(1)} | ${mean(n('redFlowerPts')).toFixed(0)} | ${mean(n('redAuto')).toFixed(0)} | ${mean(n('stalls')).toFixed(0)} | ${n('margin').filter(m => m > 0).length}/${rows.length} |`); }
}
