/**
 * The AUTO editor's palette: the leaves, the control nodes, and templates of a few nodes that AUTO plans use often,
 * each with starting settings that load. A new drive step starts at the pose of the drive step before it, so that it
 * shows on the FIELD, ready to drag.
 */
import { AUTO_REGISTRY } from './onboard';
import { eachNode } from './structure';

type Json = Record<string, unknown>;
/** Hands out a new id, `s` for a drive step and `n` for the rest. See `idsFor`. */
type Ids = (prefix: 's' | 'n') => string;

/** One item of the palette. `make` builds the node, with `pose` as the starting pose of a drive step. */
export interface PaletteItem { id: string; group: string; label: string; doc: string; make(ids: Ids, pose: string): Json }

/** The first sentence of a leaf type's doc. */
const leafDoc = (id: string) => `${(AUTO_REGISTRY.leaves[id]?.doc ?? '').split('. ')[0].replace(/\.$/, '')}.`;
const leaf = (ids: Ids, ref: string, params: Json): Json => ({ id: ids(ref.startsWith('drive.') ? 's' : 'n'), ref, params });
const PATH = [{ x: -1.2, y: 0, headingDeg: null }, { x: -0.6, y: 0, headingDeg: null }];
const full = (ids: Ids) => leaf(ids, 'waitUntil', { condition: 'bots.me.transfer.full' });
const intake = (ids: Ids) => leaf(ids, 'intake.run', { filter: 'all' });

/** The palette, in display order. */
export const PALETTE: readonly PaletteItem[] = [
  { id: 'drive.driveTo', group: 'Drive', label: 'driveTo', doc: leafDoc('drive.driveTo'), make: (ids, pose) => leaf(ids, 'drive.driveTo', { pose, timeoutSec: 3 }) },
  { id: 'drive.followPath', group: 'Drive', label: 'followPath', doc: leafDoc('drive.followPath'), make: ids => leaf(ids, 'drive.followPath', { waypoints: PATH, timeoutSec: 4 }) },
  { id: 'drive.push', group: 'Drive', label: 'push', doc: leafDoc('drive.push'), make: ids => leaf(ids, 'drive.push', { power: 0.35, timeoutSec: 1 }) },
  { id: 'intake.run', group: 'Intake', label: 'run', doc: leafDoc('intake.run'), make: intake },
  { id: 'shooter.shoot', group: 'Shooter', label: 'shoot', doc: leafDoc('shooter.shoot'), make: ids => leaf(ids, 'shooter.shoot', { count: 4, timeoutSec: 2.5 }) },
  { id: 'vision.waitTip', group: 'Vision', label: 'waitTip', doc: leafDoc('vision.waitTip'), make: ids => leaf(ids, 'vision.waitTip', { cell: 'rear', timeoutSec: 3 }) },
  { id: 'wait', group: 'Wait', label: 'wait', doc: leafDoc('wait'), make: ids => leaf(ids, 'wait', { timeoutSec: 1 }) },
  { id: 'waitUntil', group: 'Wait', label: 'waitUntil', doc: leafDoc('waitUntil'), make: ids => leaf(ids, 'waitUntil', { condition: 'bots.me.transfer.full', timeoutSec: 2 }) },
  { id: 'sequence', group: 'Flow', label: 'sequence', doc: 'Runs its children in order, and fails when one fails.', make: ids => ({ id: ids('n'), sequence: { children: [] } }) },
  { id: 'parallel', group: 'Flow', label: 'parallel', doc: 'Runs its children at once. With policy any, it ends when the first one ends.', make: ids => ({ id: ids('n'), parallel: { policy: 'any', children: [] } }) },
  { id: 'fallback', group: 'Flow', label: 'fallback', doc: 'Tries its children in order, until one succeeds.', make: ids => ({ id: ids('n'), fallback: { children: [] } }) },
  { id: 'condition', group: 'Flow', label: 'condition', doc: 'Succeeds if an expression is true, and fails otherwise.', make: ids => ({ id: ids('n'), condition: 'bots.me.transfer.full' }) },
  {
    id: 'collect', group: 'Templates', label: 'collect', doc: 'Drives to a pose with the intake on, and stops when the transfer is full.',
    make: (ids, pose) => ({ id: ids('n'), parallel: { policy: 'any', children: [full(ids), intake(ids), leaf(ids, 'drive.driveTo', { pose, timeoutSec: 3 })] } }),
  },
  {
    id: 'sweep', group: 'Templates', label: 'sweep', doc: 'Follows a path with the intake on, and stops when the transfer is full.',
    make: ids => ({ id: ids('n'), parallel: { policy: 'any', children: [full(ids), intake(ids), leaf(ids, 'drive.followPath', { waypoints: PATH, timeoutSec: 4 })] } }),
  },
  {
    id: 'launch', group: 'Templates', label: 'launch', doc: 'Drives to a launch pose, and launches what the robot carries.',
    make: (ids, pose) => ({ id: ids('n'), sequence: { children: [leaf(ids, 'drive.driveTo', { pose, timeoutSec: 3 }), leaf(ids, 'shooter.shoot', { count: 4, timeoutSec: 2.5 })] } }),
  },
];

/**
 * Gets the starting pose for a drive step added at `path`: the pose of the last drive step at or before `path` in tree
 * order, as it is written, or `pose(-1.2, 0, 0)`, on the own alliance's side, if there is none.
 */
export function startingPose(tree: Json, path: string | null): string {
  let last: string | null = null, reached = false;
  eachNode(tree, (n, p) => {
    if (reached) return;
    const v = n.ref === 'drive.driveTo' ? (n.params as Json | undefined)?.pose : undefined;
    if (typeof v === 'string') last = v;
    if (p === path) reached = true;
  });
  return last ?? 'pose(-1.2, 0, 0)';
}
