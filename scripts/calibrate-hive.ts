// Sweeps the hive center-of-mass height (the ballast-washer equivalent) and
// prints which values pass all six rows of the calibration standard.
// Run: npx vitest run --config scripts/calibrate.vitest.config.ts
import RAPIER from '@dimforge/rapier3d-compat';
import { it } from 'vitest';
import { runRow } from '../test/hive-calibration.test';

it('sweep', async () => {
  await RAPIER.init();
  const N = 'nectar' as const, P = 'pollen' as const;
  const rows: [('pollen' | 'nectar')[], 'pollen', boolean, boolean][] = [
    [[N, N, N, P], P, true, false], [[N, N, N, P, P], P, false, true], [[N, N, N, P, P], P, true, true],
    [Array(6).fill(P), P, true, false], [Array(7).fill(P), P, false, true], [Array(7).fill(P), P, true, true],
  ];
  for (let h = 0.036; h <= 0.0701; h += 0.002) {
    const res = rows.map(([a, b, c, want]) => runRow(a, b, c, h) === want);
    console.log(h.toFixed(3), res.map(v => (v ? 'ok ' : 'BAD')).join(' '), res.every(Boolean) ? '<== passes' : '');
  }
}, 600000);
