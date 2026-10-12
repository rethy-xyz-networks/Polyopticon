// Injected before a page is saved: makes lazy-loaded images load now (so the
// saved copy has them), then waits briefly for them to finish.
(async () => {
  const imgs = [...document.querySelectorAll('img')];
  for (const img of imgs) {
    if (img.loading === 'lazy') img.loading = 'eager';
    // Common lazy-load patterns keep the real URL in a data attribute.
    for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'data-url']) {
      const v = img.getAttribute(attr);
      if (v && /^https?:|^\//.test(v) && (!img.src || img.src.startsWith('data:'))) { img.src = v; break; }
    }
    const ss = img.getAttribute('data-srcset');
    if (ss && !img.srcset) img.srcset = ss;
  }
  const pending = imgs.filter(i => !i.complete && i.src && !i.src.startsWith('data:'));
  if (pending.length) {
    await Promise.race([
      Promise.all(pending.map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      new Promise(r => setTimeout(r, 2500)),
    ]);
  }
  // Responsive images: only the size the browser picked is saved, so pin each
  // image to it — otherwise the saved copy may ask for a size it doesn't contain.
  for (const img of imgs) {
    const chosen = img.currentSrc;          // read before touching srcset — that resets it
    if (!chosen || chosen.startsWith('data:') || !img.naturalWidth) continue;
    img.src = chosen;
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    const pic = img.closest('picture');
    if (pic) for (const s of pic.querySelectorAll('source')) s.remove();
  }
  return { images: imgs.length, waitedFor: pending.length };
})()
