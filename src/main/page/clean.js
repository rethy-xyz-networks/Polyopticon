// Injected (isolated world) into an article page right before it is saved.
// Removes login/subscribe walls, consent banners, newsletter prompts and other
// overlays, and unlocks scrolling, so the saved copy and the extracted text are
// just the article. Everything it changes is recorded so __polyopticonRestore() can
// put the live page back exactly as it was after the snapshot is taken.
//
// It does not fetch or reveal anything the site didn't send: if a publisher
// truncated the article on its server, the saved copy is truncated too.
(() => {
  const removed = [];       // [node, parent, nextSibling]
  const styled = [];        // [element, property, oldValue, oldPriority]
  const classes = [];       // [element, className]

  const PROMPT_RX = /\b(subscribe|subscription|sign in|signin|log in|login|create (a |your )?(free )?account|register|newsletter|already a subscriber|continue reading|unlock|cookies?|consent|privacy (choices|settings)|we value your privacy|turn off your ad ?blocker|disable your ad ?blocker|you have \d+ free articles?|free articles? (left|remaining))\b/i;
  // Messages that only appear when the article itself was cut short.
  const SUBSCRIBE_RX = /^(subscribe to|to leave without signing in|enjoy unlimited access|create your free account|you have reached your (free )?article limit|this article is for subscribers)/i;
  const INLINE_RX =/^(subscribe to|to leave without signing in|enjoy unlimited access|create your free account|already a subscriber|log in to|sign in to|thank you for your patience while we verify|you have reached your (free )?article limit|this article is for subscribers)/i;

  const SELECTORS = [
    // Consent managers
    '#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter', '#truste-consent-track', '.truste_overlay', '.truste_box_overlay',
    '.fc-consent-root', '[id^="sp_message_container"]', '.qc-cmp2-container', '#didomi-host', '#usercentrics-root',
    '#CybotCookiebotDialog', '#cmpbox', '#cmpbox2', '.cmp-root', '#consent-banner', '[class*="cookie-banner"]', '[id*="cookie-banner"]',
    '[class*="CookieBanner"]', '[class*="consent-banner"]', '[class*="ConsentBanner"]',
    // Paywalls / registration walls / meters
    '[id*="gateway"]', '[data-testid*="gateway"]', '[class*="paywall"]', '[id*="paywall"]', '[class*="Paywall"]', '[data-testid*="paywall"]',
    '[class*="regwall"]', '[class*="Regwall"]', '[class*="reg-wall"]', '[class*="meter-"]', '[id*="meter-"]',
    '.tp-modal', '.tp-backdrop', '.tp-container-inner', '[class*="piano-"]', '[id*="piano"]', '[class*="pn-template"]',
    '[data-testid="inline-message"]', '[data-testid="expanded-dock"]', '#dock-container', '[data-testid="onsite-messaging-unit"]',
    '[class*="SubscribeBanner"]', '[class*="subscribe-banner"]', '[class*="Subscription"][class*="Prompt"]',
    // Newsletter / app / notification prompts
    '[class*="newsletter-signup"]', '[class*="NewsletterSignup"]', '[class*="newsletter-promo"]', '[class*="app-promo"]',
    '[class*="push-notification"]', '[class*="PushNotification"]', '[id*="push-notification"]',
    // Modals
    '[aria-modal="true"]', '.modal-backdrop', '[class*="ModalOverlay"]', '[class*="modal-overlay"]',
    // Ads that survived the network blocker
    'ins.adsbygoogle', '[id^="google_ads"]', '[id^="div-gpt-ad"]', '[class*="ad-slot"]', '[class*="AdSlot"]', '[data-ad-slot]',
  ].join(',');

  const main = document.querySelector('article, [itemprop="articleBody"], section[name="articleBody"], main, [role="main"]');
  const protectedNode = el => el === document.body || el === document.documentElement || (main && el.contains(main));

  const remove = el => {
    if (!el?.isConnected || protectedNode(el)) return;
    removed.push([el, el.parentNode, el.nextSibling]);
    el.remove();
  };
  const setStyle = (el, prop, value) => {
    styled.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  };

  // Evidence that the publisher withheld part of the article (drives the "partial" note).
  let wall = false;
  const WALL_RX = /gateway|paywall|regwall|reg-wall|piano|tp-modal/i;
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 50; };

  // 1. Known wall / banner / modal containers.
  for (const el of document.querySelectorAll(SELECTORS)) {
    const isWall = WALL_RX.test(`${el.id} ${el.getAttribute('class') ?? ''} ${el.getAttribute('data-testid') ?? ''}`);
    if (isWall && el.isConnected && visible(el) && PROMPT_RX.test((el.textContent || '').slice(0, 2000))) wall = true;
    if (protectedNode(el) && el !== document.body && el !== document.documentElement) {
      // A wall wrapper around the article itself (e.g. NYT pins the story in a fixed
      // container): keep it, but make it an ordinary block.
      for (const [p, v] of [['position', 'static'], ['height', 'auto'], ['max-height', 'none'], ['overflow', 'visible'], ['filter', 'none']]) setStyle(el, p, v);
      if (isWall) wall = true;
    } else remove(el);
  }

  // 2. Fixed or sticky overlays: anything covering a big part of the screen, or
  //    a bar asking you to subscribe / sign in / accept cookies.
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll('body *')) {
    if (!el.isConnected) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky' && cs.position !== 'absolute') continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const big = area > vw * vh * 0.3;
    // Fade "scrims" drawn over the text: big, empty, gradient or translucent background.
    const tint = /gradient/.test(cs.backgroundImage) || /rgba\([^)]*,\s*0?\.\d+\)/.test(cs.backgroundColor);
    if (big && tint && (el.textContent || '').trim().length < 20) { remove(el); continue; }
    if (cs.position === 'absolute') continue;
    const promptBar = r.height > 40 && PROMPT_RX.test((el.innerText || '').slice(0, 600));
    if ((big && cs.position === 'fixed') || promptBar) remove(el);
  }

  // 3. "Subscribe to read…" style paragraphs left inside the article.
  for (const el of document.querySelectorAll('p, h2, h3, div, span, a, button')) {
    if (!el.isConnected || el.children.length > 3) continue;
    const t = (el.textContent || '').trim();
    if (t.length > 0 && t.length < 300 && INLINE_RX.test(t)) {
      if (main?.contains(el) && SUBSCRIBE_RX.test(t)) wall = true;
      const box = el.closest('aside, section, div');
      remove(box && box !== main && (box.textContent || '').length < 700 ? box : el);
    }
  }

  // 4. Unlock scrolling and un-blur content.
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    classes.push([el, el.className]);
    el.className = String(el.className).replace(/\S*(modal-open|no-?scroll|overflow-hidden|scroll-lock|locked|paywall|gateway|has-overlay)\S*/gi, '');
    setStyle(el, 'overflow', 'visible');
    setStyle(el, 'position', 'static');
    setStyle(el, 'height', 'auto');
  }
  for (const el of document.querySelectorAll('[style*="blur"], [class*="blur"]')) setStyle(el, 'filter', 'none');

  window.__polyopticonRestore = () => {
    for (const [el, prop, val, prio] of styled.reverse()) { if (val) el.style.setProperty(prop, val, prio); else el.style.removeProperty(prop); }
    for (const [el, cls] of classes) el.className = cls;
    for (const [node, parent, next] of removed.reverse()) {
      try { parent.insertBefore(node, next && next.parentNode === parent ? next : null); } catch { /* parent gone */ }
    }
    delete window.__polyopticonRestore;
  };

  return { removed: removed.length, wall };
})()
