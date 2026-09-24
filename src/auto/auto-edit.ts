/**
 * Editing an AUTO tree's poses on the FIELD. Everything here works on the tree file's JSON and has no DOM, so tests can
 * run it.
 *
 * A tree is written in the alliance frame, which is red's FIELD coordinates: x and y in meters, and headings in degrees
 * counterclockwise from +x. A blue robot runs the same tree rotated 180° about the FIELD center, so the editor edits
 * in red's frame only.
 *
 * A drive step's pose is an expression. A drag changes the expression by one rule: it edits the number literals of a
 * `pose(x, y, heading)` or `offset(p, dx, dy, dHeading)` call, and if the values that move aren't literals, it wraps
 * the expression in `offset()`. So `launchAudience` becomes `offset(launchAudience, 0.2, -0.1)`: the step still
 * follows the robot's size, and the steps that share the definition don't move. A path's waypoints are numbers, so a
 * drag changes a waypoint itself.
 */
import { literalNumber, splitCall, type TreeDef } from '../bt';
import type { Sim } from '../sim/world';
import { leafParams, simHeading, simPoint, type Pose } from './onboard';

type Json = Record<string, unknown>;
type Waypoint = { x: number; y: number; headingDeg: number | null };

/** One draggable point: a drive step's pose, or one waypoint of a path. */
export interface Handle {
  /** The node's path in the tree, for example `root/steps/1.sequence/s3`. */
  path: string;
  kind: 'drive' | 'waypoint';
  /** The waypoint's index, for a waypoint. */
  index?: number;
  /** Where the tree puts the point, in the alliance frame. A waypoint without a heading has heading 0 here: the robot faces along the path. */
  pose: Pose;
  /** The same point on the simulator's floor axes, for drawing: three.js x and z, and the heading in radians. */
  sim: { x: number; z: number; heading?: number };
}

const mm = (v: number) => Math.round(v * 1000) / 1000;
const halfDeg = (v: number) => Math.round(v * 2) / 2;
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** Writes a number for an expression: at most three decimals, and no `-0`. */
const num = (v: number) => String(Object.is(v, -0) ? 0 : v);

/** Gets the editable points of a tree for the robot that `sim` views, in step order. */
export function editHandles(def: TreeDef, sim: Sim): Handle[] {
  const rotate = sim.alliance === 'blue', out: Handle[] = [];
  for (const { node, params: p } of leafParams(def, sim)) {
    if (node.label === 'drive.driveTo') {
      const pose = p.pose as Pose;
      out.push({ path: node.path, kind: 'drive', pose, sim: { ...simPoint(pose, rotate), heading: simHeading(pose.headingDeg, rotate) } });
    }
    if (node.label === 'drive.followPath') (p.waypoints as Waypoint[]).forEach((w, i) => out.push({ path: node.path, kind: 'waypoint', index: i, pose: { x: w.x, y: w.y, headingDeg: w.headingDeg ?? 0 }, sim: simPoint(w, rotate) }));
  }
  return out;
}

/** Converts a FIELD point to the alliance frame of an alliance. Blue's frame is the FIELD rotated 180°. */
export const toAlliance = (p: { x: number; y: number }, alliance: 'red' | 'blue') => (alliance === 'blue' ? { x: -p.x, y: -p.y } : { x: p.x, y: p.y });

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

/** Copies a tree, applies `edit` to the params of the node at `path`, and returns the copy, or the tree itself if no leaf has that path. */
function editParams(tree: Json, path: string, edit: (params: Json) => void): Json {
  const out = structuredClone(tree), node = findNode(out, path); if (!node || node.ref === undefined) return tree;
  edit((node.params ??= {}) as Json); return out;
}

/** Writes a pose parameter as an expression. A tree file can also give a pose as an object of three values. */
function poseSource(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as { x: unknown; y: unknown; headingDeg: unknown };
  return `pose(${o.x}, ${o.y}, ${o.headingDeg})`;
}

/**
 * Moves and turns a pose expression by `dx` and `dy` meters and `dh` degrees, in the alliance frame. It edits the
 * number literals of a `pose()` or `offset()` call when every value that moves is a literal, and otherwise wraps the
 * expression in `offset()`. An offset that comes back to zero is removed, so a drag back to the start restores the
 * expression as it was.
 */
export function shiftPose(source: string, dx: number, dy: number, dh: number): string {
  const call = splitCall(source);
  if (call?.name === 'pose' && call.args.length === 3) {
    const [x, y, h] = call.args.map(literalNumber), d = [dx, dy, dh];
    if ([x, y, h].every((v, i) => d[i] === 0 || v !== null)) {
      const out = call.args.map((a, i) => (d[i] === 0 ? a : num((i === 2 ? halfDeg : mm)([x, y, h][i]! + d[i]))));
      return `pose(${out.join(', ')})`;
    }
  }
  if (call?.name === 'offset' && (call.args.length === 3 || call.args.length === 4)) {
    const [ox, oy] = [call.args[1], call.args[2]].map(literalNumber), oh = call.args.length === 4 ? literalNumber(call.args[3]) : 0;
    if (ox !== null && oy !== null && oh !== null) return offsetOf(call.args[0], mm(ox + dx), mm(oy + dy), halfDeg(wrapDeg(oh + dh)));
  }
  return offsetOf(source, mm(dx), mm(dy), halfDeg(wrapDeg(dh)));
}

const offsetOf = (base: string, dx: number, dy: number, dh: number) =>
  dx === 0 && dy === 0 && dh === 0 ? base : `offset(${base}, ${num(dx)}, ${num(dy)}${dh ? `, ${num(dh)}` : ''})`;

/** Moves a handle to a point in the alliance frame, and returns the edited tree. Values round to 1 mm. */
export function moveHandle(tree: Json, h: Handle, to: { x: number; y: number }): Json {
  return editParams(tree, h.path, p => {
    if (h.kind === 'drive') p.pose = shiftPose(poseSource(p.pose), to.x - h.pose.x, to.y - h.pose.y, 0);
    if (h.kind === 'waypoint' && h.index !== undefined && Array.isArray(p.waypoints)) { const w = p.waypoints[h.index] as Waypoint; p.waypoints[h.index] = { ...w, x: mm(to.x), y: mm(to.y) }; }
  });
}

/** Turns a drive step to a heading in degrees in the alliance frame, and returns the edited tree. The heading rounds to 0.5°. */
export function turnHandle(tree: Json, h: Handle, headingDeg: number): Json {
  if (h.kind !== 'drive') return tree;
  return editParams(tree, h.path, p => { p.pose = shiftPose(poseSource(p.pose), 0, 0, wrapDeg(headingDeg - h.pose.headingDeg)); });
}

/** The value that a handle edits: a drive step's `pose`, or one waypoint. */
function edited(tree: Json, h: Handle): unknown {
  const p = findNode(tree, h.path)?.params as Json | undefined;
  return h.kind === 'drive' ? p?.pose : (p?.waypoints as unknown[] | undefined)?.[h.index ?? -1];
}

/** Undoes the edits of one handle: its value goes back to what `original` has. */
export function resetHandle(tree: Json, h: Handle, original: Json): Json {
  const was = edited(original, h); if (was === undefined) return tree;
  return editParams(tree, h.path, p => {
    if (h.kind === 'drive') p.pose = structuredClone(was);
    if (h.kind === 'waypoint' && h.index !== undefined && Array.isArray(p.waypoints)) p.waypoints[h.index] = structuredClone(was);
  });
}

/** Checks whether a handle differs from the same handle in the original tree. */
export function isEdited(tree: Json, h: Handle, original: Json): boolean {
  return JSON.stringify(edited(tree, h)) !== JSON.stringify(edited(original, h));
}

/** Gets a drive step's pose parameter as it is written, such as `offset(launchAudience, 0.2, -0.1)`. */
export function poseText(tree: Json, h: Handle): string | null {
  const v = h.kind === 'drive' ? edited(tree, h) : undefined; return v === undefined ? null : poseSource(v);
}

/** Gets the ids of the other drive steps whose pose is the same bare definition as this step's, such as `launchAudience`. */
export function sharedWith(tree: Json, def: TreeDef, h: Handle): string[] {
  const mine = poseText(tree, h); if (!mine || !/^[A-Za-z_]\w*$/.test(mine)) return [];
  const out: string[] = [];
  const walk = (n: TreeDef['root']) => {
    if (n.label === 'drive.driveTo' && n.path !== h.path && poseText(tree, { ...h, path: n.path }) === mine) out.push(n.path.split('/').pop()!);
    n.children.forEach(walk);
  };
  walk(def.root);
  return out;
}

/**
 * Makes a tree id from a plan's name: lowercase letters, digits, and hyphens, at most 64 characters, and unique among
 * `taken`. A name with no letter or digit gets the id `plan`. A taken id gets `-2`, `-3`, and so on.
 */
export function planId(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58).replace(/-+$/, '') || 'plan';
  let id = base; for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Makes a plan from a copy of a tree file, with its own id, name, and description. `meta.clonedFrom` names the
 * source, so that the editor can reset a step to the source's value.
 */
export function clonePlan(tree: Json, plan: { id: string; name: string; description: string }): Json {
  const { editedFrom: _, clonedFrom: __, ...meta } = (tree.meta ?? {}) as Json;
  return { ...structuredClone(tree), id: plan.id, name: plan.name, description: plan.description, meta: { ...meta, clonedFrom: tree.id } };
}

/** Gets the id of the tree that a plan was copied from, or null for a tree that isn't a copy. */
export const sourceOf = (tree: Json): string | null => {
  const m = (tree.meta ?? {}) as Json, from = m.clonedFrom ?? m.editedFrom; return typeof from === 'string' ? from : null;
};

/**
 * Gets the leaves of `def` whose JSON in `tree` differs from the node at the same path in `original`, the plan that
 * `tree` was copied from. A leaf that `original` doesn't have counts as changed. Returns their paths.
 */
export function changedSteps(def: TreeDef, tree: Json, original: Json): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeDef['root']) => {
    if (n.leaf) { const a = findNode(tree, n.path), b = findNode(original, n.path); if (JSON.stringify(a) !== JSON.stringify(b)) out.add(n.path); }
    n.children.forEach(walk);
  };
  walk(def.root);
  return out;
}
