// Source chips in the search bar: limit the feed (and History) to chosen news
// sites. Right-click a source in the sidebar, or a story's source badge, to
// add or remove it; several can be chosen (a story from any of them matches).

import { $, h } from './dom.js';
import { icon } from './icons.js';
import { state, sourceColor } from './state.js';

let onChange = () => {};

export function initSourceSearch({ changed }) {
  onChange = changed;
  const search = $('search');
  // Backspace in an empty search box removes the last chip, like a tag input.
  search.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !search.value && state.searchSources.size) {
      e.preventDefault();
      removeSearchSource([...state.searchSources].at(-1));
    }
  });
  renderSourceChips();
}

/** Right-click on a source: add it to the search, or take it out if it's already there. */
export function toggleSearchSource(id) {
  if (!state.sourcesById.has(id)) return;
  if (state.searchSources.has(id)) removeSearchSource(id);
  else { state.searchSources.add(id); changed(); }
}

export function removeSearchSource(id) {
  if (state.searchSources.delete(id)) changed();
}

export function clearSearchSources() {
  if (!state.searchSources.size) return false;
  state.searchSources.clear();
  changed();
  return true;
}

/** Drop chips for sources that were deleted or disabled. */
export function pruneSearchSources() {
  let n = 0;
  for (const id of state.searchSources) if (!state.sourcesById.get(id)?.enabled) { state.searchSources.delete(id); n++; }
  if (n) changed();
}

function changed() {
  renderSourceChips();
  onChange();
}

export function renderSourceChips() {
  const ids = [...state.searchSources];
  $('source-chips').replaceChildren(...ids.map(id => {
    const s = state.sourcesById.get(id);
    return h('span', { class: 'source-chip', style: `background:${sourceColor(id)}`, title: `Only stories from ${s?.name ?? 'this source'}; click the close button to remove` },
      h('span', { class: 'name' }, s?.name ?? '?'),
      h('button', { 'aria-label': `Remove ${s?.name ?? 'source'}`, onclick: () => removeSearchSource(id) }, icon('close')));
  }));
  $('source-chips').hidden = !ids.length;
  // Sidebar rows show which sources are in the search.
  for (const row of document.querySelectorAll('#source-groups .source'))
    row.classList.toggle('in-search', state.searchSources.has(Number(row.dataset.id)));
  const search = $('search');
  const base = state.mode === 'history' ? 'Search all saved text…' : 'Search titles…';
  search.placeholder = ids.length ? `${base.replace('…', '')} in ${ids.length === 1 ? 'this source' : `these ${ids.length} sources`}…` : `${base}  (Ctrl+F)`;
}
