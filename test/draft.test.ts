import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { clonePlan, editHandles } from '../src/auto/auto-edit';
import { Coach } from '../src/auto/coach';
import { addDef, defRows, paramFields, readField, setDef, setParam, sortProblems } from '../src/auto/draft';
import { AUTO_PROBLEMS, AUTO_REGISTRY, AUTO_SOURCES, AUTO_TREES, addAutoTree, removeAutoTree } from '../src/auto/onboard';
import { checkTree, loadTree, TreeLoadError } from '../src/bt';
import { DT, NO_INPUT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });

type Json = Record<string, unknown>;
const newSim = () => new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true });
const copy = (id: string) => clonePlan(AUTO_SOURCES[id] as Json, { id: `${id}-draft`, name: `${String((AUTO_SOURCES[id] as Json).name)} (draft)`, description: 'A copy for a test.' });
const S3 = 'root/steps/1.sequence/s3';

describe('drafts', () => {
  it('checks a tree with problems, and returns the tree with every problem', () => {
    let t = setParam(copy('wall-sweep-pair-right'), S3, 'timeoutSec', 'slow');
    t = setDef(t, 'ownFlower', 'pose(1, 2)');
    const r = checkTree(t, AUTO_REGISTRY);
    expect(r.def).not.toBeNull();
    expect(r.issues.map(i => i.path)).toEqual(['defs.ownFlower', `${S3}.params.timeoutSec`]);
    expect(() => loadTree(t, AUTO_REGISTRY)).toThrow(TreeLoadError);
    const p = sortProblems(r.def, r.issues);
    expect(p.count).toBe(2);
    expect(p.defs.get('ownFlower')).toEqual([expect.stringMatching(/^pose\(\) takes 3 values, not 2/)]);
    expect(p.nodes.get(S3)).toEqual([{ param: 'timeoutSec', message: expect.stringMatching(/^Unknown name 'slow'/) }]);
  });
  it('names the parameter that a step is missing', () => {
    const t = setParam(copy('wall-sweep-pair-right'), S3, 'timeoutSec', undefined), r = checkTree(t, AUTO_REGISTRY);
    expect(sortProblems(r.def, r.issues).nodes.get(S3)).toEqual([{ param: 'timeoutSec', message: "drive.driveTo needs the parameter 'timeoutSec'." }]);
  });
  it('registers a draft with its problems, and a robot that runs it stays still in AUTO', () => {
    const t = setParam(copy('solo-two-tip-sweep'), 'root/steps/1.sequence/s1', 'timeoutSec', 'slow');
    expect(() => addAutoTree(t)).toThrow(TreeLoadError);
    const def = addAutoTree(t, true);
    try {
      expect(AUTO_TREES[def.id]).toBe(def); expect(AUTO_PROBLEMS[def.id]).toHaveLength(1);
      // Its handles still draw, from the parameters that evaluate.
      expect(editHandles(def, newSim().view(0)).length).toBeGreaterThan(3);
      const sim = newSim(); sim.start(); const c = new Coach(); c.autoOverride = def.id;
      const at = sim.view(0).robot.translation(), from = { x: at.x, z: at.z };
      for (let k = 0; k < 1.0 / DT; k++) {
        const inp = c.update(sim.view(0), DT); expect(inp).toBe(NO_INPUT);
        sim.step(sim.robots.map((_, i) => (i === 0 ? inp : NO_INPUT)), sim.robots.map(() => true));
      }
      const now = sim.view(0).robot.translation();
      expect(Math.hypot(now.x - from.x, now.z - from.z)).toBeLessThan(0.01);
      // Fixing it clears the problems.
      addAutoTree(setParam(t, 'root/steps/1.sequence/s1', 'timeoutSec', 3), true);
      expect(AUTO_PROBLEMS[def.id]).toBeUndefined();
    } finally { removeAutoTree(def.id); }
    expect(AUTO_PROBLEMS[def.id]).toBeUndefined();
  });
});

describe('forms', () => {
  it('gets a leaf\'s parameters as form fields, with the values as written', () => {
    const f = paramFields(copy('wall-sweep-pair-right'), S3, AUTO_REGISTRY)!;
    expect(f.map(q => [q.key, q.control, q.required, q.text])).toEqual([
      ['pose', 'expr', true, 'offset(ownFlower, 0.2, 0)'], ['timeoutSec', 'number', true, '3.5'], ['tag', 'text', false, ''],
    ]);
    expect(f[1]).toMatchObject({ unit: 's', min: 0, typeText: 'number' });
    expect(f[2].defaultText).toBe("''");
    expect(paramFields(copy('wall-sweep-pair-right'), 'root/steps', AUTO_REGISTRY)).toBeNull();
  });
  it('reads a field as a number, a word, null, or an expression, and an empty field removes the parameter', () => {
    const num = { control: 'number', nullable: true } as const;
    expect([readField(num, ' 2.5 '), readField(num, '-.5'), readField(num, 'len / 2'), readField(num, 'null'), readField(num, '  ')]).toEqual([2.5, -0.5, 'len / 2', null, undefined]);
    expect([readField({ control: 'expr', nullable: false }, 'true'), readField({ control: 'text', nullable: false }, ' a ')]).toEqual([true, ' a ']);
    const t = copy('wall-sweep-pair-right'), cell = 'root/steps/1.sequence/s2';
    const shoot = paramFields(t, cell, AUTO_REGISTRY)!.find(q => q.key === 'cell')!;
    expect(shoot).toMatchObject({ control: 'enum', nullable: true, required: false, values: ['rear', 'audience'] });
    const set = setParam(t, cell, 'cell', 'rear');
    expect(paramFields(set, cell, AUTO_REGISTRY)!.find(q => q.key === 'cell')!.text).toBe('rear');
    expect(setParam(set, cell, 'cell', undefined)).toEqual(t);
    expect(loadTree(set, AUTO_REGISTRY)).toBeTruthy();
  });
  it('lists, sets, and adds definitions', () => {
    const t = copy('wall-sweep-pair-right'), def = AUTO_TREES['wall-sweep-pair-right'];
    const rows = defRows(t, def);
    expect(rows.find(r => r.name === 'launchAudience')).toMatchObject({ pose: true, text: 'pose(hiveX, -1.32, -90 + flip)' });
    expect(rows.find(r => r.name === 'hiveX')).toMatchObject({ pose: false, typeText: 'number' });
    expect((setDef(t, 'hiveX', ' -0.3 ').defs as Json).hiveX).toBe('-0.3');
    expect(setDef(t, 'nothing', '1')).toBe(t);
    expect(addDef(t, 'hiveX', '1')).toEqual({ error: expect.stringMatching(/already/) });
    expect(addDef(t, 'x y', '1')).toEqual({ error: expect.stringMatching(/letters/) });
    expect(addDef(t, 'backOff', '')).toEqual({ error: expect.stringMatching(/expression/) });
    const r = addDef(t, 'backOff', '0.25'); if (!('tree' in r)) throw new Error(r.error);
    expect(loadTree(setParam(r.tree, S3, 'timeoutSec', 'backOff * 10'), AUTO_REGISTRY)).toBeTruthy();
  });
});
