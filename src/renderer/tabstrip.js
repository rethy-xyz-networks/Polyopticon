// One tab for every strip (story, live chat, video), so they are built, styled (.tab in styles.css)
// and behave alike: pin icon, leading icon(s), label, optional extras, and a close button that is
// always visible. A strip only supplies what differs: its own icons, extras and handlers.

import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {object}   o
 * @param {string}   o.id          stored in data-id (reordering reads it)
 * @param {string}  [o.kind]       extra class, e.g. the chat's site ('twitch', 'irc'); colours the .dot
 * @param {string}   o.label       the visible text
 * @param {string}   o.title       tooltip
 * @param {boolean} [o.active]
 * @param {boolean} [o.pinned]     pinned tabs show a pin and have no close button
 * @param {Array}   [o.lead]       elements before the label (favicon, mode icon, dot)
 * @param {Array}   [o.trail]      elements between the label and the close button (e.g. the mute icon)
 * @param {string}  [o.closeTitle]
 * @param {Function} o.onSelect
 * @param {Function} o.onClose     also run by a middle click (unless pinned)
 * @param {Function} o.onMenu      (x, y) right-click
 */
export function tabEl({ id, kind = '', label, title, active, pinned, lead = [], trail = [], closeTitle = 'Close tab', onSelect, onClose, onMenu }) {
  return h('div', {
    class: `tab${kind ? ` ${kind}` : ''}${active ? ' active' : ''}${pinned ? ' pinned' : ''}`,
    title: pinned ? `${title}\n(pinned)` : title,
    dataset: { id },
    onclick: onSelect,
    onmousedown: e => { if (e.button === 1) e.preventDefault(); },       // no autoscroll cursor
    onauxclick: e => { if (e.button === 1 && !pinned) onClose(); },
    oncontextmenu: e => { e.preventDefault(); onMenu(e.clientX, e.clientY); },
  },
    pinned && h('span', { class: 'pin' }, icon('pin')),
    lead,
    h('span', { class: 'label' }, label),
    trail,
    !pinned && h('button', { class: 'icon-btn close', title: closeTitle, onclick: e => { e.stopPropagation(); onClose(); } }, icon('close')));
}

// Keyboard navigation shared by every tab strip (articles, chat, streams), so the
// shortcuts (Ctrl+PgUp/PgDown, Ctrl+Shift+PgUp/PgDown) can't drift apart between views.

/** Ctrl+PgDown / PgUp: the index of the next (step 1) or previous (-1) tab, wrapping; -1 if no tabs. */
export function cycleIndex(count, current, step) {
  if (!count) return -1;
  return current < 0 ? (step > 0 ? 0 : count - 1) : (current + step + count) % count;
}

/** Ctrl+Shift+PgDown / PgUp: the index to swap `current` with, or -1 when it can't move
 *  (strip end, or the neighbour is on the other side of the pinned/unpinned divide). */
export function moveIndex(tabs, current, step) {
  const j = current + step;
  if (current < 0 || j < 0 || j >= tabs.length || !tabs[j].pinned !== !tabs[current].pinned) return -1;
  return j;
}
