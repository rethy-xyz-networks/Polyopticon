// Tab search (Ctrl+Shift+A), like Brave's: a box under the tab strip of the area last
// clicked (articles, live chat or streams) listing that area's open tabs, the current
// one first. Type to filter by title or site; Up / Down move the highlight, Enter or a
// click switches to the highlighted tab, × closes a tab, Esc or a click elsewhere
// closes the box. With nothing typed the highlight starts on the second tab, so
// Ctrl+Shift+A, Enter goes back to the previous one.

import { h } from './dom.js';
import { icon } from './icons.js';

let box = null;

/**
 * @param anchor  the area's tab-strip header: the box opens below it, at its right end
 * @param title   what the tabs are ("Article tabs")
 * @param tabs    () => [{ key, label, detail, icon?, pinned, active }], current tab first
 *                (called again after a tab is closed from the box)
 * @param select  key => void
 * @param close   key => void; pinned tabs aren't closed from the box
 */
export function openTabSearch({ anchor, title, tabs, select, close }) {
  if (box) { closeTabSearch(); return; }             // the shortcut again closes it
  let entries = tabs();
  let shown = [], highlight = 0;

  const input = h('input', { type: 'search', class: 'tab-search-input', spellcheck: 'false', autocomplete: 'off',
    placeholder: `Search ${entries.length} ${title.toLowerCase()}`, 'aria-label': `Search ${title.toLowerCase()}` });
  const list = h('ul', { class: 'tab-search-list', role: 'listbox' });
  const count = h('span', { class: 'muted' });
  box = h('div', { class: 'tab-search', role: 'dialog', 'aria-label': `Search ${title.toLowerCase()}` },
    h('div', { class: 'tab-search-head' }, h('b', {}, title), count),
    input, list,
    h('div', { class: 'tab-search-hint muted' }, 'Up / Down move · Enter switches · Esc closes'));

  const choose = e => { closeTabSearch(); select(e.key); };
  const paintHighlight = () => {
    [...list.children].forEach((li, i) => li.classList.toggle('on', i === highlight));
    list.children[highlight]?.scrollIntoView({ block: 'nearest' });
  };
  const fill = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = entries.filter(e => words.every(w => `${e.label} ${e.detail ?? ''}`.toLowerCase().includes(w)));
    highlight = !words.length && shown.length > 1 && shown[0].active ? 1 : 0;
    count.textContent = ` · ${entries.length} open`;
    list.replaceChildren(...(shown.length ? shown.map((e, i) =>
      h('li', { role: 'option', class: e.active ? 'current' : null, title: e.detail ? `${e.label}\n${e.detail}` : e.label,
        onmousedown: ev => ev.preventDefault(),          // keep the focus in the box
        onmousemove: () => { if (highlight !== i) { highlight = i; paintHighlight(); } },
        onclick: () => choose(e) },
        h('span', { class: 'tab-search-icon' }, e.icon ?? null),
        h('span', { class: 'tab-search-text' },
          h('span', { class: 'tab-search-label' }, ...marked(e.label, words)),
          e.detail && h('span', { class: 'tab-search-detail' }, ...marked(e.detail, words))),
        e.active && h('span', { class: 'tab-search-tag' }, 'current'),
        e.pinned ? h('span', { class: 'pin', title: 'Pinned' }, icon('pin'))
          : h('button', { class: 'icon-btn close', title: 'Close tab',
              onclick: ev => { ev.stopPropagation(); close(e.key); entries = tabs(); if (!entries.length) closeTabSearch(); else fill(); } }, icon('close'))))
      : [h('li', { class: 'tab-search-none muted' }, entries.length ? 'No tabs match' : 'No tabs open')]));
    paintHighlight();
  };

  input.addEventListener('input', fill);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (shown.length) highlight = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      paintHighlight();
    } else if (e.key === 'Enter') {
      if (shown[highlight]) choose(shown[highlight]);
    } else if (e.key === 'Escape') {
      closeTabSearch();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  // A click anywhere else, including into a page, takes the focus away.
  input.addEventListener('blur', () => setTimeout(() => { if (box && !box.contains(document.activeElement)) closeTabSearch(); }, 0));

  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const width = Math.min(460, Math.max(280, r.width - 16));
  box.style.width = `${width}px`;
  box.style.top = `${r.bottom + 4}px`;
  box.style.left = `${Math.max(8, Math.min(r.right - width - 8, innerWidth - width - 8))}px`;
  fill();
  input.focus();
}

export function closeTabSearch() {
  const b = box;
  box = null;
  b?.remove();
}

/** The text with each matched word in <mark>. */
function marked(text, words) {
  if (!words.length) return [text];
  const lower = text.toLowerCase();
  const hits = [];
  for (const w of words) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
  hits.sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const [s, e] of hits) {
    if (e <= at) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(h('mark', {}, text.slice(Math.max(s, at), e)));
    at = e;
  }
  out.push(text.slice(at));
  return out;
}
