import { describe, expect, it } from 'vitest';
import { changedSteps, clonePlan, findNode } from '../src/auto/auto-edit';
import { AUTO_REGISTRY, AUTO_SOURCES } from '../src/auto/onboard';
import { PALETTE, startingPose } from '../src/auto/palette';
import { controlFields, deleteNode, eachNode, ensureIds, idsFor, insertAfter, insertNode, moveBy, moveNode, setControl, wrapNode } from '../src/auto/structure';
import { checkTree, loadTree } from '../src/bt';

type Json = Record<string, unknown>;
const copy = (id: string) => clonePlan(AUTO_SOURCES[id] as Json, { id: `${id}-copy`, name: 'Copy', description: 'A copy for a test.' });
const paths = (t: Json) => { const out: string[] = []; eachNode(t, (_, p) => out.push(p)); return out; };
const issues = (t: Json) => checkTree(t, AUTO_REGISTRY).issues.map(i => `${i.path}: ${i.message}`);

describe('ids', () => {
  it('gives every listed node an id, in tree order, and the same ids to the same structure', () => {
    const t = ensureIds(copy('solo-two-tip-sweep'));
    expect(paths(t).slice(0, 5)).toEqual(['root', 'root/steps', 'root/steps/finish', 'root/steps/n1', 'root/steps/n1/s1']);
    expect(paths(t).every(p => !/\/\d+\./.test(p))).toBe(true);
    expect(ensureIds(copy('solo-two-tip-sweep'))).toEqual(t);
    expect(ensureIds(t)).toEqual(t);
    expect(issues(t)).toEqual([]);
    // The change marks compare with the source plan given the same ids, so new ids mark no step changed.
    expect(changedSteps(loadTree(t, AUTO_REGISTRY), t, ensureIds(AUTO_SOURCES['solo-two-tip-sweep'] as Json)).size).toBe(0);
  });
  it('hands out ids that are new and different', () => {
    const next = idsFor(ensureIds(copy('solo-two-tip-sweep')));
    expect([next('s'), next('s'), next('n')]).toEqual(['s16', 's17', 'n11']);
  });
});

describe('structure edits', () => {
  const base = () => ensureIds(copy('solo-two-tip-sweep'));
  it('inserts after a node and inside a container, and deletes a node with its subtree', () => {
    let t = base();
    const r = insertAfter(t, 'root/steps/n1/s1', { id: 'w1', ref: 'wait', params: { timeoutSec: 0.5 } })!;
    expect(r.path).toBe('root/steps/n1/w1'); t = r.tree;
    expect((findNode(t, 'root/steps/n1') as { sequence: { children: Json[] } }).sequence.children.map(c => c.id).slice(0, 3)).toEqual(['s1', 'w1', 's2']);
    expect(issues(t)).toEqual([]);
    const r2 = insertNode(t, 'root/steps/n1/collect-s4', { id: 'w2', ref: 'wait', params: { timeoutSec: 0.5 } })!;
    expect(r2.path).toBe('root/steps/n1/collect-s4/w2');
    t = deleteNode(r2.tree, 'root/steps/n1/collect-s4');
    expect(findNode(t, 'root/steps/n1/collect-s4')).toBeNull();
    expect(issues(t)).toEqual([]);
    expect(insertAfter(t, 'root', { ref: 'wait' })).toBeNull();
    expect(deleteNode(t, 'root')).toBe(t);
  });
  it('moves a node up, down, into another container, and not into itself', () => {
    const t = base(), seq = 'root/steps/n1';
    const kids = (x: Json, p = seq) => (findNode(x, p) as { sequence: { children: Json[] } }).sequence.children.map(c => c.id);
    expect(kids(moveBy(t, `${seq}/s2`, -1)!.tree).slice(0, 3)).toEqual(['s2', 's1', 's3']);
    expect(kids(moveBy(t, `${seq}/s1`, 1)!.tree).slice(0, 3)).toEqual(['s2', 's1', 's3']);
    expect(moveBy(t, `${seq}/s1`, -1)).toBeNull();
    // To the end of the same container, and into a container below it.
    expect(kids(moveNode(t, `${seq}/s1`, seq)!.tree).slice(-2)).toEqual(['collect-s14', 's1']);
    const into = moveNode(t, `${seq}/s1`, `${seq}/collect-s4/n3`, 0)!;
    expect(into.path).toBe(`${seq}/collect-s4/n3/s1`);
    expect(moveNode(t, `${seq}/collect-s4`, `${seq}/collect-s4/n3`)).toBeNull();
    // Moving down within one container lands before the child that was at the index.
    expect(kids(moveNode(t, `${seq}/s1`, seq, 3)!.tree).slice(0, 3)).toEqual(['s2', 's3', 's1']);
  });
  it('wraps a node, and edits the settings of a control node', () => {
    const t = base();
    const w = wrapNode(t, 'root/steps/n1/s2', 'timeout')!;
    expect(w.path).toBe('root/steps/n1/n11');
    expect(findNode(w.tree, `${w.path}/child`)).toMatchObject({ id: 's2', ref: 'shooter.shoot' });
    expect(issues(w.tree)).toEqual([]);
    expect(controlFields(w.tree, w.path)).toEqual([expect.objectContaining({ key: 'sec', text: '3', required: true })]);
    const set = setControl(w.tree, w.path, 'sec', 'clock.remaining - 1');
    expect((findNode(set, w.path) as { timeout: Json }).timeout.sec).toBe('clock.remaining - 1');
    expect(issues(set)).toEqual([]);
    expect(controlFields(t, 'root/steps')).toEqual([expect.objectContaining({ key: 'policy', control: 'enum', text: 'any' })]);
    expect(controlFields(t, 'root/steps/n1/s1')).toBeNull();
  });
});

describe('palette', () => {
  it('makes nodes that load where they go, and a drive step at the pose before it', () => {
    const t = base0();
    expect(startingPose(t, 'root/steps/n1/s2')).toBe('launchAudience');
    for (const item of PALETTE) {
      const r = insertAfter(t, 'root/steps/n1/s2', item.make(idsFor(t), startingPose(t, 'root/steps/n1/s2')))!;
      const problems = issues(r.tree);
      // An empty container is a problem until something goes in it.
      if (['sequence', 'parallel', 'fallback'].includes(item.id)) expect(problems).toEqual([expect.stringMatching(/at least one node/)]);
      else expect([item.id, problems]).toEqual([item.id, []]);
    }
  });
});
function base0() { return ensureIds(copy('solo-two-tip-sweep')); }
