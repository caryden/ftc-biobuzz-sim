import type { View } from './render/view';
import type { Sim } from './sim/world';
import { frameAsSim, notesMarkdown, type Frame, type Note, type Trace } from './trace';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PHASE: Record<string, string> = { auto: 'AUTO', transition: 'TRANSITION', teleop: 'TELEOP', post: 'FINAL' };
/** Formats seconds as the match clock shows them, for example 0:50. */
export const clockText = (s: number) => `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, '0')}`;

/**
 * The review mode: scrub back through a recorded match and click a robot to attach a note to it at the cursor. The
 * scoreboard follows the cursor through `frame`. Notes save to traces/<name>.annotations.json and .md through the dev
 * server. The Markdown file carries what every robot was doing at each note, so the screen doesn't have to.
 */
export class Review {
  /** The number plate of each robot id, for example `{ R0: '12345' }`. The note popup shows it. */
  plates: Record<string, string> = {};
  active = false; notes: Note[] = []; private trace: Trace | null = null; private index = 0; private playing = false; private acc = 0;
  private scrub = $<HTMLInputElement>('scrub'); private editing: { note: Note; isNew: boolean } | null = null;

  constructor(private view: View, private template: () => Sim, canvas: HTMLCanvasElement) {
    this.scrub.oninput = () => { this.index = Number(this.scrub.value); this.playing = false; this.closeNote(); this.paint(); };
    $('rplay').onclick = () => { this.playing = !this.playing; this.closeNote(); if (this.trace && this.index >= this.trace.frames.length - 1) this.index = 0; };
    $('rexit').onclick = () => this.exit();
    $('nexport').onclick = () => this.exportFiles();
    $('ncopy').onclick = async () => { if (!this.trace) return; const path = `traces/${this.trace.name}.annotations.md`; await navigator.clipboard.writeText(path); $('nsaved').textContent = `Copied ${path}`; };
    $('nsave').onclick = () => this.saveNote(); $('ncancel').onclick = () => this.closeNote();
    $('ndel').onclick = () => { if (this.editing) this.notes = this.notes.filter(n => n !== this.editing!.note); this.closeNote(); this.changed(); };
    canvas.addEventListener('click', e => this.click(e.clientX, e.clientY));
    // Keys typed in the note or the clock field must not drive the robot or reset the field.
    for (const ev of ['keydown', 'keyup']) for (const id of ['ntext', 'rgoto']) $(id).addEventListener(ev, e => {
      e.stopPropagation(); const k = e as KeyboardEvent; if (ev !== 'keydown') return;
      if (id === 'ntext' && k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); this.saveNote(); }
      if (id === 'ntext' && k.key === 'Escape') this.closeNote();
      if (id === 'rgoto' && k.key === 'Enter') { this.goToClock($<HTMLInputElement>('rgoto').value); $<HTMLInputElement>('rgoto').value = ''; $('rgoto').blur(); }
    });
  }

  /** The trace frame at the cursor, or null outside the review. The scoreboard draws from it. */
  get frame(): Frame | null { return this.active && this.trace ? this.trace.frames[this.index] : null; }

  /** Adds a note at a time in seconds. During a live match this is the "mark this moment" key. */
  mark(trace: Trace, t: number, text = '', robot: string | null = null) {
    const f = trace.frames.reduce((best, q) => (Math.abs(q.t - t) < Math.abs(best.t - t) ? q : best), trace.frames[0]); if (!f) return;
    this.notes.push({ t: f.t, clock: f.clock, phase: f.phase, robot, text }); this.trace = trace; this.changed(trace);
  }

  enter(trace: Trace) {
    if (!trace.frames.length) return; this.trace = trace; this.active = true; this.playing = false; this.index = trace.frames.length - 1;
    // Notes that an earlier visit kept in this browser come back with their trace name.
    if (!this.notes.length) { try { this.notes = JSON.parse(localStorage.getItem(`biobuzz.notes.${trace.name}`) ?? '[]'); } catch { this.notes = []; } }
    this.scrub.max = String(trace.frames.length - 1); $('review').classList.remove('hidden'); document.body.classList.add('reviewing'); this.paint(); this.paintMarks();
  }
  exit() { this.active = false; this.closeNote(); $('review').classList.add('hidden'); document.body.classList.remove('reviewing'); }

  /** Moves the cursor to a match clock time such as "0:50" or "50". TELEOP wins when AUTO has the same clock value. */
  private goToClock(text: string) {
    const m = text.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); if (!m || !this.trace) return; const want = Number(m[1] ?? 0) * 60 + Number(m[2]);
    const frames = this.trace.frames, pool = frames.some(f => f.phase === 'teleop') ? frames.filter(f => f.phase === 'teleop') : frames;
    const best = pool.reduce((a, b) => (Math.abs(b.clock - want) < Math.abs(a.clock - want) ? b : a)); this.index = frames.indexOf(best); this.playing = false; this.paint();
  }

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

  private changed(trace = this.trace) { this.notes.sort((a, b) => a.t - b.t); if (trace) void this.save(trace); if (this.active) this.paintMarks(); }

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
    const tr = this.trace; if (!tr) return;
    const download = (name: string, text: string, type: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    download(`${tr.name}.annotations.md`, notesMarkdown(tr, this.notes), 'text/markdown'); download(`${tr.name}.json`, JSON.stringify(tr), 'application/json');
    $('nsaved').textContent = `Exported ${tr.name}.annotations.md and ${tr.name}.json`;
  }

  /** Draws one dot per note on the timeline, in the alliance color of its robot. A click goes to the note and opens it. */
  private paintMarks() {
    const box = $('marks'), tr = this.trace; box.innerHTML = ''; if (!tr) return; const end = tr.frames[tr.frames.length - 1].t || 1;
    for (const n of this.notes) {
      const dot = document.createElement('i'); dot.style.left = `${(100 * n.t) / end}%`; dot.style.background = n.robot?.[0] === 'R' ? 'var(--red)' : n.robot?.[0] === 'B' ? 'var(--blue)' : 'var(--pollen)';
      dot.title = `${n.robot ?? 'Mark'} ${clockText(n.clock)}: ${n.text || 'no text'}`;
      dot.onclick = () => { this.index = Math.max(0, tr.frames.findIndex(f => f.t >= n.t)); this.paint(); const r = dot.getBoundingClientRect(); this.openNote(r.left, r.top - 150, n, false); };
      box.append(dot);
    }
  }

  /** Advances playback and draws the frame at the cursor. Call once per animation frame while active. */
  tick(dtSec: number) {
    if (!this.trace) return;
    if (this.playing) { this.acc += dtSec * Number($<HTMLSelectElement>('rspeed').value); while (this.acc >= 0.1) { this.acc -= 0.1; this.index++; } if (this.index >= this.trace.frames.length - 1) { this.index = this.trace.frames.length - 1; this.playing = false; } }
    this.paint();
  }

  private paint() {
    const tr = this.trace; if (!tr) return; const f = tr.frames[this.index]; this.scrub.value = String(this.index); $('rplay').textContent = this.playing ? 'Pause' : 'Play';
    $('scrubtime').textContent = `${PHASE[f.phase] ?? f.phase} ${clockText(f.clock)}`;
    this.view.sync(frameAsSim(tr, this.index, this.template()), null, null);
  }
}
