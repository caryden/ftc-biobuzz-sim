/**
 * The field editor's settings panel: the plan's problems, a form for the selected step's parameters, and the plan's
 * definitions. It draws what `FieldEditor` gives it, and sends each edit back as text. A text field sends its edit when
 * it loses focus or on Enter, so an edit is one step of undo. Escape puts the field back as it was.
 */
import type { DefRow, ParamField, Problems } from '../auto/draft';

export interface InspectorModel {
  editing: boolean;
  problems: Problems;
  /** The selected node's path, or null. */
  path: string | null;
  node: { label: string; id: string; doc: string | null; leaf: boolean; detail?: string } | null;
  fields: ParamField[] | null;
  defs: (DefRow & { value: string | null })[];
  /** The selected reference point, whose definition row is marked. */
  selectedDef: string | null;
}

export interface InspectorActions {
  setParam(path: string, key: string, text: string): void;
  setDef(name: string, text: string): void;
  /** Returns a problem to show, or null. */
  addDef(name: string, text: string): string | null;
  /** Returns a problem to show, or null. */
  deleteDef(name: string): string | null;
  selectNode(path: string): void;
  selectDef(name: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Writes inline code in a doc string, such as `timeoutSec`, as code. */
const doc = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export class Inspector {
  private key = ''; private addError = ''; private rowError = new Map<string, string>();

  constructor(private readonly root: HTMLElement, private readonly act: InspectorActions) {
    // The page's keys, such as Enter to start the match, mustn't fire while you type in a field.
    for (const ev of ['keydown', 'keyup']) root.addEventListener(ev, e => { if ((e.target as HTMLElement).closest('input, select, textarea')) e.stopPropagation(); });
    root.addEventListener('keydown', e => {
      const el = e.target as HTMLInputElement; if (el.tagName !== 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); if (el.dataset.add !== undefined) this.add(); else el.blur(); }
      if (e.key === 'Escape') { el.value = el.defaultValue; el.blur(); }
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
      const del = t.closest<HTMLElement>('[data-del]'); if (del) { const err = this.act.deleteDef(del.dataset.del!); if (err) this.rowError.set(del.dataset.del!, err); else this.rowError.delete(del.dataset.del!); this.key = ''; this.repaint(); return; }
      if (t.closest('[data-addbtn]')) this.add();
    });
  }

  private model: InspectorModel | null = null;

  /** Draws the panel. `key` changes whenever the plan, the selection, or the editing state changes; the panel redraws only then, so that a field you type in keeps its text. */
  paint(model: InspectorModel, key: string) {
    this.model = model; if (key === this.key) return;
    if (key.split('|')[0] !== this.key.split('|')[0]) { this.rowError.clear(); this.addError = ''; }
    this.key = key; this.repaint();
  }

  private add() {
    const name = this.root.querySelector<HTMLInputElement>('[data-add="name"]'), src = this.root.querySelector<HTMLInputElement>('[data-add="src"]');
    if (!name || !src) return;
    const err = this.act.addDef(name.value, src.value); this.addError = err ?? '';
    if (err) { this.key = ''; const keep = [name.value, src.value]; this.repaint(); const n = this.root.querySelector<HTMLInputElement>('[data-add="name"]'), s = this.root.querySelector<HTMLInputElement>('[data-add="src"]'); if (n && s) { [n.value, s.value] = keep; } }
  }

  private repaint() {
    const m = this.model; if (!m) return;
    // Keep the focus in the same field across a redraw.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.field;
    const off = m.editing ? '' : ' disabled';
    const parts: string[] = [];

    const p = m.problems;
    if (p.count) {
      const items: string[] = p.tree.map(t => `<li>${esc(t)}</li>`);
      for (const [path, list] of p.nodes) for (const q of list) items.push(`<li data-go="n:${esc(path)}"><b>${esc(path.split('/').pop()!)}</b>${q.param ? ` · <code>${esc(q.param)}</code>` : ''}: ${esc(q.message)}</li>`);
      for (const [name, list] of p.defs) for (const q of list) items.push(`<li data-go="d:${esc(name)}"><b>${esc(name)}</b>: ${esc(q)}</li>`);
      parts.push(`<section class="ai-problems"><h3>${p.count} problem${p.count === 1 ? '' : 's'}</h3><p>This plan doesn't run until you fix ${p.count === 1 ? 'it' : 'them'}: its robot stays still in AUTO.</p><ul>${items.join('')}</ul></section>`);
    }

    parts.push('<section class="ai-step"><h3>Step</h3>');
    if (!m.node) parts.push('<p class="ai-hint">Click a step in the tree or on the FIELD to see its settings.</p>');
    else {
      parts.push(`<div class="ai-node"><b>${esc(m.node.label)}</b> <i>${esc(m.node.id)}</i></div>`);
      if (m.node.doc) parts.push(`<p class="ai-doc">${doc(m.node.doc)}</p>`);
      const own = m.path ? p.nodes.get(m.path) ?? [] : [];
      for (const q of own.filter(q => !q.param || !m.fields?.some(f => f.key === q.param))) parts.push(`<div class="ai-err">${esc(q.message)}</div>`);
      if (!m.fields) parts.push(`<p class="ai-hint">${m.node.detail ? `<code>${esc(m.node.detail)}</code>. ` : ''}The settings of this node type can't be edited here yet.</p>`);
      else for (const f of m.fields) {
        const errs = own.filter(q => q.param === f.key), bad = errs.length ? ' bad' : '';
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
          control = `<div class="ai-ro">${n} point${n === 1 ? '' : 's'}${m.editing ? ' · drag them on the FIELD' : ''}</div>`;
        } else {
          const ph = f.required ? 'required' : `default: ${f.defaultText}`;
          control = `<input type="text" spellcheck="false" data-field="p:${esc(f.key)}" class="${f.control === 'text' ? '' : 'mono'}${bad}" value="${esc(f.text)}" placeholder="${esc(ph)}"${off}>`;
        }
        parts.push(`<div class="ai-field"><label><code>${esc(f.key)}</code>${f.required ? ' <span class="ai-req">required</span>' : ''}</label>${control}`
          + errs.map(q => `<div class="ai-err">${esc(q.message)}</div>`).join('')
          + `<div class="ai-meta">${esc(meta)}</div>${f.doc ? `<div class="ai-doc">${doc(f.doc)}</div>` : ''}</div>`);
      }
    }
    parts.push('</section>');

    parts.push('<section class="ai-defs"><h3>Definitions</h3><p class="ai-hint">Names that the steps and other definitions use. A purple dot on the FIELD is a definition whose value is a pose.</p>');
    for (const d of m.defs) {
      const errs = p.defs.get(d.name) ?? [], rowErr = this.rowError.get(d.name);
      parts.push(`<div class="ai-def${d.name === m.selectedDef ? ' sel' : ''}"><div class="ai-defhead"><code data-go="d:${esc(d.name)}" class="${d.pose ? 'pose' : ''}">${esc(d.name)}</code>`
        + `<span class="ai-val">${d.value === null ? '' : `= ${esc(d.value)}`}</span>${m.editing ? `<button data-del="${esc(d.name)}" title="Deletes this definition. Steps that are this pose, or an offset from it, keep their places.">Delete</button>` : ''}</div>`
        + `<input type="text" spellcheck="false" class="mono${errs.length ? ' bad' : ''}" data-field="d:${esc(d.name)}" value="${esc(d.text)}"${off}>`
        + [...errs, ...(rowErr ? [rowErr] : [])].map(q => `<div class="ai-err">${esc(q)}</div>`).join('') + '</div>');
    }
    if (m.editing) parts.push(`<div class="ai-add"><input type="text" spellcheck="false" data-add="name" placeholder="name"><input type="text" spellcheck="false" class="mono" data-add="src" placeholder="expression, such as 0.5"><button data-addbtn>Add</button></div>${this.addError ? `<div class="ai-err">${esc(this.addError)}</div>` : ''}`);
    parts.push('</section>');

    this.root.innerHTML = parts.join('');
    if (focused) this.root.querySelector<HTMLElement>(`[data-field="${CSS.escape(focused)}"]`)?.focus();
    if (m.selectedDef) this.root.querySelector('.ai-def.sel')?.scrollIntoView({ block: 'nearest' });
  }
}
