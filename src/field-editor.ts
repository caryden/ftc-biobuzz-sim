/**
 * The field editor: edits a red robot's AUTO poses by dragging handles on the FIELD before a MATCH. Trees are written
 * in red's frame, and a blue robot runs them rotated 180° about the FIELD center, so the editor opens for red robots
 * only. The first edit of a built-in tree makes an edited copy, which the robot then runs and this browser keeps. See
 * `auto/auto-edit.ts`.
 */
import type { TreeDef } from './bt';
import { editHandles, editedCopy, isEdited, moveHandle, poseText, resetHandle, sharedWith, toAlliance, turnHandle, type Handle } from './auto/auto-edit';
import { AUTO_SOURCES, AUTO_TREES, SOLO_AUTO, addAutoTree, autoFor } from './auto/onboard';
import type { View, CameraMode } from './render/view';
import type { TreeEdit } from './render/tree-view';
import type { BotSetup } from './setup';
import type { Sim } from './sim/world';
import { deleteUserTree, saveUserTree } from './user-trees';
import { FIELD } from './sim/config';

type Json = Record<string, unknown>;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export interface EditorHost {
  view: View; canvas: HTMLCanvasElement; bots: BotSetup[];
  sim(): Sim;
  /** Called when a robot's AUTO setting changes, so that the page saves the setups and updates the robot's coach. */
  setAuto(robot: number, id: string): void;
  /** Called when the editor opens, closes, or changes, so that the page redraws. */
  changed(): void;
}

export class FieldEditor {
  /** The robot being edited, or -1 when the editor is closed. */
  robot = -1;
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
      const hit = host.view.handleAt(e.clientX, e.clientY, this.handles.map(h => h.sim)); if (!hit) return;
      e.preventDefault(); c.setPointerCapture(e.pointerId);
      // The drag keeps the offset between the pointer and the handle, so that the handle doesn't jump to the pointer.
      const h = this.handles[hit.index], q = this.pointer(e);
      this.drag = { ...hit, moved: false, dx: q ? h.pose.x - q.x : 0, dy: q ? h.pose.y - q.y : 0 }; this.select(h.path);
    });
    c.addEventListener('pointermove', e => {
      if (this.robot < 0) return;
      if (!this.drag) { c.style.cursor = host.view.handleAt(e.clientX, e.clientY, this.handles.map(h => h.sim)) ? 'grab' : ''; return; }
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

  /**
   * Opens the editor for robot `i`, with the overhead camera. Returns why it can't: `blue` for a blue robot, which runs
   * a red tree rotated, or `none` for a robot with no AUTO tree. Returns null when it opens.
   */
  open(i: number): 'blue' | 'none' | null {
    if (this.host.sim().view(i).alliance !== 'red') return 'blue';
    const id = this.treeOf(i); if (!id) return 'none';
    this.robot = i; this.tree = AUTO_SOURCES[id] as Json; this.original = this.originalOf(this.tree); this.selected = null;
    this.camera = this.host.view.mode; this.host.view.mode = 'overhead';
    this.refresh(); this.host.changed(); return null;
  }

  close() {
    if (this.robot < 0) return;
    this.robot = -1; this.drag = null; this.handles = []; this.host.view.showHandles([]); this.host.view.mode = this.camera; this.host.canvas.style.cursor = '';
    this.host.changed();
  }

  /** The tree being edited, as the robot runs it. */
  get def(): TreeDef | null { const id = this.tree.id; return typeof id === 'string' ? AUTO_TREES[id] ?? null : null; }

  /** True if the tree being edited is an edited copy; false for a built-in tree. */
  get isCopy() { return typeof (this.tree.meta as Json | undefined)?.editedFrom === 'string'; }

  /** The tree view's options: the selection, and the nodes with handles. */
  treeEdit(): TreeEdit { return { selected: this.selected, editable: new Set(this.handles.map(h => h.path)) }; }

  select(path: string | null) { this.selected = path; this.paint(); this.host.changed(); }

  /** Checks whether any handle of the selected node differs from the original tree. */
  selectedEdited() { return this.handles.some(h => h.path === this.selected && isEdited(this.tree, h, this.original)); }

  /** Undoes the edits of the selected node's handles. */
  resetSelected() {
    if (!this.selected) return; let t = this.tree;
    for (const h of this.handles.filter(q => q.path === this.selected)) t = resetHandle(t, h, this.original);
    if (t !== this.tree) { this.apply(t, true); }
  }

  /**
   * Deletes the edited copy, and every robot that ran it runs the original tree again. A robot whose default is the
   * original goes back to the **Default** setting.
   */
  revert() {
    if (!this.isCopy) return; const id = String(this.tree.id), from = String((this.tree.meta as Json).editedFrom);
    this.host.bots.forEach((b, k) => { if (b.auto === id) this.host.setAuto(k, autoFor(this.host.sim().view(k), SOLO_AUTO) === from ? 'default' : from); });
    deleteUserTree(id); this.tree = AUTO_SOURCES[from] as Json; this.rev++; this.refresh(); this.host.changed();
  }

  /** Describes the selected step: its pose in red's FIELD coordinates, its pose as written, and the steps that share its definition. */
  describe(fmtPos: (x: number, y: number) => string): string {
    const hs = this.handles.filter(h => h.path === this.selected);
    if (!hs.length) return this.selected ? 'This step has no pose on the FIELD.' : 'Drag a pose or its heading knob, or click a step in the tree.';
    if (hs[0].kind === 'lane') return `${hs.length} lane points · drag one to move it`;
    const h = hs[0], deg = wrap(h.pose.headingDeg), def = this.def, shared = def ? sharedWith(this.tree, def, h) : [];
    return `${fmtPos(h.pose.x, h.pose.y)}, heading ${deg.toFixed(1)}° · pose ${poseText(this.tree, h)}`
      + (shared.length ? ` · also used by ${shared.join(', ')}: a drag moves this step only` : '');
  }

  /** The tree that an edited copy was made from, or the tree itself. */
  private originalOf(tree: Json): Json { const from = (tree.meta as Json | undefined)?.editedFrom; return typeof from === 'string' && AUTO_SOURCES[from] ? (AUTO_SOURCES[from] as Json) : tree; }

  /**
   * Makes `next` the tree being edited. An edit of a built-in tree becomes its edited copy, and the robot switches to
   * that copy. A drag saves to storage when it ends; other edits save at once.
   */
  private apply(next: Json, save: boolean) {
    const first = !this.isCopy;
    if (first) { let n = 1; while (AUTO_TREES[String(editedCopy(next, n).id)]) n++; next = editedCopy(next, n); }
    addAutoTree(next); this.tree = next;
    if (first) this.host.setAuto(this.robot, String(next.id));
    this.rev++; this.refresh(); if (save) this.save(); this.host.changed();
  }

  private save() { if (this.isCopy) saveUserTree(this.tree); }

  private refresh() { const def = this.def; this.handles = def ? editHandles(def, this.host.sim().view(this.robot)) : []; this.paint(); }

  private paint() {
    this.host.view.showHandles(this.handles.map(h => ({ ...h.sim, kind: h.kind, selected: h.path === this.selected, edited: isEdited(this.tree, h, this.original) })));
  }
}
