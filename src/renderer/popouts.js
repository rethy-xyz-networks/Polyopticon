// Popped-out tabs, as the main window sees them: which tabs are floating in windows of their own
// (main/popout.js opens the windows; popout.html / popout.js is the page inside). A tab strip pops
// a tab out with popOut(spec, onReturn) and leaves it out of the strip; when the window is closed,
// onReturn puts the tab back. Each strip remembers its own popped-out tabs for the next start
// (tabs.js: pinned.json entries with `popped`; chat.js: ui.chatPopped / ui.streamPopped).
//
// spec: { key, title, area: 'story' | 'chat' | 'stream',
//         kind: 'web', url, partition, site?, volume?, muted?   — a page
//       | kind: 'irc', chat: { key, label, spec, host, room } } — an IRC room

import { api } from './dom.js';

const popped = new Map();          // key -> onReturn

/** Opens the tab's window; `onReturn` runs when that window is closed. */
export function popOut(spec, onReturn) {
  popped.set(spec.key, onReturn);
  api.popOut(spec).then(ok => {
    if (ok || !popped.has(spec.key)) return;
    popped.delete(spec.key);                                   // the window couldn't be made: back to the strip
    onReturn();
  });
  api.log('info', `Pop-out: ${spec.area} tab "${spec.title}"`);
}

/** The tab is gone (closed, removed in Settings): close its window without bringing it back. */
export function dropPopout(key) {
  if (!popped.delete(key)) return;
  api.closePopout(key);
}

/** Bring the window to the front (asked to open a tab that is already popped out). */
export const focusPopout = key => api.focusPopout(key);

api.onPopoutClosed(key => {
  const onReturn = popped.get(key);
  if (!popped.delete(key)) return;
  api.log('info', `Pop-out: "${key}" returned to the main window`);
  onReturn?.();
});
