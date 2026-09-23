/**
 * Editing an AUTO tree's poses on the FIELD. A drive step's pose is an expression, so a drag doesn't rewrite it: it
 * changes the step's `nudge`, an offset that the leaf adds to the pose, so the expression still follows the robot's size.
 * A sweep's lanes are numbers, so a drag moves a lane point itself. Positions in a tree are in red's frame, and a blue
 * robot mirrors them through the FIELD center, so an edit on a blue robot is mirrored back.
 *
 * Everything here works on the tree file's JSON and has no DOM, so tests can run it.
 */
import type { TreeDef } from '../bt';
import type { Sim } from '../sim/world';
import { leafParams, nudged, type Pose } from './onboard';

type Json = Record<string, unknown>;
type Lane = { x: number; z: number; wall: string | null };

/** One draggable point: a drive step's pose, or one lane point of a sweep. */
export interface Handle {
  /** The node's path in the tree, for example `root/steps/1.sequence/s3`. */
  path: string;
  kind: 'drive' | 'lane';
  /** The lane's index, for a lane point. */
  lane?: number;
  /** The FIELD position, in the simulator's x and z. */
  x: number; z: number;
  /** The FIELD heading in radians, for a drive step. A lane takes its heading from its direction or its wall. */
  heading?: number;
  /** A drive step's pose without its nudge, in red's frame. */
  base?: Pose;
  /** A drive step's nudge, in red's frame. */
  nudge?: Pose;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const ZERO: Pose = { x: 0, z: 0, headingDeg: 0 };

/** Gets the editable points of a tree for the robot that `sim` views, in step order. */
export function editHandles(def: TreeDef, sim: Sim): Handle[] {
  const s = sim.alliance === 'blue' ? -1 : 1, out: Handle[] = [];
  for (const { node, params: p } of leafParams(def, sim)) {
    if (node.label === 'auto.drive') {
      const base = p.pose as Pose, nudge = p.nudge as Pose, at = nudged(base, nudge);
      out.push({ path: node.path, kind: 'drive', x: s * at.x, z: s * at.z, heading: ((at.headingDeg + (s < 0 ? 180 : 0)) * Math.PI) / 180, base, nudge });
    }
    if (node.label === 'auto.sweep') (p.lanes as Lane[]).forEach((l, i) => out.push({ path: node.path, kind: 'lane', lane: i, x: s * l.x, z: s * l.z }));
  }
  return out;
}

/**
 * Finds the JSON of the node at `path` in a tree file. A path segment is a child's id, `INDEX.LABEL` for a child
 * without an id, or the key of a single child, such as `child`. Returns null if no node has that path.
 */
export function findNode(tree: Json, path: string): Json | null {
  const segs = path.split('/'); if (segs[0] !== 'root') return null;
  let node = tree.root as Json | undefined;
  for (const seg of segs.slice(1)) {
    if (!node || typeof node !== 'object') return null;
    const kind = Object.keys(node).find(k => k !== 'id' && k !== 'note'), spec = kind ? node[kind] : undefined;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
    const sp = spec as Json, single = sp[seg];
    if (seg !== 'children' && single && typeof single === 'object' && !Array.isArray(single)) { node = single as Json; continue; }
    const kids = sp.children; if (!Array.isArray(kids)) return null;
    const m = /^(\d+)\.(.+)$/.exec(seg);
    node = (kids as Json[]).find(k => k.id === seg) ?? (m && !(kids[Number(m[1])] as Json)?.id ? kids[Number(m[1])] as Json : undefined);
  }
  return node ?? null;
}

/** Copies a tree, applies `edit` to the params of the node at `path`, and returns the copy, or the tree itself if no node has that path. */
function editParams(tree: Json, path: string, edit: (params: Json) => void): Json {
  const out = structuredClone(tree), node = findNode(out, path); if (!node || node.ref === undefined) return tree;
  edit((node.params ??= {}) as Json); return out;
}

/**
 * Moves a handle to a FIELD position and returns the edited tree. A drive step's nudge becomes the distance from the
 * step's pose, and a lane point takes the position. Both round to 1 mm.
 */
export function moveHandle(tree: Json, h: Handle, x: number, z: number, alliance: 'red' | 'blue'): Json {
  const s = alliance === 'blue' ? -1 : 1, rx = s * x, rz = s * z;
  return editParams(tree, h.path, p => {
    if (h.kind === 'drive' && h.base) p.nudge = { x: mm(rx - h.base.x), z: mm(rz - h.base.z), headingDeg: (h.nudge ?? ZERO).headingDeg };
    if (h.kind === 'lane' && h.lane !== undefined && Array.isArray(p.lanes)) { const l = p.lanes[h.lane] as Lane; p.lanes[h.lane] = { ...l, x: mm(rx), z: mm(rz) }; }
  });
}

/** Turns a drive step to a FIELD heading in radians and returns the edited tree. The nudge's heading rounds to 0.5°. */
export function turnHandle(tree: Json, h: Handle, heading: number, alliance: 'red' | 'blue'): Json {
  if (h.kind !== 'drive' || !h.base) return tree;
  const deg = (heading * 180) / Math.PI - (alliance === 'blue' ? 180 : 0), n = h.nudge ?? ZERO;
  return editParams(tree, h.path, p => { p.nudge = { x: n.x, z: n.z, headingDeg: Math.round(wrapDeg(deg - h.base!.headingDeg) * 2) / 2 }; });
}

/** Undoes the edits of one handle: a drive step loses its nudge, and a lane point goes back to where `original` has it. */
export function resetHandle(tree: Json, h: Handle, original: Json): Json {
  const was = findNode(original, h.path)?.params as Json | undefined;
  return editParams(tree, h.path, p => {
    if (h.kind === 'drive') delete p.nudge;
    if (h.kind === 'lane' && h.lane !== undefined && Array.isArray(p.lanes) && Array.isArray(was?.lanes)) p.lanes[h.lane] = structuredClone(was.lanes[h.lane]);
  });
}

/** Checks whether a handle differs from the same handle in the original tree. */
export function isEdited(tree: Json, h: Handle, original: Json): boolean {
  const now = findNode(tree, h.path)?.params as Json | undefined, was = findNode(original, h.path)?.params as Json | undefined;
  if (h.kind === 'drive') { const n = now?.nudge as Pose | undefined; return !!n && (n.x !== 0 || n.z !== 0 || n.headingDeg !== 0); }
  return h.lane !== undefined && JSON.stringify((now?.lanes as unknown[])?.[h.lane]) !== JSON.stringify((was?.lanes as unknown[])?.[h.lane]);
}

/**
 * Makes an edited copy of a tree file: the id gets `-edited`, the name gets "(edited)", and `meta.editedFrom` names the
 * original. An edited copy comes back as it is, so a second edit doesn't copy it again.
 * @param n The copy's number. From 2, the id gets `-edited-N` and the name "(edited N)", so that a second copy of one tree doesn't replace the first.
 */
export function editedCopy(tree: Json, n = 1): Json {
  const meta = (tree.meta ?? {}) as Json; if (typeof meta.editedFrom === 'string') return tree;
  const suffix = n > 1 ? `-edited-${n}` : '-edited', label = n > 1 ? ` (edited ${n})` : ' (edited)';
  return { ...structuredClone(tree), id: `${String(tree.id).slice(0, 64 - suffix.length)}${suffix}`, name: `${String(tree.name).slice(0, 80 - label.length)}${label}`, meta: { ...meta, editedFrom: tree.id } };
}
