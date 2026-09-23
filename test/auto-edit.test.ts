import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { editHandles, editedCopy, findNode, isEdited, moveHandle, poseText, resetHandle, sharedWith, shiftPose, turnHandle } from '../src/auto/auto-edit';
import { AUTO_SOURCES, AUTO_TREES, BUILT_IN_AUTO, addAutoTree, removeAutoTree } from '../src/auto/onboard';
import { Coach } from '../src/auto/coach';
import { literalNumber, splitCall, type CNode } from '../src/bt';
import { DT, NO_INPUT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });

type Json = Record<string, unknown>;
const newSim = () => new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true });
const source = (id: string) => AUTO_SOURCES[id] as Json;
const leaves = (n: CNode, out: CNode[] = []) => { if (n.leaf) out.push(n); n.children.forEach(c => leaves(c, out)); return out; };

describe('expression helpers', () => {
  it('splits a call into its arguments as written', () => {
    expect(splitCall('offset(launch, 0.2, -(a + b))')).toEqual({ name: 'offset', args: ['launch', '0.2', '-(a + b)'] });
    expect(splitCall('pose(min(1, 2), y, 90)')).toEqual({ name: 'pose', args: ['min(1, 2)', 'y', '90'] });
    expect(splitCall('launch')).toBeNull(); expect(splitCall('a.b(1)')).toBeNull(); expect(splitCall('pose(1, 2')).toBeNull();
    expect(literalNumber('-0.25')).toBe(-0.25); expect(literalNumber('1 + 2')).toBeNull();
  });
});

describe('shiftPose', () => {
  it('edits the literals of a pose() call, and keeps the values that do not move', () => {
    expect(shiftPose('pose(-1.2, 0.6, 180)', 0.1, -0.2, 0)).toBe('pose(-1.1, 0.4, 180)');
    expect(shiftPose('pose(hiveX, 1.32, -90 + flip)', 0, 0.1, 0)).toBe('pose(hiveX, 1.42, -90 + flip)');
  });
  it('wraps an expression in offset() when a value that moves is not a literal', () => {
    expect(shiftPose('launchAudience', 0.2, -0.1, 0)).toBe('offset(launchAudience, 0.2, -0.1)');
    expect(shiftPose('pose(hiveX, 1.32, -90 + flip)', 0.1, 0, 0)).toBe('offset(pose(hiveX, 1.32, -90 + flip), 0.1, 0)');
    expect(shiftPose('launchAudience', 0, 0, 30)).toBe('offset(launchAudience, 0, 0, 30)');
  });
  it('edits an offset() that is already there, and removes it when it comes back to zero', () => {
    expect(shiftPose('offset(ownFlower, 0.2, 0)', 0.05, 0.1, 10)).toBe('offset(ownFlower, 0.25, 0.1, 10)');
    expect(shiftPose('offset(ownFlower, 0.2, 0)', -0.2, 0, 0)).toBe('ownFlower');
  });
});

describe('findNode', () => {
  it('finds the JSON of every leaf of every AUTO tree by its path', () => {
    let count = 0;
    for (const [id, def] of Object.entries(AUTO_TREES)) {
      for (const n of leaves(def.root)) { expect(findNode(source(id), n.path)?.ref, `${id} ${n.path}`).toBe(n.label); count++; }
    }
    expect(count).toBeGreaterThan(100);
  });
  it('returns null for a path that no node has', () => {
    expect(findNode(source('solo-two-tip-sweep'), 'root/steps/1.sequence/nope')).toBeNull();
    expect(findNode(source('solo-two-tip-sweep'), 'tree/steps')).toBeNull();
  });
});

describe('field edits', () => {
  it('writes poses in field x and y, with +y toward the rear wall', () => {
    // The audience launch spot is on the audience side, where y is negative, and the robot's rear faces the audience.
    const s1 = editHandles(AUTO_TREES['solo-two-tip-sweep'], newSim().view(0))[0];
    expect(s1.pose.y).toBeCloseTo(-1.32, 6); expect(s1.pose.headingDeg).toBe(-90);
    // The simulator's z is the negative of y.
    expect(s1.sim.z).toBeCloseTo(1.32, 6);
  });
  it('rotates a blue robot 180° about the FIELD center', () => {
    const sim = newSim(), red = editHandles(AUTO_TREES['solo-two-tip-sweep'], sim.view(0)), blue = editHandles(AUTO_TREES['solo-two-tip-sweep'], sim.view(2));
    expect(blue[0].pose).toEqual(red[0].pose);
    expect(blue[0].sim.x).toBeCloseTo(-red[0].sim.x, 9); expect(blue[0].sim.z).toBeCloseTo(-red[0].sim.z, 9);
    expect(Math.cos(blue[0].sim.heading! - red[0].sim.heading! - Math.PI)).toBeCloseTo(1, 9);
  });
  it('moves and turns a drive pose, and moves a lane point', () => {
    const view = newSim().view(0), id = 'solo-two-tip-sweep', tree = editedCopy(source(id)); addAutoTree(tree);
    try {
      const at = (t: Json) => editHandles(AUTO_TREES[String(t.id)], view);
      const drive = at(tree)[0], lane = at(tree).find(h => h.kind === 'lane')!;
      let t = moveHandle(tree, drive, { x: drive.pose.x + 0.2, y: drive.pose.y - 0.1 }); addAutoTree(t);
      // The shared definition stays as it is written, and the step gets an offset.
      expect(poseText(t, drive)).toBe('offset(launchAudience, 0.2, -0.1)');
      t = turnHandle(t, at(t)[0], drive.pose.headingDeg + 30); addAutoTree(t);
      expect(poseText(t, drive)).toBe('offset(launchAudience, 0.2, -0.1, 30)');
      t = moveHandle(t, lane, { x: lane.pose.x - 0.15, y: lane.pose.y + 0.05 }); addAutoTree(t);
      const d = at(t)[0], l = at(t).find(h => h.path === lane.path && h.lane === lane.lane)!;
      expect(d.pose.x).toBeCloseTo(drive.pose.x + 0.2, 3); expect(d.pose.y).toBeCloseTo(drive.pose.y - 0.1, 3); expect(d.pose.headingDeg).toBeCloseTo(drive.pose.headingDeg + 30, 6);
      expect(l.pose.x).toBeCloseTo(lane.pose.x - 0.15, 3); expect(l.pose.y).toBeCloseTo(lane.pose.y + 0.05, 3);
      expect(isEdited(t, d, source(id))).toBe(true); expect(isEdited(t, l, source(id))).toBe(true);
      const back = resetHandle(resetHandle(t, d, source(id)), l, source(id));
      expect(isEdited(back, d, source(id))).toBe(false); expect(isEdited(back, l, source(id))).toBe(false);
    } finally { removeAutoTree(String(tree.id)); }
  });
  it('names the other steps that share a definition', () => {
    const def = AUTO_TREES['wall-sweep-pair-right'], s1 = editHandles(def, newSim().view(0))[0];
    expect(sharedWith(source('wall-sweep-pair-right'), def, s1)).toEqual(['s6', 's11']);
  });
});

describe('edited copies', () => {
  it('gets its own id and name, and names the original', () => {
    const c = editedCopy(source('leave-and-park')), c2 = editedCopy(source('leave-and-park'), 2);
    expect([c.id, c.name, (c.meta as Json).editedFrom]).toEqual(['leave-and-park-edited', `${source('leave-and-park').name} (edited)`, 'leave-and-park']);
    expect([c2.id, c2.name]).toEqual(['leave-and-park-edited-2', `${source('leave-and-park').name} (edited 2)`]);
    expect(editedCopy(c)).toBe(c);
  });
  it("can't replace or remove a built-in tree", () => {
    expect(() => addAutoTree(source('leave-and-park'))).toThrow(/built in/);
    expect(removeAutoTree('leave-and-park')).toBe(false);
    expect(BUILT_IN_AUTO.size).toBe(8);
  });
  it('runs in the match: a moved first pose moves where the robot launches', () => {
    const id = 'solo-two-tip-sweep', copy = editedCopy(source(id)), s1 = editHandles(AUTO_TREES[id], newSim().view(0))[0];
    // Move the first launch pose 0.25 m toward the center line.
    const moved = moveHandle(copy, s1, { x: s1.pose.x + 0.25, y: s1.pose.y }); addAutoTree(moved);
    try {
      const at = (tree: string) => {
        const sim = newSim(); sim.start(); const c = new Coach(); c.autoOverride = tree;
        for (let k = 0; k < 2.0 / DT; k++) sim.step(sim.robots.map((_, i) => (i === 0 ? c.update(sim.view(0), DT) : NO_INPUT)), sim.robots.map(() => true));
        return sim.view(0).robot.translation();
      };
      const base = at(id), edited = at(String(moved.id));
      expect(edited.x - base.x).toBeGreaterThan(0.2); expect(Math.abs(edited.z - base.z)).toBeLessThan(0.05);
    } finally { removeAutoTree(String(moved.id)); }
  });
});
