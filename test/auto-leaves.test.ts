import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUTO_REGISTRY, AutoProgram, alliancePose } from '../src/auto/onboard';
import { loadTree } from '../src/bt';
import { DT, NO_INPUT, Sim, type Inputs } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });

const tree = (root: unknown) => loadTree({ kind: 'bt.tree', id: 'test-tree', name: 'Test', env: 'onboard', root }, AUTO_REGISTRY);
/** Runs a tree for red robot 0 for `sec` seconds, with the other robots still, and calls `each` after each step. */
function run(root: unknown, sec: number, each: (sim: Sim, inputs: Inputs) => void = () => {}) {
  const sim = new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true }); sim.start();
  const program = new AutoProgram(tree(root));
  for (let k = 0; k < sec / DT; k++) {
    const inputs = program.update(sim.view(0), DT);
    sim.step(sim.robots.map((_, i) => (i === 0 ? inputs : NO_INPUT)), sim.robots.map(() => true)); each(sim.view(0), inputs);
  }
  return sim.view(0);
}
const intake = (filter: string) => ({ ref: 'auto.intake', params: { filter } });

describe('auto.intake', () => {
  it('holds its filter across steps, and an ensure cleanup turns it off when a race stops the child', () => {
    const seen: (string | undefined)[] = [];
    // The clock race stops the scope after 0.5 s, in the middle of its 3 s wait.
    run({ sequence: { children: [
      { parallel: { policy: 'any', children: [
        { ref: 'auto.wait', params: { timeoutSec: 0.5 } },
        { ensure: { child: { sequence: { children: [intake('pollen'), { ref: 'auto.wait', params: { timeoutSec: 3 } }] } }, cleanup: intake('none') } },
      ] } },
      { ref: 'auto.wait', params: { timeoutSec: 1 } },
    ] } }, 1.2, (_, inp) => seen.push(inp.intake));
    expect(seen.slice(0, 100).every(f => f === 'pollen')).toBe(true);
    expect(seen.slice(130).every(f => f === 'none')).toBe(true);
  });
  it('starts AUTO with the intake off', () => {
    const seen: (string | undefined)[] = [];
    run({ ref: 'auto.wait', params: { timeoutSec: 1 } }, 0.2, (_, inp) => seen.push(inp.intake));
    expect(new Set(seen)).toEqual(new Set(['none']));
  });
});

describe('auto.followPath', () => {
  it('drives through its waypoints without stopping and ends at the last one', () => {
    // Red robot 0 starts on the red alliance wall. Two waypoints on one line toward the audience side, clear of the
    // FLOWER on the wall and of the HIVE: with no planner, a path into the HIVE's foot bar stops there.
    const start = alliancePose(new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true }).view(0).robot.translation(), 0, false);
    const a = { x: start.x + 0.3, y: start.y - 0.4, headingDeg: null }, b = { x: start.x + 0.6, y: start.y - 0.8, headingDeg: null };
    let nearA = Infinity, speedAtA = 0;
    const end = run({ ref: 'auto.followPath', params: { waypoints: [a, b], timeoutSec: 4 } }, 3, sim => {
      const p = alliancePose(sim.robot.translation(), sim.heading, false), d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d < nearA) { nearA = d; speedAtA = sim.telemetry.speed; }
    });
    const p = alliancePose(end.robot.translation(), end.heading, false);
    expect(Math.hypot(p.x - b.x, p.y - b.y)).toBeLessThan(0.06);
    // It passes the first waypoint at speed, where a drive to each point would stop.
    expect(nearA).toBeLessThan(0.1); expect(speedAtA).toBeGreaterThan(0.5);
  });
});

describe('auto.waitHopperFull', () => {
  it('ends a race in the step that the hopper fills', () => {
    // A robot that starts with a full hopper: the race ends before the drive starts.
    let moved = 0;
    run({ sequence: { children: [
      { parallel: { policy: 'any', children: [{ ref: 'auto.waitHopperFull' }, { ref: 'auto.driveTo', params: { pose: 'pose(0, 0, 0)', timeoutSec: 3 } }] } },
      { ref: 'auto.wait', params: { timeoutSec: 3 } },
    ] } }, 0.5, (_, inp) => { if (inp.forward || inp.strafeRight) moved++; });
    expect(moved).toBe(0);
  });
});
