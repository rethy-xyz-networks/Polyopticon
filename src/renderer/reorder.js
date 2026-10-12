// Drag-to-reorder for a strip of tabs (article tabs, chat tabs). Pointer-driven so the
// tab follows the cursor; tabs only move within their own group (pinned or not). The DOM
// is reordered live and the owner is told the new order on release. Moving a tab never selects it.
//
//   const r = makeReorderable(strip, { selector: '.tab', ignore: '.close', onDrop, onRebuilt });
//   r.dragging        true while a tab is being moved (don't rebuild the strip then)
//
// Tab elements carry their id in data-id. onDrop(ids, draggedId) gets the ids in their new
// left-to-right order; onRebuilt() is called if the strip was rebuilt under the drag.

export function makeReorderable(strip, { selector, ignore, onDrop, onRebuilt }) {
  let drag = null;

  strip.addEventListener('pointerdown', e => {
    const el = e.target.closest(selector);
    if (!el || e.button !== 0 || (ignore && e.target.closest(ignore))) return;
    drag = { el, pointerId: e.pointerId, startX: e.clientX, grab: e.clientX - el.getBoundingClientRect().left, shift: 0, moving: false };
  });
  strip.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moving) {
      if (Math.abs(e.clientX - drag.startX) < 6) return;
      drag.moving = true;
      drag.el.setPointerCapture(e.pointerId);
      drag.el.classList.add('dragging');
      strip.classList.add('reordering');
    }
    dragTo(e.clientX);
  });
  // Letting go after a drag must not count as a click on the tab (that would select it).
  let swallowClick = false;
  strip.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  const end = e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (!d.moving) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);           // no click followed (the strip was rebuilt)
    d.el.classList.remove('dragging');
    strip.classList.remove('reordering');
    d.el.style.transform = '';
    if (!d.el.isConnected) return onRebuilt();                // strip was rebuilt mid-drag
    onDrop([...strip.children].map(n => n.dataset.id), d.el.dataset.id);
  };
  strip.addEventListener('pointerup', end);
  strip.addEventListener('pointercancel', end);
  strip.addEventListener('lostpointercapture', end);

  function dragTo(x) {
    const { el } = drag;
    const sr = strip.getBoundingClientRect();
    // Scroll the strip when dragging against its edges.
    if (x < sr.left + 24) strip.scrollLeft -= 12;
    else if (x > sr.right - 24) strip.scrollLeft += 12;

    // Layout positions (offsetLeft ignores transforms, so animating neighbours don't skew them).
    const pos = n => sr.left + n.offsetLeft - strip.scrollLeft;
    const pinned = el.classList.contains('pinned');
    const peers = [...strip.children].filter(n => n !== el && n.classList.contains('pinned') === pinned);
    const w = el.offsetWidth;
    const lefts = peers.map(pos);
    const min = Math.max(sr.left, Math.min(pos(el), ...lefts));
    const max = Math.min(sr.right - w, Math.max(pos(el), ...lefts.map((l, k) => l + peers[k].offsetWidth - w)));
    // The tab itself stays inside the strip.
    const left = Math.max(min, Math.min(max, x - drag.grab));

    // Move the element in the DOM once its centre passes a neighbour's centre. The cursor's own
    // position decides (not the clamped one), so a wide tab can still pass a narrower neighbour
    // at the very end of the strip.
    const centre = x - drag.grab + w / 2;
    const i = lefts.findIndex((l, k) => centre < l + peers[k].offsetWidth / 2);
    const before = i >= 0 ? peers[i] : null;
    const moved = before ? el.nextElementSibling !== before : peers.length && el.previousElementSibling !== peers.at(-1);
    if (moved) {
      // Move the neighbours rather than the dragged node: detaching it would
      // release its pointer capture and end the drag.
      const kids = [...strip.children];
      const from = kids.indexOf(el);
      const to = before ? kids.indexOf(before) : kids.indexOf(peers.at(-1)) + 1;
      if (to > from) for (const n of kids.slice(from + 1, to)) el.before(n);
      else for (const n of kids.slice(to, from).reverse()) el.after(n);
      // Slide the displaced neighbours into place instead of jumping.
      peers.forEach((n, k) => {
        const dx = lefts[k] - pos(n);
        if (dx) n.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
      });
    }
    drag.shift = left - pos(el);
    el.style.transform = `translateX(${drag.shift}px)`;
  }

  return { get dragging() { return !!drag?.moving; } };
}
