import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUTO_TREES, previewAuto } from '../src/auto/onboard';
import { Sim } from '../src/sim/world';
import { defaultBot, robotConfig, sanitize } from '../src/setup';

beforeAll(async () => { await RAPIER.init(); });

/** A practice sim whose red robot 0 has a square chassis of `sizeIn` inches and a shooter facing `facing`. */
function simWith(sizeIn: number, facing: 'front' | 'rear' = 'rear') {
  const bot = sanitize({ ...defaultBot(0), sizeIn }, 0);
  return new Sim(RAPIER, undefined, 'full', 3, { configFor: () => { const c = robotConfig(bot); c.shooter.facing = facing; return c; } });
}

describe('AUTO trees', () => {
  it('loads all eight trees, in the order of the AUTO list', () => {
    expect(Object.keys(AUTO_TREES)).toEqual(['right_harvest', 'left_harvest', 'right_cycle', 'left_cycle_no_park', 'left_cycle', 'cycle_and_park', 'cycle_no_park', 'leave_only']);
    for (const def of Object.values(AUTO_TREES)) expect(def.env).toBe('onboard');
  });
  it('computes poses from the robot size and the shooter direction', () => {
    const plan = (sizeIn: number, facing: 'front' | 'rear' = 'rear') => { const s = simWith(sizeIn, facing), p = s.robot.translation(); return previewAuto(AUTO_TREES.cycle_and_park, s, { x: p.x, z: p.z }).poses; };
    const small = plan(12), big = plan(18), front = plan(18, 'front');
    // The PARK pose keeps the chassis 9 cm off the alliance wall: half the length farther out for a smaller robot.
    const park = (poses: typeof small) => poses[poses.length - 1];
    expect(park(small).x - park(big).x).toBeCloseTo(-((18 - 12) * 0.0254) / 2, 6);
    // A front-facing shooter turns every launch pose around. The first pose is the audience launch spot.
    expect(Math.abs(Math.abs(front[0].heading - big[0].heading) - Math.PI)).toBeLessThan(1e-9);
    expect(small[0].shoots).toBe(true);
  });
});
