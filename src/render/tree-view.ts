/**
 * The tree view: a panel that draws a robot's behavior tree as an outline, with the running nodes highlighted and every
 * other node marked with its last result. Live, it reads the robot's recorder. In review, it reads the match trace.
 */
import type { CNode, Recorder, TreeDef } from '../bt';
import type { Trace } from '../trace';

/** The state of a tree at one moment: the running nodes, and each other node's last result (`s`, `f:TAG`, `h`, or `e`). */
export interface TreeState { running: ReadonlySet<number>; last: ReadonlyMap<number, string> }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** The last segment of a node's path, without its index, for example `endgame` or `0.guard` becomes `guard`. */
const segment = (n: CNode) => { const s = n.path.split('/').pop() ?? n.path; return s.replace(/^\d+\./, ''); };

/**
 * Gets the tree state of robot `robot` at trace frame `index`: the running nodes of that frame, and the last result of
 * every node that ended between the start of that tree and that frame. Null if the frame has no tree for the robot.
 */
export function treeStateAt(trace: Trace, index: number, robot: number): { tree: string; state: TreeState } | null {
  const bt = trace.frames[index]?.robots[robot]?.bt; if (!bt) return null;
  let start = index; while (start > 0 && trace.frames[start - 1].robots[robot]?.bt?.tree === bt.tree) start--;
  const last = new Map<number, string>();
  for (let k = start; k <= index; k++) for (const [node, code] of trace.frames[k].robots[robot].bt?.ended ?? []) last.set(node, code);
  return { tree: bt.tree, state: { running: new Set(bt.running), last } };
}

/** Reads a live recorder into a tree state. It keeps its place, so each call reads only the spans that ended since the last. */
export class LiveTreeState {
  private rec: Recorder | null = null; private seen = 0; private last = new Map<number, string>();
  read(rec: Recorder): TreeState {
    if (rec !== this.rec) { this.rec = rec; this.seen = 0; this.last = new Map(); }
    for (; this.seen < rec.closed.length; this.seen++) {
      const s = rec.closed[this.seen];
      this.last.set(s.node, s.result === 'success' ? 's' : s.result === 'failure' ? `f:${s.tag ?? ''}` : s.result === 'halted' ? 'h' : 'e');
    }
    return { running: new Set(rec.running().map(s => s.node)), last: this.last };
  }
}

export class TreePanel {
  private lastLeaf = ''; private lastHtml = '';
  constructor(private readonly body: HTMLElement, private readonly head: HTMLElement) {}

  /** Draws a tree, or a message when there is none. */
  paint(title: string, def: TreeDef | null, state: TreeState | null, message = 'No tree is running.') {
    this.head.textContent = title;
    if (!def || !state) { this.set(`<div class="tv-empty">${esc(message)}</div>`); this.lastLeaf = ''; return; }
    const rows: string[] = []; let deepest = '';
    const walk = (n: CNode, depth: number) => {
      const code = state.last.get(n.idx), running = state.running.has(n.idx);
      const cls = running ? 'run' : code === undefined ? '' : code === 's' ? 'ok' : code.startsWith('f') ? 'fail' : code === 'h' ? 'halt' : 'err';
      // A single child's path segment is its parent's key, such as `child`, which says nothing, so it isn't shown.
      const name = n.leaf ? n.label.replace(/^(auto|teleop)\./, '') : n.kind, id = segment(n), idText = id !== n.kind && id !== n.label && !['child', 'cleanup', 'otherwise'].includes(id) ? id : '';
      const result = running ? 'running' : code === undefined ? '' : code === 's' ? 'done' : code.startsWith('f:') ? code.slice(2) || 'failed' : code === 'h' ? 'halted' : 'error';
      if (running) deepest = n.path;
      rows.push(`<div class="tv ${cls}" data-path="${esc(n.path)}" style="padding-left:${6 + depth * 12}px"${n.note || n.detail ? ` title="${esc([n.detail, n.note].filter(Boolean).join('\n\n'))}"` : ''}>`
        // The result comes before the settings, so that a long setting can't hide it.
        + `<b class="${n.leaf ? 'leaf' : ''}">${esc(name)}</b>${idText ? ` <i>${esc(idText)}</i>` : ''}${result ? ` <em>${esc(result)}</em>` : ''}`
        + `${n.detail ? ` <span class="d">${esc(n.detail)}</span>` : ''}</div>`);
      n.children.forEach(c => walk(c, depth + 1));
    };
    walk(def.root, 0);
    this.set(rows.join(''));
    // Keep the running leaf in view when it changes, without fighting a reader who scrolls.
    if (deepest && deepest !== this.lastLeaf) this.body.querySelector(`[data-path="${CSS.escape(deepest)}"]`)?.scrollIntoView({ block: 'nearest' });
    this.lastLeaf = deepest;
  }

  /** Replaces the outline only when it changed, so that a tooltip under the pointer stays open and a click lands. */
  private set(html: string) { if (html !== this.lastHtml) { this.lastHtml = html; this.body.innerHTML = html; } }
}
