// Layout and view state that survives restarts (stored by main in ui.json):
//   panes          { '--w-sidebar': px, '--w-feed': px }
//   hiddenSources  [source id]           unticked in the sidebar
//   mode           'live' | 'history'
//   historyScope   'opened' | 'all'
//   autoScroll, caseSensitive   booleans
//   mapWindow      '1h' | '6h' | '24h' | 'All'
//   fieldHistory   { [field key]: [value, …] }   past entries of the chat / stream fields (fieldhistory.js)
// The window's size and position are kept by main itself.

import { api } from './dom.js';

export const ui = {};

export function loadUi(saved) {
  Object.assign(ui, saved && typeof saved === 'object' ? saved : {});
  // Pane widths used to live in localStorage; carry them over once.
  if (!ui.panes) {
    try {
      const old = JSON.parse(localStorage.getItem('pane-widths') || 'null');
      if (old && typeof old === 'object') saveUi({ panes: old });
    } catch { /* storage unavailable */ }
  }
}

export function saveUi(patch) {
  Object.assign(ui, patch);
  api.saveUi(patch);
}
