/**
 * The field editor's settings panel. It shows the plan's problems and then the selection: a form for the selected
 * step's parameters, the selected definition, or the form that adds a definition. The tree view lists the definitions,
 * at the root. The panel draws what `FieldEditor` gives it, and sends each edit back as text. A text field sends its
 * edit when it loses focus or on Enter, so an edit is one step of undo. Escape puts the field back as it was.
 */
import type { DefRow, ParamField, Problems } from '../auto/draft';

export interface InspectorModel {
  editing: boolean;
  problems: Problems;
  /** The selected node's path, or null. */
  path: string | null;
  node: { label: string; id: string; doc: string | null; leaf: boolean; detail?: string } | null;
  fields: ParamField[] | null;
  /** The selected definition, with the steps and definitions that use it. */
  def: (DefRow & { value: string | null; users: string[] }) | null;
  /** True while the panel shows the form that adds a definition. */
  adding: boolean;
}

export interface InspectorActions {
  setParam(path: string, key: string, text: string): void;
  setDef(name: string, text: string): void;
  /** Returns a problem to show, or null. */
  addDef(name: string, text: string): string | null;
  cancelAdd(): void;
  /** Returns a problem to show, or null. */
  deleteDef(name: string): string | null;
  selectNode(path: string): void;
  selectDef(name: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Writes inline code in a doc string, such as `timeoutSec`, as code. */
const doc = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export class Inspector {
  private key = ''; private error = '';
  private model: InspectorModel | null = null;

  constructor(private readonly root: HTMLElement, private readonly act: InspectorActions) {
    // The page's keys, such as Enter to start the match, mustn't fire while you type in a field.
    for (const ev of ['keydown', 'keyup']) root.addEventListener(ev, e => { if ((e.target as HTMLElement).closest('input, select, textarea')) e.stopPropagation(); });
    root.addEventListener('keydown', e => {
      const el = e.target as HTMLInputElement; if (el.tagName !== 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); if (el.dataset.add !== undefined) this.add(); else el.blur(); }
      if (e.key === 'Escape') { if (el.dataset.add !== undefined) this.act.cancelAdd(); else { el.value = el.defaultValue; el.blur(); } }
    });
    root.addEventListener('change', e => {
      const el = e.target as HTMLInputElement | HTMLSelectElement, f = el.dataset.field; if (!f) return;
      const [kind, ...rest] = f.split(':'), name = rest.join(':');
      if (kind === 'p' && this.model?.path) this.act.setParam(this.model.path, name, el.value);
      if (kind === 'd') this.act.setDef(name, el.value);
    });
    root.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const go = t.closest<HTMLElement>('[data-go]'); if (go) { const [k, ...v] = go.dataset.go!.split(':'); if (k === 'n') this.act.selectNode(v.join(':')); else this.act.selectDef(v.join(':')); return; }
      const del = t.closest<HTMLElement>('[data-del]'); if (del) { this.error = this.act.deleteDef(del.dataset.del!) ?? ''; this.key = ''; this.repaint(); return; }
      if (t.closest('[data-addbtn]')) this.add();
      if (t.closest('[data-cancel]')) this.act.cancelAdd();
    });
  }

  /** Draws the panel. `key` changes whenever the plan, the selection, or the editing state changes; the panel redraws only then, so that a field you type in keeps its text. */
  paint(model: InspectorModel, key: string) {
    this.model = model; if (key === this.key) return;
    this.error = ''; this.key = key; this.repaint();
  }

  private add() {
    const name = this.root.querySelector<HTMLInputElement>('[data-add="name"]'), src = this.root.querySelector<HTMLInputElement>('[data-add="src"]');
    if (!name || !src) return;
    const keep = [name.value, src.value], err = this.act.addDef(keep[0], keep[1]);
    if (!err) return;
    // The add failed, so the form stays, with what you typed and the problem.
    this.error = err; this.key = ''; this.repaint();
    const n = this.root.querySelector<HTMLInputElement>('[data-add="name"]'), s = this.root.querySelector<HTMLInputElement>('[data-add="src"]');
    if (n && s) { [n.value, s.value] = keep; n.focus(); }
  }

  private repaint() {
    const m = this.model; if (!m) return;
    // Keep the focus in the same field across a redraw.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.field;
    const off = m.editing ? '' : ' disabled', p = m.problems, parts: string[] = [];
    const err = (list: readonly string[]) => list.map(q => `<div class="ai-err">${esc(q)}</div>`).join('');

    if (p.count) {
      const items: string[] = p.tree.map(t => `<li>${esc(t)}</li>`);
      for (const [path, list] of p.nodes) for (const q of list) items.push(`<li data-go="n:${esc(path)}"><b>${esc(path.split('/').pop()!)}</b>${q.param ? ` · <code>${esc(q.param)}</code>` : ''}: ${esc(q.message)}</li>`);
      for (const [name, list] of p.defs) for (const q of list) items.push(`<li data-go="d:${esc(name)}"><b>${esc(name)}</b>: ${esc(q)}</li>`);
      parts.push(`<section class="ai-problems"><h3>${p.count} problem${p.count === 1 ? '' : 's'}</h3><p>This plan doesn't run until you fix ${p.count === 1 ? 'it' : 'them'}: its robot stays still in AUTO.</p><ul>${items.join('')}</ul></section>`);
    }

    if (m.adding) {
      parts.push('<section><h3>New definition</h3><p class="ai-hint">A name that the steps and other definitions can use, such as <code>backOff</code> for <code>0.25</code>, or a pose such as <code>pose(-1.2, 0.6, 180)</code>, which is also a reference point on the FIELD.</p>'
        + '<div class="ai-field"><label>Name</label><input type="text" spellcheck="false" data-add="name" placeholder="backOff"></div>'
        + '<div class="ai-field"><label>Expression</label><input type="text" spellcheck="false" class="mono" data-add="src" placeholder="0.25"></div>'
        + `${err(this.error ? [this.error] : [])}<div class="ai-btns"><button data-addbtn class="primary">Add</button><button data-cancel>Cancel</button></div></section>`);
    } else if (m.def) {
      const d = m.def, errs = p.defs.get(d.name) ?? [];
      parts.push(`<section><h3>Definition</h3><div class="ai-node"><b class="${d.pose ? 'pose' : ''}">${esc(d.name)}</b></div>`
        + `<div class="ai-field"><input type="text" spellcheck="false" class="mono${errs.length ? ' bad' : ''}" data-field="d:${esc(d.name)}" value="${esc(d.text)}"${off}>${err(errs)}`
        + `<div class="ai-meta">${esc([d.value === null ? 'no value' : `= ${d.value} before the MATCH`, d.typeText].filter(Boolean).join(' · '))}</div></div>`
        + (d.pose ? `<p class="ai-hint">A pose, so it is a reference point on the FIELD: the purple dot.${m.editing ? ' Drag it to move every step that names it.' : ''}</p>` : '')
        + `<p class="ai-hint">${d.users.length ? `Used by ${d.users.map(u => `<code>${esc(u)}</code>`).join(', ')}.` : 'Nothing uses it.'}</p>`
        + (m.editing ? `${err(this.error ? [this.error] : [])}<div class="ai-btns"><button data-del="${esc(d.name)}" title="Steps that are this pose, or an offset from it, keep their places.">Delete</button></div>` : '')
        + '</section>');
    } else if (m.node) {
      parts.push(`<section><h3>Step</h3><div class="ai-node"><b>${esc(m.node.label)}</b> <i>${esc(m.node.id)}</i></div>`);
      if (m.node.doc) parts.push(`<p class="ai-doc">${doc(m.node.doc)}</p>`);
      const own = m.path ? p.nodes.get(m.path) ?? [] : [];
      parts.push(err(own.filter(q => !q.param || !m.fields?.some(f => f.key === q.param)).map(q => q.message)));
      if (!m.fields) parts.push(`<p class="ai-hint">${m.node.detail ? `<code>${esc(m.node.detail)}</code>. ` : ''}The settings of this node type can't be edited here yet.</p>`);
      else for (const f of m.fields) parts.push(this.field(f, own.filter(q => q.param === f.key).map(q => q.message), off, m.editing));
      parts.push('</section>');
    } else parts.push(`<p class="ai-hint">Click a step or a definition in the tree, or a handle on the FIELD, to see its settings.</p>`);

    this.root.innerHTML = parts.join('');
    if (focused) this.root.querySelector<HTMLElement>(`[data-field="${CSS.escape(focused)}"]`)?.focus();
    if (m.adding && !focused) this.root.querySelector<HTMLInputElement>('[data-add="name"]')?.focus();
  }

  /** Draws one parameter's field: its name, its control, its problems, its type and limits, and its doc. */
  private field(f: ParamField, errs: string[], off: string, editing: boolean): string {
    const bad = errs.length ? ' bad' : '';
    const limits = f.min !== undefined && f.max !== undefined ? `from ${f.min} to ${f.max}` : f.min !== undefined ? `at least ${f.min}` : f.max !== undefined ? `at most ${f.max}` : '';
    const meta = [f.typeText + (f.unit ? ` in ${f.unit}` : ''), limits, f.live ? 'checked on every step' : ''].filter(Boolean).join(' · ');
    let control: string;
    if (f.control === 'enum') {
      const opts = [f.required ? '' : `<option value=""${f.text === '' ? ' selected' : ''}>default: ${esc(f.defaultText ?? '')}</option>`,
        f.nullable && !(f.defaultText === 'null' && !f.required) ? `<option value="null"${f.text === 'null' ? ' selected' : ''}>null</option>` : '',
        f.required && f.text === '' ? '<option value="" selected>choose one</option>' : '',
        ...(f.values ?? []).map(v => `<option value="${esc(v)}"${f.text === v ? ' selected' : ''}>${esc(v)}</option>`)];
      control = `<select data-field="p:${esc(f.key)}" class="${bad}"${off}>${opts.join('')}</select>`;
    } else if (f.control === 'list') {
      const n = (() => { try { return (JSON.parse(f.text || '[]') as unknown[]).length; } catch { return 0; } })();
      control = `<div class="ai-ro">${n} point${n === 1 ? '' : 's'}${editing ? ' · drag them on the FIELD' : ''}</div>`;
    } else {
      const ph = f.required ? 'required' : `default: ${f.defaultText}`;
      control = `<input type="text" spellcheck="false" data-field="p:${esc(f.key)}" class="${f.control === 'text' ? '' : 'mono'}${bad}" value="${esc(f.text)}" placeholder="${esc(ph)}"${off}>`;
    }
    return `<div class="ai-field"><label><code>${esc(f.key)}</code>${f.required ? ' <span class="ai-req">required</span>' : ''}</label>${control}`
      + errs.map(q => `<div class="ai-err">${esc(q)}</div>`).join('')
      + `<div class="ai-meta">${esc(meta)}</div>${f.doc ? `<div class="ai-doc">${doc(f.doc)}</div>` : ''}</div>`;
  }
}
