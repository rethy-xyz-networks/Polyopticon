// Scrollable tab strips (story tabs, live-chat tabs, video tabs). The layout is shared CSS
// (styles.css), switched by the ScrollableTabs setting (body.tabs-scroll); this adds the
// one piece CSS can't: the mouse wheel scrolls a strip sideways.

/** Make the vertical mouse wheel scroll a tab strip sideways. */
export function bindTabScroll(strip) {
  strip.addEventListener('wheel', e => {
    if (e.deltaX || !e.deltaY) return;
    if (!document.body.classList.contains('tabs-scroll') && !strip.classList.contains('chat-tabs')) return;   // chat strips always wheel-scroll
    strip.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
}
