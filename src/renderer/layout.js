// Showing and hiding the Sources & Filters View (the sidebar) and the Article List View (the feed),
// from their toolbar buttons and shortcuts. The choice is kept in ui.json (sidebarHidden, listHidden).
// A hidden pane keeps its content (scroll position, search, open groups): its grid column shrinks
// to nothing and it becomes invisible. The Article View takes the room. Searching the stories
// (Ctrl+F) or switching Live / History (Ctrl+H) brings the list back.

import { $ } from './dom.js';
import { ui, saveUi } from './ui.js';

const PANES = {
  sidebar: { cls: 'no-sidebar', key: 'sidebarHidden', btn: 'btn-sidebar', name: 'Sources & Filters', sel: '.pane.sidebar', keys: 'Ctrl+Shift+F' },
  list:    { cls: 'no-list',    key: 'listHidden',    btn: 'btn-list',    name: 'Article List',      sel: '.pane.feed',    keys: 'Ctrl+Shift+E' },
};

const paneShown = which => !$('panes').classList.contains(PANES[which].cls);

function setPaneShown(which, show) {
  const p = PANES[which];
  $('panes').classList.toggle(p.cls, !show);
  const b = $(p.btn);
  b.classList.toggle('on', show);
  b.title = `${show ? 'Hide' : 'Show'} the ${p.name} (${p.keys})`;
  b.setAttribute('aria-pressed', String(show));
  if (!!ui[p.key] !== !show) saveUi({ [p.key]: !show });
  // A hidden pane mustn't keep the keyboard (e.g. arrow keys moving through a list you can't see).
  if (!show && document.activeElement?.closest?.(p.sel)) document.activeElement.blur();
}

export const togglePane = which => setPaneShown(which, !paneShown(which));

/** Shows the Article List View if it's hidden (before searching it or switching Live / History). */
export function revealList() { if (!paneShown('list')) setPaneShown('list', true); }

/** At start: the panes as they were left. */
export function initLayout() {
  setPaneShown('sidebar', !ui.sidebarHidden);
  setPaneShown('list', !ui.listHidden);
}
