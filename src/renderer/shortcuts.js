// Every keyboard shortcut and mouse action, in one place. This list drives:
//   • the shortcut list (Ctrl+? or the ? button), opened as a tab
//   • which keys the app handles (entries with `combos` and a handler from app.js)
//   • which keys main forwards from article and chat pages (combos unless `inPages: false`)
// Add new shortcuts here — never handle a key elsewhere without listing it.
//
// Fields:  id       handler name (app.js registerShortcuts) — only for entries with combos
//          combos   key names as comboName() produces them: 'ctrl+w', 'alt+3', 'shift+r'
//          keys     what the list shows: alternatives, each an array of key caps
//          does     what it does
//          typing   false = ignored while typing in a text box (default: works everywhere)
//          inPages  false = not forwarded from article/chat pages (would break typing there)
// Entries without combos are handled where they apply (story list, search box, mouse)
// and appear in the list only.

import { h } from './dom.js';

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const SHORTCUTS = [
  { group: 'General', items: [
    { id: 'help',    combos: ['ctrl+?', 'ctrl+/'], keys: [['Ctrl', '?']], does: 'Show this list of shortcuts' },
    { id: 'refresh', combos: ['shift+r'], keys: [['Shift', 'R']], does: 'Refresh all sources', typing: false, inPages: false },
    { id: 'search',  combos: ['ctrl+f'], keys: [['Ctrl', 'F']], does: 'Search the stories' },
    { id: 'mode',    combos: ['ctrl+h'], keys: [['Ctrl', 'H']], does: 'Switch between Live and History' },
    { id: 'map',     combos: ['ctrl+m'], keys: [['Ctrl', 'M']], does: 'Show or hide the map' },
    { id: 'chat',    combos: ['ctrl+j'], keys: [['Ctrl', 'J']], does: 'Show or hide the live chat' },
    // Ctrl+V is paste: ignored in text boxes and pages, so pasting still works there.
    { id: 'video',   combos: ['ctrl+v'], keys: [['Ctrl', 'V']], does: 'Show or hide the video player (not while typing or in a page)', typing: false, inPages: false },
    { id: 'settings', combos: ['ctrl+,'], keys: [['Ctrl', ',']], does: 'Open or close Settings' },
    { id: 'fullscreen', combos: ['f11'], keys: [['F11']], does: 'Full screen (again to leave)' },
    { keys: [['Esc']], does: 'Close settings · clear the story search (again: remove the source chips) · clear the source finder' },
  ] },
  // All but back / forward act on the tabs of the area last clicked: articles, live chat, or the streams below it.
  { group: 'Tabs', items: [
    { id: 'nextTab',  combos: ['ctrl+pagedown'], keys: [['Ctrl', 'PgDown']], does: 'Next tab (wraps around) — in the articles, chat or streams, whichever you last clicked' },
    { id: 'prevTab',  combos: ['ctrl+pageup'], keys: [['Ctrl', 'PgUp']], does: 'Previous tab (wraps around) — same' },
    { id: 'tabN',     combos: DIGITS.map(n => `alt+${n}`), keys: [['Alt', '1 … 9']], does: 'Go to tab 1–9, counting after the pinned tabs — same' },
    { id: 'closeTab', combos: ['ctrl+w'], keys: [['Ctrl', 'W']], does: 'Close the current tab (pinned tabs stay open) — same' },
    { id: 'pinTab',   combos: ['ctrl+p'], keys: [['Ctrl', 'P']], does: 'Pin or unpin the current tab — same' },
    { id: 'searchTabs', combos: ['ctrl+shift+a'], keys: [['Ctrl', 'Shift', 'A']], does: 'Search the open tabs and switch to one (↑ ↓, Enter) — same' },
    { id: 'back',     combos: ['alt+arrowleft'], keys: [['Alt', '←']], does: 'Back, in the current article tab’s page' },
    { id: 'reload',   combos: ['ctrl+r'], keys: [['Ctrl', 'R']], does: 'Reload the current tab’s page — same' },
    { id: 'forward',  combos: ['alt+arrowright'], keys: [['Alt', '→']], does: 'Forward, in the current article tab’s page' },
    { id: 'livePage', combos: ['ctrl+l'], keys: [['Ctrl', 'L']], does: 'Show the live page of the current tab' },
    { id: 'savedPage', combos: ['ctrl+s'], keys: [['Ctrl', 'S']], does: 'Show the saved page of the current tab (saves it first if needed)' },
    { id: 'screenshot', combos: ['ctrl+shift+s'], keys: [['Ctrl', 'Shift', 'S']], does: 'Screenshot of the whole page: copied to the clipboard and saved as a picture' },
    { id: 'zoomIn',    combos: ['ctrl+=', 'ctrl++'], keys: [['Ctrl', '+']], does: 'Zoom in on pages (all tabs)' },
    { id: 'zoomOut',   combos: ['ctrl+-'], keys: [['Ctrl', '−']], does: 'Zoom out on pages (all tabs)' },
    { id: 'zoomReset', combos: ['ctrl+0'], keys: [['Ctrl', '0']], does: 'Reset the page zoom to 100%' },
  ] },
  { group: 'Story list', items: [
    { keys: [['↑'], ['↓']], does: 'Move through the stories' },
    { keys: [['Home'], ['End']], does: 'First / last story' },
    { keys: [['Enter']], does: 'Open the selected story in a tab' },
    { keys: [['Ctrl', 'Enter']], does: 'Open the selected story in your browser' },
    { keys: [['Backspace']], does: 'In an empty search box: remove the last source chip' },
  ] },
  { group: 'Mouse', items: [
    { keys: [['Double-click'], ['Middle-click']], does: 'Open a story in a tab' },
    { keys: [['Ctrl', 'Click']], does: 'Open a story in your browser' },
    { keys: [['Ctrl', 'Wheel']], does: 'Over a page: zoom in / out (all tabs)' },
    { keys: [['Right-click']], does: 'On a source or a story’s source badge: search only that source (again to remove)' },
    { keys: [['Middle-click']], does: 'On a tab: close it (pinned tabs stay open)' },
    { keys: [['Right-click']], does: 'On a tab: pin, open in browser, close others / to the right' },
    { keys: [['Drag']], does: 'A tab: reorder it' },
  ] },
];

const ENTRIES = SHORTCUTS.flatMap(g => g.items);

/**
 * 'ctrl+w', 'alt+3', 'shift+r', 'ctrl+?', 'f11' … for a key event; null for a bare key other than F1–F24.
 * Symbols such as ? already include Shift, so Shift isn't named for them.
 * (main.js has a copy for keys pressed inside article and chat pages — keep them alike.)
 */
export function comboName({ key, ctrlKey, altKey, shiftKey, metaKey }) {
  if (metaKey || !key || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(key)) return null;
  const symbol = key.length === 1 && !/[\p{L}\p{N}]/u.test(key);
  const parts = [ctrlKey && 'ctrl', altKey && 'alt', shiftKey && !symbol && 'shift', key.toLowerCase()].filter(Boolean);
  return parts.length > 1 || /^F\d{1,2}$/.test(key) ? parts.join('+') : null;   // function keys work on their own
}

/** Combos that main should catch inside article and chat pages. */
export const pageCombos = () => ENTRIES.filter(e => e.combos && e.inPages !== false).flatMap(e => e.combos);

let handlers = {};

/** app.js supplies what each shortcut does, by id. Entries with combos but no handler are reported. */
export function registerShortcuts(map) {
  handlers = map;
  const missing = ENTRIES.filter(e => e.combos && !handlers[e.id]).map(e => e.id);
  if (missing.length) console.error(`Shortcuts without a handler: ${missing.join(', ')}`);
}

/** Runs the shortcut for a combo; true if one ran. */
export function runShortcut(combo, { typing = false } = {}) {
  if (!combo) return false;
  const entry = ENTRIES.find(e => e.combos?.includes(combo));
  if (!entry || (typing && entry.typing === false) || !handlers[entry.id]) return false;
  handlers[entry.id](combo);
  return true;
}

// The list itself (shown in a tab)

const keyCaps = alternatives => h('span', { class: 'keys' },
  ...alternatives.flatMap((caps, i) => [
    i > 0 && h('span', { class: 'or' }, 'or'),
    ...caps.flatMap((cap, j) => [j > 0 && h('span', { class: 'plus' }, '+'), h('kbd', {}, cap)]),
  ]));

/**
 * Does a shortcut match every word of the search? "zoom", "ctrl w", "ctrl+shift+s", "tab close".
 * A one-character word ("w", "+", "0") must be one of its keys, or it would match nearly everything.
 */
function matches(e, group, words) {
  const caps = e.keys.flat().map(c => c.toLowerCase());
  const text = `${e.does} ${group} ${caps.join(' ')}`.toLowerCase();
  const isKey = w => caps.includes(w) || (/^[1-9]$/.test(w) && caps.includes('1 … 9'));
  return words.every(w => (w.length === 1 ? isKey(w) : text.includes(w)));
}

const searchWords = q => q.toLowerCase().split(/\s+|(?<=.)\+(?=.)/).filter(Boolean);

/** The list, with a search box. Built once per tab, so switching away and back keeps the search. */
export function renderShortcutList(el, tabId) {
  if (el.dataset.tab === String(tabId)) return;
  el.dataset.tab = tabId;
  const notInPages = ENTRIES.filter(e => e.combos && e.inPages === false).map(e => e.keys[0].join(' + '));
  const search = h('input', { type: 'search', class: 'shortcut-search', placeholder: 'Search shortcuts — e.g. zoom, tab, Ctrl W',
    spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search shortcuts' });
  const none = h('p', { class: 'muted shortcut-none', hidden: true }, 'No shortcuts match.');
  const sections = SHORTCUTS.map(g => {
    const rows = g.items.map(e => ({ e, tr: h('tr', {}, h('td', {}, keyCaps(e.keys)), h('td', {}, e.does)) }));
    return { g, rows, el: h('section', {}, h('h2', {}, g.group), h('table', { class: 'shortcut-table' }, ...rows.map(r => r.tr))) };
  });
  const filter = () => {
    const words = searchWords(search.value);
    let shown = 0;
    for (const s of sections) {
      let n = 0;
      for (const r of s.rows) { const ok = matches(r.e, s.g.group, words); r.tr.hidden = !ok; n += ok; }
      s.el.hidden = !n;
      shown += n;
    }
    none.hidden = shown > 0;
  };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', e => {                    // Esc clears the search, then leaves it
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (search.value) { search.value = ''; filter(); } else search.blur();
  });
  el.replaceChildren(h('div', { class: 'shortcut-page' },
    h('h1', {}, 'Keyboard shortcuts'),
    h('p', { class: 'muted' }, `Shortcuts also work while an article or chat has focus, except ${notInPages.join(' and ')}.`),
    search, none,
    ...sections.map(s => s.el)));
}
