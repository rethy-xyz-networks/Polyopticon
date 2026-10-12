// Injected (isolated world) after clean.js, with Mozilla Readability loaded
// in the same script. Tries several extraction strategies and keeps the one
// that yields the most article text:
//   1. Readability
//   2. Site rules (known article-body containers on major news sites)
//   3. JSON-LD articleBody (what sites publish for search engines)
//   4. Every paragraph inside the page's <article>/<main>
// Returns { title, byline, siteName, excerpt, content, text, words, method, partial }.
(() => {
  const SITE_RULES = [
    [/nytimes\.com$/, 'section[name="articleBody"]'],
    [/reuters\.com$/, '[data-testid="ArticleBody"], [class*="article-body__content"]'],
    [/apnews\.com$/, '.RichTextStoryBody, .RichTextBody, [data-key="article"]'],
    [/cbc\.ca$/, '.story, .storyWrapper'],
    [/theguardian\.com$/, '#maincontent, [data-gu-name="body"]'],
    [/bbc\.(co\.uk|com)$/, 'main article, [data-component="text-block"]'],
    [/aljazeera\.(com|net)$/, '.wysiwyg, .article-p-wrapper'],
    [/washingtonpost\.com$/, '.article-body, [data-qa="article-body"]'],
    [/cnn\.com$/, '.article__content, .article__main'],
    [/foxnews\.com$/, '.article-body'],
    [/npr\.org$/, '#storytext'],
    [/timesofisrael\.com$/, '.the-content'],
    [/jpost\.com$/, '.article-inner-content, section.article-body'],
    [/dw\.com$/, '.rich-text'],
    [/france24\.com$/, '.t-content__body'],
    [/news\.sky\.com$/, '.sdc-article-body'],
    [/middleeasteye\.net$/, '.field--name-body'],
    [/al-monitor\.com$/, '.article-body, .field--name-body'],
    [/dawn\.com$/, '.story__content'],
    [/pbs\.org$/, '.body-text'],
    [/abcnews\.go\.com$/, '[data-testid="prism-article-body"]'],
    [/nbcnews\.com$/, '.article-body__content'],
  ];
  // Lines that are site furniture, not article text.
  const JUNK_RX = /^(advertisement|skip (to )?(main )?content|share (this|on)|read more|related:?|sign up|subscribe|follow us|copy link|listen to (this )?article|\d+ min read)$/i;
  const PAYWALL_RX = /(subscribe to (the times|read|continue)|to leave without signing in|create your free account|already a subscriber|you have reached your|this article is for subscribers|to continue reading)/i;

  // Saved pages (MHTML) load from file://, so prefer the page's own canonical URL.
  const pageUrl = document.querySelector('link[rel="canonical"]')?.href
    || document.querySelector('meta[property="og:url"]')?.content || location.href;
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const words = t => (t.match(/\S+/g) || []).length;
  const meta = name => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || null;

  /** Paragraph-level extraction from containers; keeps headings, quotes, list items and figures. */
  function fromContainers(nodes, method) {
    const parts = [], html = [];
    const seen = new Set();
    for (const root of nodes) {
      for (const el of root.querySelectorAll('p, h2, h3, h4, blockquote, li, figure')) {
        if (el.closest('nav, footer, aside, [role="navigation"]')) continue;
        // Skip hidden widgets inside the body — but not a body hidden as a whole
        // (some sites set aria-hidden on the article while a login overlay is up).
        const hidden = el.closest('[aria-hidden="true"]');
        if (hidden && root.contains(hidden) && hidden !== root) continue;
        if (el.tagName !== 'FIGURE' && el.closest('figure, blockquote') && el.closest('figure, blockquote') !== el) continue;
        if (el.tagName === 'FIGURE') {
          const img = el.querySelector('img');
          const src = img?.currentSrc || img?.src;
          if (src && /^https?:/.test(src) && !seen.has(src)) {
            seen.add(src);
            const cap = el.querySelector('figcaption')?.textContent.trim();
            html.push(`<figure><img src="${esc(src)}" alt="">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`);
          }
          continue;
        }
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (!t || seen.has(t) || JUNK_RX.test(t) || PAYWALL_RX.test(t)) continue;
        if (el.tagName === 'LI' && t.length < 40) continue;
        seen.add(t);
        parts.push(t);
        const tag = el.tagName.toLowerCase();
        html.push(tag === 'li' ? `<p>• ${esc(t)}</p>` : `<${tag}>${esc(t)}</${tag}>`);
      }
    }
    const text = parts.join('\n\n');
    return { method, text, content: html.join('\n'), words: words(text) };
  }

  const candidates = [];

  // 1. Readability on a copy of the cleaned page
  try {
    const a = new Readability(document.cloneNode(true), { charThreshold: 200 }).parse();
    if (a?.textContent) {
      const text = a.textContent.replace(/\n{3,}/g, '\n\n').trim();
      // Readability sometimes settles on a nav/link block; reject link-heavy picks.
      const tmp = document.createElement('div');
      tmp.innerHTML = a.content || '';
      const linkText = [...tmp.querySelectorAll('a')].reduce((n, x) => n + x.textContent.length, 0);
      const linkDensity = text.length ? linkText / text.length : 1;
      if (linkDensity < 0.5) candidates.push({ method: 'readability', text, content: a.content, words: words(text), title: a.title, byline: a.byline, siteName: a.siteName, excerpt: a.excerpt });
    }
  } catch { /* fall through to other strategies */ }

  // 2. Site rules
  const rule = SITE_RULES.find(([rx]) => rx.test(host));
  if (rule) {
    const nodes = [...document.querySelectorAll(rule[1])];
    if (nodes.length) candidates.push(fromContainers(nodes, 'site-rule'));
  }

  // 3. JSON-LD articleBody
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const list = [data, ...(Array.isArray(data) ? data : []), ...(data['@graph'] || [])];
      const art = list.find(x => x && typeof x.articleBody === 'string' && x.articleBody.length > 200);
      if (art) {
        const text = art.articleBody.replace(/\s*\n\s*/g, '\n\n').trim();
        candidates.push({ method: 'json-ld', text, words: words(text),
          content: text.split(/\n{2,}/).map(p => `<p>${esc(p)}</p>`).join('\n'),
          byline: [].concat(art.author || []).map(x => x?.name).filter(Boolean).join(', ') || null });
        break;
      }
    } catch { /* invalid JSON-LD */ }
  }

  // 4. All paragraphs in the article / main region
  const region = document.querySelectorAll('article, [itemprop="articleBody"], main, [role="main"]');
  if (region.length) candidates.push(fromContainers([...region].filter(r => ![...region].some(o => o !== r && o.contains(r))), 'paragraphs'));

  // Prefer Readability's formatting unless another strategy found clearly more text.
  const read = candidates.find(c => c.method === 'readability');
  let best = candidates.reduce((a, b) => (b.words > (a?.words ?? 0) ? b : a), null);
  if (read && best && read !== best && read.words >= best.words * 0.8) best = read;
  const tried = candidates.map(c => `${c.method}:${c.words}`).join(' ');
  if (!best || best.words < 25) return { text: null, tried };

  // Bylines come out messy ("By:", "7 hours agoShare…", author-page URLs); keep only name-like ones.
  const cleanByline = b => {
    if (!b) return null;
    if (/^https?:\/\//.test(b)) b = b.split('/').filter(Boolean).pop().replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    b = b.replace(/\s+/g, ' ').trim().replace(/^by:?\s*/i, '').trim();
    if (!b || b.length > 80 || /\b(ago|share|save|min read|updated|published)\b|^\d|john doe/i.test(b)) return null;
    return b;
  };
  const byline = [best.byline, meta('byl'), meta('author'), meta('article:author'), meta('parsely-author')].map(cleanByline).find(Boolean) || null;

  return {
    method: best.method,
    title: best.title || meta('og:title') || document.title,
    byline,
    siteName: best.siteName || meta('og:site_name') || host,
    excerpt: best.excerpt || meta('og:description') || meta('description'),
    content: best.content,
    text: best.text,
    words: best.words,
    tried,
  };
})()
