/**
 * A one-line CodeMirror 6 field for an expression of the tree language: highlighting, completion from the
 * environment schema and the tree's definitions, and the checker's problems as you type. The settings panel loads this
 * module with `import()` only when the field editor shows an expression, so the page doesn't load CodeMirror before
 * then.
 *
 * The field edits text only. It sends the text back when it loses focus or on Enter, the same as the panel's plain
 * fields, so each edit is one step of the editor's undo. Escape puts the text back as it was.
 */
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { linter, type Diagnostic } from '@codemirror/lint';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { checkExpr, completeAt, type ExprContext, type Type } from '../bt';

const WORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'if', 'exists', 'coalesce']);

/** The expression language's tokens, for highlighting: numbers, strings, words, function names, field names, and operators. */
const exprLanguage = StreamLanguage.define<{ afterDot: boolean }>({
  startState: () => ({ afterDot: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i)) { state.afterDot = false; return 'number'; }
    if (stream.match(/^'[^']*'?/) || stream.match(/^"[^"]*"?/)) { state.afterDot = false; return 'string'; }
    const id = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/) as RegExpMatchArray | null;
    if (id) {
      const after = state.afterDot; state.afterDot = false;
      if (after) return 'propertyName';
      if (WORDS.has(id[0])) return 'keyword';
      return stream.peek() === '(' ? 'fn' : 'variableName';
    }
    const ch = stream.next(); state.afterDot = ch === '.';
    return ch && '+-*/%<>=!'.includes(ch) ? 'operator' : 'punctuation';
  },
  tokenTable: { fn: tags.function(tags.variableName) },
});

const highlight = HighlightStyle.define([
  { tag: tags.number, color: '#f78c6c' },
  { tag: tags.string, color: '#c3e88d' },
  { tag: tags.keyword, color: '#c792ea' },
  { tag: tags.function(tags.variableName), color: '#82aaff' },
  { tag: tags.variableName, color: '#e9ecf1' },
  { tag: tags.propertyName, color: '#ffcb6b' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.punctuation, color: '#98a1ae' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '12px', border: '1px solid rgba(255,255,255,.18)', borderRadius: '6px', background: 'rgba(0,0,0,.25)', marginTop: '2px' },
  '&.cm-focused': { outline: 'none', borderColor: '#ffa726' },
  '&.bad': { borderColor: '#ff8a80' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '3px 0', caretColor: '#e9ecf1' },
  '.cm-line': { padding: '0 6px' },
  '.cm-scroller': { overflowX: 'auto', scrollbarWidth: 'none' },
  '.cm-placeholder': { color: '#6b7380' },
  '.cm-tooltip': { background: '#1d2128', border: '1px solid rgba(255,255,255,.15)', color: '#e9ecf1' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'rgba(255,167,38,.3)', color: '#fff' },
  '.cm-completionDetail': { color: '#98a1ae', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid #ff8a80' },
}, { dark: true });

export interface ExprFieldOptions {
  /** The text as the tree writes it. */
  value: string;
  ctx: ExprContext;
  /** The type that the expression must give, such as a number for `timeoutSec`, or undefined for any type. */
  expected?: Type;
  disabled: boolean;
  placeholder: string;
  /** Gets the value of a name before the MATCH, as text, for the completion list, such as `-0.3237` for `field.hiveX`. */
  valueOf?: (path: string) => string | null | undefined;
  /** Called with the new text when the field loses focus or on Enter, if the text changed. */
  onCommit(text: string): void;
  /**
   * Called with the checker's problem as you type, or null when the expression checks. Text that matches what was
   * committed reports null, because the panel already shows the loader's problems with it.
   */
  onProblem?(message: string | null): void;
}

/** Replaces `input` with an expression field. Returns the editor view, which the caller destroys with the panel. */
export function mountExprField(input: HTMLElement, o: ExprFieldOptions): EditorView {
  let committed = o.value;
  const commit = (view: EditorView) => { const text = view.state.doc.toString(); if (text !== committed) { committed = text; o.onCommit(text); } };
  const complete = (c: CompletionContext): CompletionResult | null => {
    const r = completeAt(c.state.doc.toString(), c.pos, o.ctx); if (!r) return null;
    const word = c.state.doc.sliceString(r.from, c.pos);
    if (!word && !c.explicit && !/\.$/.test(c.state.doc.sliceString(0, c.pos))) return null;
    return {
      from: r.from, validFor: /^[A-Za-z0-9_]*$/,
      options: r.options.map(q => {
        const value = o.valueOf?.(q.path);
        return { label: q.label, type: q.kind === 'fn' ? 'function' : q.kind === 'def' ? 'variable' : q.kind === 'keyword' ? 'keyword' : 'property', detail: [q.type, value ? `= ${value}` : ''].filter(Boolean).join(' '), apply: q.kind === 'fn' || q.label === 'if' || q.label === 'exists' || q.label === 'coalesce' ? `${q.label}(` : q.label, boost: q.kind === 'keyword' ? -1 : 0 };
      }),
    };
  };
  const lint = (view: EditorView): Diagnostic[] => {
    const text = view.state.doc.toString();
    if (!text.trim()) { o.onProblem?.(null); view.dom.classList.remove('bad'); return []; }
    const r = checkExpr(text, o.ctx, o.expected);
    const bad = 'message' in r; view.dom.classList.toggle('bad', bad); o.onProblem?.(bad && text !== committed ? r.message : null);
    if (!bad) return [];
    // Mark the name or the character where the problem starts. A problem at the end marks the last character.
    const from = Math.max(0, Math.min(r.pos, text.length - 1)), word = /^[A-Za-z0-9_.]+/.exec(text.slice(from))?.[0].length ?? 1;
    return [{ from, to: Math.min(text.length, from + word), severity: 'error', message: r.message }];
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: o.value,
      extensions: [
        // One line: a newline, typed or pasted, never enters the text.
        EditorState.transactionFilter.of(tr => (tr.newDoc.lines > 1 ? [] : tr)),
        EditorState.readOnly.of(o.disabled), EditorView.editable.of(!o.disabled),
        history(), exprLanguage, syntaxHighlighting(highlight), theme, placeholder(o.placeholder),
        autocompletion({ override: [complete], icons: false }),
        linter(lint, { delay: 150 }),
        // Enter accepts a completion when the list is open, because the completion keymap comes first. Otherwise it
        // commits the field, and Escape puts the text back.
        Prec.high(keymap.of([
          // Leaving the field commits it, in the blur handler, so that the panel's redraw finds no focus to restore.
          { key: 'Enter', run: v => { v.contentDOM.blur(); return true; } },
          { key: 'Escape', run: v => { v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: committed } }); v.contentDOM.blur(); return true; } },
        ])),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        EditorView.domEventHandlers({ blur: (_e, v) => { commit(v); return false; } }),
      ],
    }),
  });
  view.dom.dataset.field = input.dataset.field ?? '';
  input.replaceWith(view.dom);
  return view;
}
