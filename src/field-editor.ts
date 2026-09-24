/**
 * The AUTO editor: shows a red robot's AUTO plan on the FIELD before a MATCH, and edits the poses of a plan that you
 * created, by dragging handles. System plans, the tree files in `src/auto/trees/auto/`, are read-only: **Create new**
 * copies one under a name and a description, and the copy becomes the robot's plan. Trees are written in red's frame,
 * and a blue robot runs them rotated 180° about the FIELD center, so the editor works on the two red robots. The
 * browser keeps your plans (`user-trees.ts`). See `auto/auto-edit.ts` for how a drag changes a tree.
 */
import type { TreeDef } from './bt';
import { clonePlan, editHandles, isEdited, moveHandle, planId, poseText, resetHandle, sharedWith, sourceOf, toAlliance, turnHandle, type Handle } from './auto/auto-edit';
import { AUTO_SOURCES, AUTO_TREES, BUILT_IN_AUTO, SOLO_AUTO, addAutoTree, autoFor, autoStart } from './auto/onboard';
import type { View, CameraMode } from './render/view';
import type { TreeEdit } from './render/tree-view';
import { startSide, type BotSetup } from './setup';
import type { Sim } from './sim/world';
import { deleteUserTree, saveUserTree } from './user-trees';
import { FIELD } from './sim/config';

type Json = Record<string, unknown>;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** The red robots: the editor edits in red's frame. */
export const RED_ROBOTS = [0, 1] as const;

export interface EditorHost {
  view: View; canvas: HTMLCanvasElement; bots: BotSetup[];
  sim(): Sim;
  /** Called when a robot's AUTO setting changes, so that the page saves the setups and updates the robot's coach. */
  setAuto(robot: number, id: string): void;
  /** Called when the editor opens, closes, or changes, so that the page redraws. */
  changed(): void;
}

export class FieldEditor {
  /** The red robot whose plan the editor shows, or -1 when the editor is closed. */
  robot = -1;
  /** True while you edit the plan: the handles take drags. Only a plan that you created can be edited. */
  editing = false;
  /** Counts the edits, for the key of the AUTO preview. */
  rev = 0;
  selected: string | null = null;
  handles: Handle[] = [];
  private tree: Json = {}; private original: Json = {}; private drag: { index: number; part: 'pose' | 'heading'; moved: boolean; dx: number; dy: number } | null = null;
  private camera: CameraMode = 'driver'; private swallowClick = false;

  constructor(private readonly host: EditorHost) {
    const c = host.canvas;
    c.addEventListener('pointerdown', e => {
      if (this.robot < 0 || e.button !== 0) return;
      const hit = this.handleAt(e); if (!hit) return;
      // Grabbing a handle selects its step; only a plan that you're editing lets it move.
      const h = this.handles[hit.index]; this.select(h.path); if (!this.editing) return;
      e.preventDefault(); c.setPointerCapture(e.pointerId);
      // The drag keeps the offset between the pointer and the handle, so that the handle doesn't jump to the pointer.
      const q = this.pointer(e);
      this.drag = { ...hit, moved: false, dx: q ? h.pose.x - q.x : 0, dy: q ? h.pose.y - q.y : 0 };
    });
    c.addEventListener('pointermove', e => {
      if (this.robot < 0) return;
      if (!this.drag) { c.style.cursor = this.handleAt(e) ? (this.editing ? 'grab' : 'pointer') : ''; return; }
      c.style.cursor = 'grabbing'; this.dragTo(e);
    });
    const end = (e: PointerEvent) => {
      if (!this.drag) return;
      // A release can come without a move to its own position, so the release position counts as a move.
      if (e.type === 'pointerup') this.dragTo(e);
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      // The click that follows the release would report the FIELD position in the log.
      this.swallowClick = true; if (this.drag.moved) this.save(); this.drag = null; c.style.cursor = '';
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }

  /**
   * Gets the handle under the pointer. Two steps can put handles on one spot, as two sweeps with the same waypoints do,
   * so the selected step's handles come first and win a tie.
   */
  private handleAt(e: PointerEvent): { index: number; part: 'pose' | 'heading' } | null {
    const order = this.handles.map((_, i) => i).sort((a, b) => Number(this.handles[b].path === this.selected) - Number(this.handles[a].path === this.selected));
    const hit = this.host.view.handleAt(e.clientX, e.clientY, order.map(i => this.handles[i].sim));
    return hit && { index: order[hit.index], part: hit.part };
  }

  /** Gets the FIELD point under the pointer in the edited robot's alliance frame, or null off the FIELD. */
  private pointer(e: PointerEvent) {
    const q = this.host.view.pickFloor(e.clientX, e.clientY);
    return q ? toAlliance(q, this.host.sim().view(this.robot).alliance) : null;
  }

  /** Moves the dragged handle, or turns its heading, to the pointer's position on the FIELD floor. */
  private dragTo(e: PointerEvent) {
    const q = this.drag && this.pointer(e); if (!this.drag || !q) return;
    const d = this.drag, h = this.handles[d.index], clamp = (v: number) => Math.max(-FIELD.half, Math.min(FIELD.half, v));
    const next = d.part === 'pose' ? moveHandle(this.tree, h, { x: clamp(q.x + d.dx), y: clamp(q.y + d.dy) })
      : turnHandle(this.tree, h, (Math.atan2(q.y - h.pose.y, q.x - h.pose.x) * 180) / Math.PI);
    if (JSON.stringify(next) !== JSON.stringify(this.tree)) { d.moved = true; this.apply(next, false); }
  }

  get active() { return this.robot >= 0; }

  /** Checks whether the canvas click that just happened ended a drag, and forgets it. The page ignores such a click. */
  takeClick() { const s = this.swallowClick; this.swallowClick = false; return s; }

  /** Gets the id of the AUTO tree that robot `i` runs, or null for none. */
  treeOf(i: number): string | null {
    const b = this.host.bots[i]; if (b.auto === 'none') return null;
    const id = b.auto === 'default' ? autoFor(this.host.sim().view(i), SOLO_AUTO) : b.auto;
    return AUTO_TREES[id] ? id : null;
  }

  /** Opens the editor on red robot `i`, with the overhead camera. Returns false for a blue robot. */
  open(i: number = 0): boolean {
    if (!RED_ROBOTS.includes(i as 0 | 1)) return false;
    if (this.robot < 0) { this.camera = this.host.view.mode; this.host.view.mode = 'overhead'; }
    this.showRobot(i); return true;
  }

  /** Shows the plan of red robot `i`. Editing stops: each plan is edited on purpose, with **Edit**. */
  showRobot(i: number) {
    const id = this.treeOf(i);
    this.robot = i; this.editing = false; this.selected = null; this.drag = null;
    this.tree = id ? (AUTO_SOURCES[id] as Json) : {}; this.original = this.originalOf(this.tree);
    this.rev++; this.refresh(); this.host.changed();
  }

  close() {
    if (this.robot < 0) return;
    this.robot = -1; this.editing = false; this.drag = null; this.handles = []; this.host.view.showHandles([]); this.host.view.mode = this.camera; this.host.canvas.style.cursor = '';
    this.host.changed();
  }

  /** The plan shown, as the robot runs it, or null for a robot with no AUTO plan. */
  get def(): TreeDef | null { const id = this.tree.id; return typeof id === 'string' ? AUTO_TREES[id] ?? null : null; }

  /** True if the plan shown is one that you created; false for a system plan. */
  get isUserPlan() { const id = this.tree.id; return typeof id === 'string' && !BUILT_IN_AUTO.has(id); }

  /** The start position that the plan shown is for, if it isn't the robot's own: a warning. */
  get wrongStart(): 'right' | 'left' | null {
    const def = this.def; if (!def || this.robot < 0) return null;
    const s = autoStart(def); return s !== 'any' && s !== startSide(this.robot) ? s : null;
  }

  /** Starts editing the plan shown. A system plan can't be edited. */
  edit() { if (!this.isUserPlan) return; this.editing = true; this.paint(); this.host.changed(); }

  /** Gets the plans that **Create new** can copy for the robot shown: every plan for its start position, and every plan for any start. */
  sources(): { id: string; name: string }[] {
    const side = this.robot >= 0 ? startSide(this.robot) : 'right';
    return Object.values(AUTO_TREES).filter(d => { const s = autoStart(d); return s === 'any' || s === side; }).map(d => ({ id: d.id, name: d.name }));
  }

  /**
   * Makes a plan from a copy of `from`, with `name` and `description`, makes it the robot's plan, and starts editing it.
   * Returns a problem to show, or null when it's made.
   */
  create(from: string, name: string, description: string): string | null {
    const n = name.trim(), d = description.trim(), src = AUTO_SOURCES[from] as Json | undefined;
    if (!n) return 'Give the plan a name.'; if (n.length > 80) return 'A name can have at most 80 characters.';
    if (!d) return 'Say what the plan does, in a sentence or two.'; if (!src) return 'Pick a plan to copy.';
    if (Object.values(AUTO_TREES).some(t => t.name.toLowerCase() === n.toLowerCase())) return `A plan is already named "${n}".`;
    const tree = clonePlan(src, { id: planId(n, id => id in AUTO_TREES), name: n, description: d });
    addAutoTree(tree); saveUserTree(tree);
    this.host.setAuto(this.robot, String(tree.id));
    this.showRobot(this.robot); this.edit();
    return null;
  }

  /**
   * Deletes the plan shown, which must be one that you created. Every robot that ran it goes back to the plan that it
   * was copied from, or to **Default** when that's the robot's default.
   */
  deletePlan() {
    if (!this.isUserPlan) return; const id = String(this.tree.id), from = sourceOf(this.tree);
    this.host.bots.forEach((b, k) => {
      if (b.auto !== id) return;
      const back = from && AUTO_TREES[from] && autoFor(this.host.sim().view(k), SOLO_AUTO) !== from ? from : 'default';
      this.host.setAuto(k, back);
    });
    deleteUserTree(id); this.showRobot(this.robot);
  }

  /** The tree view's options: the selection, and the nodes with handles. */
  treeEdit(): TreeEdit { return { selected: this.selected, editable: new Set(this.handles.map(h => h.path)) }; }

  select(path: string | null) { this.selected = path; this.paint(); this.host.changed(); }

  /** Checks whether any handle of the selected node differs from the plan that this one was copied from. */
  selectedEdited() { return this.editing && this.handles.some(h => h.path === this.selected && isEdited(this.tree, h, this.original)); }

  /** Moves the selected step's handles back to where the plan that this one was copied from has them. */
  resetSelected() {
    if (!this.selected || !this.editing) return; let t = this.tree;
    for (const h of this.handles.filter(q => q.path === this.selected)) t = resetHandle(t, h, this.original);
    if (t !== this.tree) this.apply(t, true);
  }

  /** Describes the selected step: its pose in red's FIELD coordinates, its pose as written, and the steps that share its definition. */
  describe(fmtPos: (x: number, y: number) => string): string {
    const hs = this.handles.filter(h => h.path === this.selected);
    if (!this.def) return 'This robot runs no AUTO plan. Pick one in its robot config.';
    if (!hs.length) return this.selected ? 'This step has no pose on the FIELD.' : this.editing ? 'Drag a pose or its heading knob, or click a step in the tree.' : 'Click a pose or a step in the tree.';
    if (hs[0].kind === 'waypoint') return `${hs.length} waypoints${this.editing ? ' · drag one to move it' : ''}`;
    const h = hs[0], deg = wrap(h.pose.headingDeg), def = this.def, shared = sharedWith(this.tree, def, h);
    return `${fmtPos(h.pose.x, h.pose.y)}, heading ${deg.toFixed(1)}° · pose ${poseText(this.tree, h)}`
      + (shared.length && this.editing ? ` · also used by ${shared.join(', ')}: a drag moves this step only` : '');
  }

  /** The tree that a plan was copied from, or the tree itself. */
  private originalOf(tree: Json): Json { const from = sourceOf(tree); return from && AUTO_SOURCES[from] ? (AUTO_SOURCES[from] as Json) : tree; }

  /** Makes `next` the plan being edited. A drag saves to storage when it ends; other edits save at once. */
  private apply(next: Json, save: boolean) {
    if (!this.editing) return;
    addAutoTree(next); this.tree = next;
    this.rev++; this.refresh(); if (save) this.save(); this.host.changed();
  }

  private save() { if (this.isUserPlan) saveUserTree(this.tree); }

  private refresh() { const def = this.def; this.handles = def ? editHandles(def, this.host.sim().view(this.robot)) : []; this.paint(); }

  private paint() {
    this.host.view.showHandles(this.handles.map(h => ({ ...h.sim, kind: h.kind, selected: h.path === this.selected, edited: this.isUserPlan && isEdited(this.tree, h, this.original) })), this.editing);
  }
}
