import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { TELEOP_TREES } from '../src/auto/driver';
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
    expect(Object.keys(AUTO_TREES)).toEqual(['wall-sweep-pair-right', 'wall-sweep-pair-left', 'lane-sweep-pair-right', 'lane-sweep-pair-left-no-park', 'lane-sweep-pair-left', 'solo-two-tip-sweep', 'solo-two-tip-sweep-no-park', 'leave-and-park']);
    // Each half of a pair names the other half as its partner.
    for (const def of Object.values(AUTO_TREES)) if (typeof def.meta.partner === 'string') expect(AUTO_TREES[def.meta.partner]?.meta.start).not.toBe(def.meta.start);
    for (const def of Object.values(AUTO_TREES)) expect(def.env).toBe('onboard');
  });
  it('computes poses from the robot size and the shooter direction', () => {
    const plan = (sizeIn: number, facing: 'front' | 'rear' = 'rear') => { const s = simWith(sizeIn, facing), p = s.robot.translation(); return previewAuto(AUTO_TREES['solo-two-tip-sweep'], s, { x: p.x, z: p.z }).poses; };
    const small = plan(12), big = plan(18), front = plan(18, 'front');
    // The PARK pose keeps the chassis 9 cm off the alliance wall: half the length farther out for a smaller robot.
    const park = (poses: typeof small) => poses[poses.length - 1];
    expect(park(small).x - park(big).x).toBeCloseTo(-((18 - 12) * 0.0254) / 2, 6);
    // A front-facing shooter turns every launch pose around. The first pose is the audience launch spot.
    expect(Math.abs(Math.abs(front[0].heading - big[0].heading) - Math.PI)).toBeLessThan(1e-9);
    expect(small[0].shoots).toBe(true);
  });
});

describe('TELEOP tree', () => {
  it('loads the default tree in the driver environment, with its guards in priority order', () => {
    const def = TELEOP_TREES['teleop-default'];
    expect(def.env).toBe('driver');
    const nodes: { kind: string; path: string }[] = [], walk = (n: typeof def.root) => { nodes.push(n); n.children.forEach(walk); }; walk(def.root);
    expect(nodes.filter(n => n.kind === 'guard').map(n => n.path)).toEqual(['root/defend', 'root/match/endgame', 'root/match/endgame/child/last-launch', 'root/match/play/child/flowers', 'root/match/play/child/tip', 'root/match/play/child/launch']);
    expect(nodes.some(n => n.path === 'root/match/endgame/child/park-now')).toBe(true);
    expect(nodes.some(n => n.path === 'root/match/play/child/park')).toBe(true);
  });
});

describe('tree files', () => {
  it('names each file after its tree id, which the catalog and the saved setups use', () => {
    const files = import.meta.glob<{ id: string }>('../src/auto/trees/*.json', { eager: true, import: 'default' });
    expect(Object.keys(files)).toHaveLength(9);
    for (const [path, tree] of Object.entries(files)) expect(tree.id).toBe(path.split('/').pop()!.replace(/\.json$/, ''));
  });
});
