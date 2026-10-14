// Scrollable tab strips (story tabs, live-chat tabs, video tabs). The layout is shared CSS
// (styles.css), switched by the ScrollableTabs setting (body.tabs-scroll); this adds the
// one piece CSS can't: the mouse wheel scrolls a strip sideways.

/** Make the vertical mouse wheel scroll a tab strip sideways (`always`: even with "Scrollable tabs" off, as the chat strips do). */
export function bindTabScroll(strip, { always = false } = {}) {
  strip.addEventListener('wheel', e => {
    if (e.deltaX || !e.deltaY) return;
    if (!document.body.classList.contains('tabs-scroll') && !always) return;
    strip.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
}
