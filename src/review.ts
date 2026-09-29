import type { View } from './render/view';
import type { Sim } from './sim/world';
import { frameAsSim, notesMarkdown, type Frame, type Note, type Trace } from './trace';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PHASE: Record<string, string> = { auto: 'AUTO', transition: 'TRANSITION', teleop: 'TELEOP', post: 'FINAL' };
/** Formats seconds as the match clock shows them, for example 0:50. */
export const clockText = (s: number) => `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, '0')}`;
/** A fixed point on the timeline, such as the start of TELEOP. `t` is seconds since the MATCH started. */
export interface SystemMark { t: number; label: string }
/**
 * The scrubber counts tenths of a second. The recorder writes a frame about every 0.1 s, a little more because a frame
 * waits for a whole physics step, so frame indexes drift from the clock, and the scrubber uses frame times instead.
 */
const HZ = 10;
/** Seconds of recording that the timeline keeps after the MATCH ends. The recorder runs until the next reset. */
const POST_ROLL = 3;

/**
 * The timeline of the control bar, and the review mode: scrub back through the MATCH and click a robot to attach a
 * note to it at the cursor. The scoreboard follows the cursor through `frame`. Notes save to
 * traces/<name>.annotations.json and .md through the dev server. The Markdown file carries what every robot was doing at
 * each note, so the screen doesn't have to.
 */
export class Review {
  /** The number plate of each robot id, for example `{ R0: '12345' }`. The note popup shows it. */
  plates: Record<string, string> = {};
  active = false; notes: Note[] = [];
  /** Called when playback reaches the newest frame. During a MATCH, the page goes back to live. */
  onEnd = () => {};
  /** Called when a click on a note's dot needs the review open. The page saves the trace and enters the review. */
  onOpen = () => {};
  private trace: Trace | null = null; private system: SystemMark[] = []; private span = 0; private marksLength = -1;
  private index = 0; private playing = false; private acc = 0;
  private scrub = $<HTMLInputElement>('scrub'); private editing: { note: Note; isNew: boolean } | null = null;

  constructor(private view: View, private template: () => Sim, canvas: HTMLCanvasElement) {
    $('nexport').onclick = () => this.exportFiles();
    $('ncopy').onclick = async () => { if (!this.trace) return; const path = `traces/${this.trace.name}.annotations.md`; await navigator.clipboard.writeText(path); $('nsaved').textContent = `Copied ${path}`; };
    $('nsave').onclick = () => this.saveNote(); $('ncancel').onclick = () => this.closeNote();
    $('ndel').onclick = () => { if (this.editing) this.notes = this.notes.filter(n => n !== this.editing!.note); this.closeNote(); this.changed(); };
    canvas.addEventListener('click', e => this.click(e.clientX, e.clientY));
    // Keys typed in the note must not drive the robot or reset the field.
    for (const ev of ['keydown', 'keyup']) $('ntext').addEventListener(ev, e => {
      e.stopPropagation(); const k = e as KeyboardEvent; if (ev !== 'keydown') return;
      if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); this.saveNote(); }
      if (k.key === 'Escape') this.closeNote();
    });
  }

  /**
   * Sets the recording that the timeline shows, while the MATCH records it. `span` is the MATCH length in seconds, or
   * Infinity for practice, and `system` holds the MATCH's fixed points.
   */
  attach(trace: Trace, span: number, system: SystemMark[]) { this.trace = trace; this.span = span; this.system = system; this.index = 0; this.playing = false; this.marksLength = -1; }

  /** The trace and the frame index at the cursor, or null outside the review. The tree view draws from them. */
  get cursor(): { trace: Trace; index: number } | null { return this.active && this.trace ? { trace: this.trace, index: this.index } : null; }

  /** The trace frame at the cursor, or null outside the review. The scoreboard draws from it. */
  get frame(): Frame | null { return this.active && this.trace ? this.trace.frames[this.index] : null; }

  /** The frame index at the cursor. */
  get at(): number { return this.index; }
  /** True while the review plays the recording; false otherwise. */
  get isPlaying(): boolean { return this.playing; }

  /** The newest frame that the timeline reaches: `POST_ROLL` seconds after the MATCH ends at most. -1 before the MATCH starts. */
  get end(): number {
    const frames = this.trace?.frames ?? [], post = frames.findIndex(f => f.phase === 'post');
    return post < 0 ? frames.length - 1 : Math.min(frames.length - 1, post + POST_ROLL * HZ);
  }

  /** The scrubber's range in tenths of a second. It covers the whole MATCH, so the recorded part grows across it. */
  get length(): number { return Math.max(1, Math.round(HZ * Math.max(this.endTime, Number.isFinite(this.span) ? this.span : 0))); }
  /** The time of the newest frame that the timeline reaches, in seconds. 0 before the MATCH starts. */
  private get endTime(): number { return this.trace?.frames[this.end]?.t ?? 0; }

  /** Gets the frame index for a scrubber value: the first frame at or after that time, up to `end`. */
  frameAt(value: number): number {
    const frames = this.trace?.frames ?? [], t = value / HZ - 0.05; let lo = 0, hi = Math.max(0, this.end);
    while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** The stop before frame `from`: a system mark or a note. It skips stops about 1 s back or less, so repeated presses keep going back. */
  prevStop(from: number): number { return this.stops().filter(i => i < from - HZ).pop() ?? 0; }
  /** The first stop after frame `from`, or null if the recording has none. */
  nextStop(from: number): number | null { return this.stops().find(i => i > from + 1) ?? null; }

  /** Gets the frame indexes of the system marks and the notes that the recording has reached, in order. */
  private stops(): number[] {
    if (this.end < 0) return []; const reached = this.endTime + 0.05;
    const at = [...this.system.map(m => m.t), ...this.notes.map(n => n.t)].filter(t => t <= reached).map(t => this.frameAt(t * HZ));
    return [...new Set(at)].sort((a, b) => a - b);
  }

  /** Adds a note at a time in seconds. During a live match this is the "mark this moment" key, and the referee's calls. */
  mark(trace: Trace, t: number, text = '', robot: string | null = null) {
    const f = trace.frames.reduce((best, q) => (Math.abs(q.t - t) < Math.abs(best.t - t) ? q : best), trace.frames[0]); if (!f) return;
    this.notes.push({ t: f.t, clock: f.clock, phase: f.phase, robot, text }); this.trace = trace; this.changed(trace);
  }

  /** Opens the review at the newest frame. The live MATCH waits while the review is open. */
  enter(trace: Trace) {
    if (!trace.frames.length) return; this.trace = trace; this.active = true; this.playing = false; this.index = this.end;
    // Notes that an earlier visit kept in this browser come back with their trace name.
    if (!this.notes.length) { try { this.notes = JSON.parse(localStorage.getItem(`biobuzz.notes.${trace.name}`) ?? '[]'); } catch { this.notes = []; } }
    document.body.classList.add('reviewing'); this.paint(); this.paintMarks();
  }
  exit() { this.active = false; this.playing = false; this.closeNote(); document.body.classList.remove('reviewing'); }

  /** Moves the cursor to frame `i` and stops playback. */
  seek(i: number) { this.index = Math.max(0, Math.min(this.end, Math.round(i))); this.playing = false; this.closeNote(); this.paint(); }

  /** Starts or stops playback. At the newest frame, playback starts over from the first frame. */
  toggle() { this.playing = !this.playing; this.closeNote(); if (this.playing && this.index >= this.end) this.index = 0; }

  /** Opens the note popup for the robot under the pointer. A note that the same robot has within 0.5 s opens for editing. */
  private click(x: number, y: number) {
    const f = this.frame; if (!f) return; const i = this.view.pickRobot(x, y); if (i === null || !f.robots[i]) { this.closeNote(); return; }
    const robot = f.robots[i].id, old = this.notes.find(n => n.robot === robot && Math.abs(n.t - f.t) <= 0.5);
    this.openNote(x, y, old ?? { t: f.t, clock: f.clock, phase: f.phase, robot, text: '' }, !old);
  }

  private openNote(x: number, y: number, note: Note, isNew: boolean) {
    this.playing = false; this.editing = { note, isNew }; const pop = $('notepop'), text = $<HTMLTextAreaElement>('ntext');
    $('nhead').textContent = `${note.robot ? this.plates[note.robot] ?? note.robot : 'Marked moment'} · ${PHASE[note.phase] ?? note.phase} ${clockText(note.clock)}`;
    text.value = note.text; $('ndel').classList.toggle('hidden', isNew); pop.classList.remove('hidden');
    // The popup opens beside the click, at whichever side has room, so that it doesn't cover the robot.
    const w = pop.offsetWidth, gap = 60; pop.style.left = `${Math.max(8, x + gap + w < innerWidth - 8 ? x + gap : x - gap - w)}px`; pop.style.top = `${Math.max(8, Math.min(y - 20, innerHeight - pop.offsetHeight - 60))}px`; text.focus();
  }
  private closeNote() { this.editing = null; $('notepop').classList.add('hidden'); }
  private saveNote() {
    const e = this.editing, text = $<HTMLTextAreaElement>('ntext').value.trim(); if (!e) return; this.closeNote(); if (!text && e.isNew) return;
    e.note.text = text; if (e.isNew) this.notes.push(e.note); this.changed();
  }

  private changed(trace = this.trace) { this.notes.sort((a, b) => a.t - b.t); if (trace) void this.save(trace); this.paintMarks(); }

  /**
   * Saves the notes. With the dev server, they go to traces/<name>.annotations.json and .md in the repository. On the
   * public site there is no server, so they go to this browser's storage, and Export downloads them as files.
   */
  private async save(trace: Trace) {
    const local = () => { try { localStorage.setItem(`biobuzz.notes.${trace.name}`, JSON.stringify(this.notes)); $('nsaved').textContent = `${this.notes.length} ${this.notes.length === 1 ? 'note' : 'notes'} kept in this browser. Use Export to save files.`; } catch { $('nsaved').textContent = 'Not saved: this browser blocks storage. Use Export.'; } };
    try {
      const res = await fetch(`/api/notes/${trace.name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: { trace: trace.name, settings: trace.settings, notes: this.notes }, markdown: notesMarkdown(trace, this.notes) }) });
      if (res.ok) $('nsaved').textContent = `${this.notes.length} ${this.notes.length === 1 ? 'note' : 'notes'} in traces/${trace.name}.annotations.md`; else local();
    } catch { local(); }
  }

  /** Downloads the notes as Markdown and the trace as JSON, for a site with no server to write them. */
  private exportFiles() {
    const tr = this.trace; if (!tr || !tr.frames.length) { $('nsaved').textContent = 'Nothing to export: the MATCH hasn\'t started.'; return; }
    const download = (name: string, text: string, type: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    download(`${tr.name}.annotations.md`, notesMarkdown(tr, this.notes), 'text/markdown'); download(`${tr.name}.json`, JSON.stringify(tr), 'application/json');
    $('nsaved').textContent = `Exported ${tr.name}.annotations.md and ${tr.name}.json`;
  }

  /**
   * Draws the timeline marks: a gray tick for each system mark, and a dot for each note, in the alliance color of its
   * robot. A click on a dot goes to the note and opens it.
   */
  private paintMarks() {
    const box = $('marks'), tr = this.trace, len = this.length; box.innerHTML = ''; this.marksLength = len; if (!tr) return;
    const left = (t: number) => `${(100 * Math.min(len, t * HZ)) / len}%`;
    for (const m of this.system) { const tick = document.createElement('i'); tick.className = 'sys'; tick.style.left = left(m.t); box.append(tick); }
    for (const n of this.notes) {
      const dot = document.createElement('i'); dot.style.left = left(n.t); dot.style.background = n.robot?.[0] === 'R' ? 'var(--red)' : n.robot?.[0] === 'B' ? 'var(--blue)' : 'var(--pollen)';
      dot.title = `${n.robot ? this.plates[n.robot] ?? n.robot : 'Mark'} ${PHASE[n.phase] ?? n.phase} ${clockText(n.clock)}: ${n.text || 'no text'}`;
      dot.onclick = () => {
        if (!this.active) this.onOpen(); if (!this.active) return;
        // The popup opens right of the control bar, so that it covers neither the bar nor the score table.
        this.seek(this.frameAt(n.t * HZ)); this.openNote(0, 0, n, false);
        const bar = $('transport').getBoundingClientRect(), pop = $('notepop'); pop.style.left = `${bar.right + 8}px`; pop.style.top = `${bar.bottom + 8}px`;
      };
      box.append(dot);
    }
  }

  /**
   * Draws the timeline's range, its recorded part, and its marks. Outside the review, the thumb sits at the newest
   * frame. Call it whenever the recording grows.
   */
  paintTrack() {
    const len = this.length, endAt = Math.round(HZ * this.endTime); this.scrub.max = String(len); this.scrub.disabled = this.end < 0;
    $('tfill').style.width = `${(100 * endAt) / len}%`;
    if (!this.active) this.scrub.value = String(endAt);
    if (len !== this.marksLength) this.paintMarks();
  }

  /** Advances playback and draws the frame at the cursor. Call once per animation frame while active. */
  tick(dtSec: number) {
    if (!this.trace) return;
    if (this.playing) {
      this.acc += dtSec * Number($<HTMLSelectElement>('rspeed').value); while (this.acc >= 0.1) { this.acc -= 0.1; this.index++; }
      if (this.index >= this.end) { this.index = this.end; this.playing = false; this.paint(); this.onEnd(); return; }
    }
    this.paint();
  }

  private paint() {
    const tr = this.trace; if (!tr) return; const f = tr.frames[this.index]; if (!f) return; this.scrub.value = String(Math.round(HZ * f.t));
    $('scrubtime').textContent = `${PHASE[f.phase] ?? f.phase} ${clockText(f.clock)}`;
    this.view.sync(frameAsSim(tr, this.index, this.template()), null, null);
  }
}
