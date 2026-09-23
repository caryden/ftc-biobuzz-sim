import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { editHandles, editedCopy, findNode, isEdited, moveHandle, resetHandle, turnHandle } from '../src/auto/auto-edit';
import { AUTO_SOURCES, AUTO_TREES, BUILT_IN_AUTO, addAutoTree, removeAutoTree } from '../src/auto/onboard';
import { Coach } from '../src/auto/coach';
import type { CNode } from '../src/bt';
import { DT, NO_INPUT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });

type Json = Record<string, unknown>;
const newSim = () => new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true });
const source = (id: string) => AUTO_SOURCES[id] as Json;
const leaves = (n: CNode, out: CNode[] = []) => { if (n.leaf) out.push(n); n.children.forEach(c => leaves(c, out)); return out; };

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
  // Red robot 0 and blue robot 2. Blue mirrors every pose through the FIELD center.
  for (const robot of [0, 2]) {
    it(`moves and turns a drive pose, and moves a lane point, for robot ${robot}`, () => {
      const sim = newSim(), view = sim.view(robot), a = view.alliance, id = 'solo-two-tip-sweep';
      const tree = editedCopy(source(id)); addAutoTree(tree);
      try {
        const hs = editHandles(AUTO_TREES[String(tree.id)], view), drive = hs.find(h => h.kind === 'drive')!, lane = hs.find(h => h.kind === 'lane')!;
        let t = moveHandle(tree, drive, drive.x + 0.2, drive.z - 0.1, a); addAutoTree(t);
        // A turn keeps the move: it reads the handle's nudge, so it takes the handle after the move.
        t = turnHandle(t, editHandles(AUTO_TREES[String(t.id)], view).find(h => h.path === drive.path)!, 0.5, a);
        t = moveHandle(t, lane, lane.x - 0.15, lane.z + 0.05, a); addAutoTree(t);
        const after = editHandles(AUTO_TREES[String(t.id)], view), d = after.find(h => h.path === drive.path)!, l = after.find(h => h.path === lane.path && h.lane === lane.lane)!;
        expect(d.x).toBeCloseTo(drive.x + 0.2, 3); expect(d.z).toBeCloseTo(drive.z - 0.1, 3);
        expect(Math.cos(d.heading! - 0.5)).toBeGreaterThan(Math.cos((0.5 * Math.PI) / 180));
        expect(l.x).toBeCloseTo(lane.x - 0.15, 3); expect(l.z).toBeCloseTo(lane.z + 0.05, 3);
        // The pose expression stays as it was written. Only the nudge changes.
        expect((findNode(t, drive.path)!.params as Json).pose).toBe((findNode(source(id), drive.path)!.params as Json).pose);
        expect(isEdited(t, d, source(id))).toBe(true); expect(isEdited(t, l, source(id))).toBe(true);
        const back = resetHandle(resetHandle(t, d, source(id)), l, source(id));
        expect(isEdited(back, d, source(id))).toBe(false); expect(isEdited(back, l, source(id))).toBe(false);
      } finally { removeAutoTree(String(tree.id)); }
    });
  }
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
  it('runs in the match: a nudged first pose moves where the robot launches', () => {
    const id = 'solo-two-tip-sweep', copy = editedCopy(source(id)), s1 = editHandles(AUTO_TREES[id], newSim().view(0))[0];
    // Move the first launch pose 0.25 m toward the center line.
    const moved = moveHandle(copy, s1, s1.x + 0.25, s1.z, 'red'); addAutoTree(moved);
    try {
      const at = (tree: string) => {
        const sim = newSim(); sim.start(); const c = new Coach(); c.autoOverride = tree;
        for (let k = 0; k < 2.0 / DT; k++) sim.step(sim.robots.map((_, i) => (i === 0 ? c.update(sim.view(0), DT) : NO_INPUT)), sim.robots.map(() => true));
        return sim.view(0).robot.translation();
      };
      const base = at(id), nudged = at(String(moved.id));
      expect(nudged.x - base.x).toBeGreaterThan(0.2); expect(Math.abs(nudged.z - base.z)).toBeLessThan(0.05);
    } finally { removeAutoTree(String(moved.id)); }
  });
});
