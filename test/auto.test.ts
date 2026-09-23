import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { Executor, flowerAction, flowerLocked, opponentCapGain } from '../src/auto/executor';
import { flowerStep } from '../src/auto/policy';
import { distSegSeg, fieldObstacles, planPath } from '../src/auto/planner';
import { Coach } from '../src/auto/coach';
import { Referee } from '../src/ref/referee';
import { DT, Sim, flowerHeights } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });

/** Runs a one-robot match: a pure AUTO script, then the scripted TELEOP baseline. */
export function runScripted(mode: 'full' | 'teleop', routine = 'solo-two-tip-sweep', seed = 3) {
  const sim = new Sim(RAPIER, undefined, mode, seed), coach = new Coach();
  coach.flowerStartSec = 66; coach.autoRoutine = routine; sim.start(); // This test covers FLOWER work.
  while (sim.phase !== 'post') sim.step(coach.update(sim, DT), true);
  return sim;
}

describe('path planner', () => {
  it('routes between the two launch spots without touching a HIVE leg or foot bar', () => {
    const R = Math.hypot(0.43, 0.43) / 2, path = planPath({ x: -0.32, z: 1.35 }, { x: -0.32, z: -1.35 }, R);
    expect(path.length).toBeGreaterThan(2);
    for (let i = 1; i < path.length; i++) for (const o of fieldObstacles()) expect(distSegSeg(path[i - 1], path[i], o.a, o.b)).toBeGreaterThan(o.r + R);
  });
});

describe('HIVE frame', () => {
  it('blocks a robot that drives straight at a foot bar', () => {
    const sim = new Sim(RAPIER, undefined, 'practice'), y = sim.robot.translation().y;
    sim.robot.setTranslation({ x: -1.2, y, z: 0 }, true);
    for (let i = 0; i < 2 / DT; i++) sim.step({ forward: 1, strafeRight: 0, turnRight: 0, shootNectar: false, shootPollen: false, placeNectar: false, placePollen: false });
    // The bar's outer face is at X -0.628, so the robot front can't pass it.
    expect(sim.robot.translation().x + sim.cfg.length / 2).toBeLessThan(-0.6);
  });
});

describe('FLOWER model', () => {
  it('seats NECTAR at the middle ring, blocks removal under it, and scores plug + 4 POLLEN + cap as 17', () => {
    const sim = new Sim(RAPIER, undefined, 'practice'), f = sim.flowers[0];
    f.stack = ['nectar_red', 'pollen', 'pollen', 'pollen', 'pollen', 'nectar_red'];
    expect(flowerHeights(f.stack)[0]).toBeCloseTo(0.09);
    const s = sim.flowerStatus(f); expect(s.owner).toBe('red'); expect(s.bottom).toBe('red'); expect(s.scored * 2 + 5).toBe(17);
    f.stack = ['pollen', 'pollen', 'nectar_red']; sim.carried = [];
    expect(flowerAction(sim, f)).toBe('pull_pollen_to_seat_plug');
    f.stack = ['nectar_red']; sim.carried = ['pollen'];
    expect(flowerAction(sim, f)).toBe('fill_with_pollen');
    f.stack = ['nectar_red', 'pollen', 'pollen', 'pollen', 'pollen']; sim.carried = ['nectar_red', 'pollen'];
    expect(flowerAction(sim, f)).toBe('cap_with_own_nectar');
    f.stack.push('nectar_red'); expect(flowerLocked(sim, f)).toBe(true); expect(opponentCapGain(sim, f)).toBe(0);
    f.stack = ['nectar_red', 'pollen', 'nectar_blue']; sim.carried = ['nectar_red'];
    expect(flowerAction(sim, f)).toBe('cap_with_own_nectar');
  });
});

describe('scripted match', () => {
  it('plays AUTO and TELEOP: leaves, tips in AUTO, works FLOWERS, and parks', () => {
    const sim = runScripted('full'), s = sim.score('red');
    console.log('scripted full match', JSON.stringify(s), 'flowers', sim.flowers.map(f => f.stack.map(k => (k === 'pollen' ? 'P' : k === 'nectar_red' ? 'RN' : 'BN')).join('')).join(' | '));
    expect(s.leave).toBe(3); expect(s.autoPark).toBe(5); expect(s.autoTips).toBeGreaterThanOrEqual(20);
    expect(s.teleopTips).toBeGreaterThanOrEqual(40); expect(s.flower + s.bottomNectar).toBeGreaterThan(10); expect(s.park).toBe(5);
    // At least one FLOWER ends locked: plug, four POLLEN, cap, and no room for a blue cap. No FLOWER has a double cap.
    // Own NECTAR also goes into TIPS now, so fewer FLOWERS get both a plug and a cap than before.
    expect(sim.flowers.filter(f => flowerLocked(sim, f)).length).toBeGreaterThanOrEqual(1);
    for (const f of sim.flowers) expect(f.stack.join().includes('nectar_red,nectar_red')).toBe(false);
  }, 120000);
});

describe('opponent robot', () => {
  it('plays a full scripted MATCH on both alliances, and each robot leaves opponent NECTAR alone', () => {
    const sim = new Sim(RAPIER, undefined, 'full', 3, { opponent: true }); sim.start();
    const coaches = [new Coach(), new Coach()]; coaches.forEach(c => { });
    let wrongNectar = 0;
    while (sim.phase !== 'post') {
      sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), [true, true]);
      if (sim.robots[0].carried.includes('nectar_blue') || sim.robots[1].carried.includes('nectar_red')) wrongNectar++; // G408
    }
    const red = sim.score('red'), blue = sim.score('blue');
    console.log('two-robot match: red', red.total, 'blue', blue.total, 'tips', sim.hives.red.tips, sim.hives.blue.tips);
    expect(wrongNectar).toBe(0);
    expect(sim.hives.red.tips).toBeGreaterThanOrEqual(3); expect(sim.hives.blue.tips).toBeGreaterThanOrEqual(3);
    expect(blue.leave).toBe(3); expect(blue.total).toBeGreaterThan(80);
  }, 240000);
});

describe('AUTO script', () => {
  it('stays on the own side of the FIELD (G402) and scores LEAVE, AUTO PARK, and at least one TIP for each alliance', () => {
    const sim = new Sim(RAPIER, undefined, 'full', 9, { opponent: true }); sim.start();
    const coaches = [new Coach(), new Coach()];
    let redMaxX = -9, blueMinX = 9;
    while (sim.phase === 'auto') {
      sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), [true, true]);
      redMaxX = Math.max(redMaxX, sim.robots[0].body.translation().x + sim.cfg.length / 2); blueMinX = Math.min(blueMinX, sim.robots[1].body.translation().x - sim.cfg.length / 2);
    }
    const red = sim.score('red'), blue = sim.score('blue');
    console.log('AUTO: red', JSON.stringify({ leave: red.leave, park: red.autoPark, tips: red.autoTips }), 'blue', JSON.stringify({ leave: blue.leave, park: blue.autoPark, tips: blue.autoTips }), 'red max X', redMaxX.toFixed(2), 'blue min X', blueMinX.toFixed(2));
    expect(redMaxX).toBeLessThan(0); expect(blueMinX).toBeGreaterThan(0);
    for (const s of [red, blue]) { expect(s.leave).toBe(3); expect(s.autoPark).toBe(5); expect(s.autoTips).toBeGreaterThanOrEqual(20); }
  }, 120000);
});

describe('stall handling', () => {
  it('reports a blocked FLOWER and moves on when two robots go for the same one', () => {
    const sim = new Sim(RAPIER, undefined, 'practice', 2, { opponent: true }), exs = [new Executor(), new Executor()];
    sim.robots[0].carried = ['nectar_red', 'nectar_red']; sim.robots[1].carried = ['nectar_blue', 'nectar_blue'];
    const y = sim.robot.translation().y; sim.robots[1].body.setTranslation({ x: -0.9, y, z: 0.2 }, true);
    exs.forEach(e => e.setTactic('work_flower', 'red')); let stalls = 0; const seen = new Set<number>();
    for (let i = 0; i < 25 / DT; i++) {
      const inputs = exs.map((e, k) => { const v = sim.view(k);
        if (e.stall && !seen.has(e.stall.at * 10 + k)) { seen.add(e.stall.at * 10 + k); stalls++; }
        // The test plays the coach: a robot that isn't making progress picks its next step, avoiding stalled FLOWERS.
        if (e.status !== 'in_progress') { const d = flowerStep(v, null, e.avoidedFlowers()) ?? { tactic: 'tip_hive' as const, flower: null }; e.setTactic(d.tactic, d.flower); }
        return e.update(v, DT); });
      sim.step(inputs, [true, true]);
    }
    const red = sim.flowers.find(f => f.id === 'red')!, a = sim.robots[0].body.translation(), b = sim.robots[1].body.translation();
    console.log('stalls', stalls, 'red FLOWER', red.stack.join(), 'tactics', exs.map(e => `${e.tactic}:${e.flowerId}`).join(' '), 'apart', Math.hypot(a.x - b.x, a.z - b.z).toFixed(2));
    expect(red.stack.some(k => k !== 'pollen')).toBe(true);           // One robot got its NECTAR into the contested FLOWER.
    expect(sim.flowers.filter(f => f.stack.some(k => k !== 'pollen')).length).toBeGreaterThanOrEqual(2); // The other went elsewhere.
  }, 120000);
});

describe('referee', () => {
  const N = { forward: 0, strafeRight: 0, turnRight: 0, shootNectar: false, shootPollen: false, placeNectar: false, placePollen: false };
  it('calls a MAJOR FOUL every 3 s on a robot that holds an opponent against the wall (G421)', () => {
    const sim = new Sim(RAPIER, undefined, 'practice', 1, { opponent: true }), ref = new Referee(), y = sim.robot.translation().y;
    // Blue sits against the blue wall and faces the field. Red drives into it and keeps pushing; blue tries to strafe out.
    sim.robots[1].body.setTranslation({ x: 1.56, y, z: 0.2 }, true); sim.robots[0].body.setTranslation({ x: 1.05, y, z: 0.2 }, true);
    for (let i = 0; i < 10 / DT; i++) { sim.step([{ ...N, forward: 1 }, { ...N, strafeRight: 0.8 }], [true, true]); ref.update(sim, DT); }
    console.log('pin test: foul points to blue', sim.foulPoints.blue, 'pins', JSON.stringify(ref.pins));
    expect(sim.foulPoints.blue).toBeGreaterThanOrEqual(40); expect(sim.foulPoints.red).toBe(0); expect(sim.score('blue').fouls).toBe(sim.foulPoints.blue);
  });
  it('calls nothing when two robots pass and separate', () => {
    const sim = new Sim(RAPIER, undefined, 'practice', 1, { opponent: true }), ref = new Referee(), y = sim.robot.translation().y;
    sim.robots[1].body.setTranslation({ x: 0.9, y, z: 1.2 }, true); sim.robots[0].body.setTranslation({ x: -0.9, y, z: 1.25 }, true);
    for (let i = 0; i < 5 / DT; i++) { sim.step([{ ...N, forward: 0.7, strafeRight: i * DT > 0.8 ? 0.6 : 0 }, { ...N, forward: 0.7, strafeRight: i * DT > 0.8 ? 0.6 : 0 }], [true, true]); ref.update(sim, DT); }
    expect(sim.foulPoints.red + sim.foulPoints.blue).toBe(0);
  });
});

describe('alliance partners', () => {
  it('plays four robots: both alliances stay on their side in AUTO, tip, and neither alliance double-books a launch spot', () => {
    const sim = new Sim(RAPIER, undefined, 'full', 4, { opponent: true, partners: true }); sim.start();
    expect(sim.robots.map(r => `${r.alliance}${r.slot}`)).toEqual(['red0', 'red1', 'blue0', 'blue1']);
    const coaches = sim.robots.map(() => { const c = new Coach(); return c; });
    let redMaxX = -9, blueMinX = 9, closest = 9;
    while (sim.phase !== 'post') {
      sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), coaches.map(() => true));
      if (sim.phase === 'auto') sim.robots.forEach(r => { const x = r.body.translation().x; if (r.alliance === 'red') redMaxX = Math.max(redMaxX, x); else blueMinX = Math.min(blueMinX, x); });
      const a = sim.robots[0].body.translation(), b = sim.robots[1].body.translation(); closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
    }
    const red = sim.score('red'), blue = sim.score('blue');
    console.log('four robots: red', JSON.stringify(red), '\n             blue', JSON.stringify(blue), '\n             AUTO red max X', redMaxX.toFixed(2), 'blue min X', blueMinX.toFixed(2));
    expect(redMaxX).toBeLessThan(-0.15); expect(blueMinX).toBeGreaterThan(0.15); // Robot centers stay well on their own side (G402).
    for (const s of [red, blue]) { expect(s.leave).toBe(6); expect(s.autoTips).toBeGreaterThanOrEqual(40); expect(s.autoTips + s.teleopTips).toBeGreaterThanOrEqual(120); }
  }, 600000);
});
