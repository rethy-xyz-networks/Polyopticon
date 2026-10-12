// Remembered entries for a text field (the live chat and stream fields): a list under the
// field with what was entered before, newest first, narrowed to what's typed. Each entry
// has a ✕ to forget it. ↑ / ↓ pick an entry, Enter uses it, Shift+Delete forgets it.
// Kept in ui.fieldHistory = { [key]: [value, …] }.

import { h } from './dom.js';
import { ui, saveUi } from './ui.js';

const MAX = 20;

const entries = key => ui.fieldHistory?.[key] ?? [];
const store = (key, list) => saveUi({ fieldHistory: { ...ui.fieldHistory, [key]: list } });

/** Puts a value at the top of a field's history. */
export function remember(key, value) {
  const v = String(value ?? '').trim();
  if (!v) return;
  store(key, [v, ...entries(key).filter(e => e.toLowerCase() !== v.toLowerCase())].slice(0, MAX));
}

function forget(key, value) { store(key, entries(key).filter(e => e !== value)); }

let list = null;          // the open dropdown: { el, input, items, at }

function close() {
  list?.el.remove();
  list = null;
}

/**
 * Shows a field's history under it while it has focus.
 *   keyOf()        the history to use (can change, e.g. with the chosen site)
 *   suggestions()  more values to offer, which aren't history and can't be removed
 *   onPick(value)  after an entry is chosen; default: submit the field's form
 */
export function attachHistory(input, { keyOf, suggestions = () => [], onPick = () => input.form?.requestSubmit() }) {
  const open = () => {
    const key = keyOf();
    const typed = input.value.trim().toLowerCase();
    const past = entries(key);
    const known = new Set(past.map(v => v.toLowerCase()));
    const items = [...past.map(value => ({ value, removable: true })),
                   ...suggestions().filter(v => !known.has(v.toLowerCase())).map(value => ({ value, removable: false }))]
      .filter(it => !typed || (it.value.toLowerCase().includes(typed) && it.value.toLowerCase() !== typed));
    close();
    if (!items.length) return;

    const pick = it => { input.value = it.value; close(); onPick(it.value); };
    const el = h('div', { class: 'field-history', role: 'listbox',
                          onpointerdown: e => e.preventDefault() },              // keep the focus in the field
      ...items.map(it => h('div', { class: 'fh-row', role: 'option', onclick: () => pick(it) },
        h('span', { class: 'fh-value' }, it.value),
        it.removable && h('button', { class: 'fh-x', title: 'Remove from history', 'aria-label': `Remove ${it.value} from history`,
          onclick: e => { e.stopPropagation(); forget(key, it.value); open(); } }, '✕'))));
    document.body.append(el);
    const r = input.getBoundingClientRect();
    el.style.left = `${r.left}px`;
    el.style.top = `${r.bottom + 2}px`;
    el.style.minWidth = `${r.width}px`;
    list = { el, input, items, at: -1, pick, key };
  };

  const highlight = at => {
    list.at = at;
    [...list.el.children].forEach((row, i) => row.classList.toggle('on', i === at));
    list.el.children[at]?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', () => { if (list?.input === input) close(); });
  input.addEventListener('keydown', e => {
    if (list?.input !== input) {
      if (e.key === 'ArrowDown') { open(); if (list) highlight(0); e.preventDefault(); }
      return;
    }
    const n = list.items.length;
    if (e.key === 'ArrowDown') highlight((list.at + 1) % n);
    else if (e.key === 'ArrowUp') highlight((list.at - 1 + n) % n);
    else if (e.key === 'Enter' && list.at >= 0) list.pick(list.items[list.at]);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Delete' && e.shiftKey && list.items[list.at]?.removable) {
      const at = list.at;
      forget(list.key, list.items[at].value);
      open();
      if (list) highlight(Math.min(at, list.items.length - 1));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

window.addEventListener('resize', close);
window.addEventListener('blur', close);              // e.g. a click into a webview
