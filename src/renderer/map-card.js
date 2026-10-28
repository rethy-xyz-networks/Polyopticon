// The map's hover label and place card (map.js). Hovering names the smallest place under the pointer
// with its parents (Canada › Nova Scotia › Halifax); clicking opens a card with a pane for each of them,
// country first, each with its facts, summary and photo, and a button listing its stories. The card opens
// beside the click and can be dragged by its title bar; Esc, × or clicking the sea closes it.
//
// Facts and summaries ship with the app (Wikidata, Wikipedia). Photos are Wikimedia Commons thumbnails the
// main process downloads on first use (mapdata.js), so a card opens at once and its photos follow.

import * as L from '../../node_modules/leaflet/dist/leaflet-src.esm.js';
import { h } from './dom.js';
import { geo } from './map-draw.js';

// Shipped facts: { countries: { ISO: {...} }, states: { QID: {...} } } and { QID: {...} } for counties and cities;
// photos: Commons file -> [thumbnail url, page, artist, licence, crop from top].
export const facts = { info: { countries: {}, states: {} }, info2: {}, photos: {} };

const fmt = n => n == null ? null : n >= 1e12 ? `${(n / 1e12).toFixed(2)} T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(Math.round(n));
const km2 = n => n == null ? null : `${Math.round(n).toLocaleString('en')} km²`;
const dens = (p, a) => p && a ? `${(p / a).toFixed(p / a < 10 ? 1 : 0)} /km²` : null;
const flag = iso => iso && /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map(c => 0x1F1A5 + c.charCodeAt(0))) : '';
// Wikipedia's first sentences carry pronunciations and alternative names in brackets; they're dropped.
const clean = s => (s || '').replace(/\s*\([^)]*?(?:;|\s{2})[^)]*\)|\s*\(\s*\)/g, '').replace(/\s+,/g, ',');
const plural = n => `${n} stor${n === 1 ? 'y' : 'ies'}`;

const stateInfo = f => facts.info.states[f.properties.wd] || {};
const subInfo = sub => facts.info2[sub.kind === 'city' ? sub.c.wd : sub.f.properties.wd] || {};
const subName = sub => subInfo(sub).name || (sub.kind === 'city' ? sub.c.name : sub.f.properties.name);
export const cityName = c => facts.info2[c.wd]?.name || c.name;

/** A target's names, country first: { c, n (nation), s (state), k (a city's county), x (the smallest unit) }. */
const label = t => ({
  c: facts.info.countries[t.iso]?.name || geo.countryName.get(t.iso) || t.iso,
  n: t.nation && (stateInfo(t.nation).name || t.nation.properties.name),
  s: t.state && (stateInfo(t.state).name || t.state.properties.name),
  k: t.county && (facts.info2[t.county.properties.wd]?.name || t.county.properties.name),
  x: t.sub && subName(t.sub),
});
const sameTarget = (a, b) => a === b || (a && b && a.iso === b.iso && a.state === b.state && (a.sub?.f ?? a.sub?.c) === (b.sub?.f ?? b.sub?.c));

/** The feed's place keys for a target's tiers, smallest first (the gazetteer's: g:<GeoNames id>, a:<ISO 3166-2>, c:<ISO>). */
export const keysOf = t => [t.sub?.kind === 'city' && `g:${t.sub.c.gid}`, t.state?.properties.code && `a:${t.state.properties.code}`, `c:${t.iso}`].filter(Boolean);

/**
 * stage: the element holding the map; drawing: from createDrawing; count(key): stories at a place;
 * onStories(key, name, latlng): list them; onPage(url): open a page (a photo's Commons page, a Wikipedia article) as a tab;
 * onChange(): the hovered or opened place changed.
 */
export function createCard({ map, stage, drawing, count, onStories, onPage, onChange }) {
  const peek = h('div', { class: 'map-peek', hidden: true });
  const card = h('div', { class: 'map-card', hidden: true, role: 'dialog', 'aria-label': 'Place details' });
  stage.append(peek, card);
  L.DomEvent.disableClickPropagation(card);
  L.DomEvent.disableScrollPropagation(card);
  let hovered = null, opened = null, openedAt = null;

  function showPeek(t, ev) {
    if (!t) { peek.hidden = true; return; }
    const { c, n: na, s, k, x } = label(t);
    const n = keysOf(t).map(count).find(Boolean);
    peek.replaceChildren(h('span', {}, `${flag(t.iso)} ${c}`),
      ...[na, s, k, x].filter(Boolean).flatMap(v => [h('span', { class: 'mc-sep' }, '›'), h('span', {}, v)]),
      n && h('span', { class: 'mc-muted' }, `· ${plural(n)}`));
    peek.hidden = false;
    const box = stage.getBoundingClientRect(), r = peek.getBoundingClientRect();
    let px = ev.clientX - box.left + 14, py = ev.clientY - box.top + 16;
    if (px + r.width > box.width - 6) px = ev.clientX - box.left - r.width - 14;
    if (py + r.height > box.height - 6) py = ev.clientY - box.top - r.height - 12;
    peek.style.left = `${Math.max(6, px)}px`; peek.style.top = `${Math.max(6, py)}px`;
  }

  // Panes

  function photoSlot(file, name) {
    if (!file || !facts.photos[file]) return null;
    const [, page, by, lic, top] = facts.photos[file];
    const none = h('span', { class: 'mc-none' }, 'Downloading photo…');
    // The photo and its credit open its Commons page (full size, author, licence) as a tab
    const show = e => { e.preventDefault(); onPage(page); };
    const frame = h('div', { class: 'mc-frame', title: 'Open on Wikimedia Commons', onclick: show }, none);
    const credit = h('div', { class: 'mc-credit', hidden: true });
    const img = h('img', {
      alt: name, src: `polyopticon-map://photo/${encodeURIComponent(file)}`, class: top ? 'mc-top' : null, hidden: true,
      onload: () => { img.hidden = false; none.remove(); credit.hidden = false; },
      onerror: () => { img.remove(); none.textContent = 'Photo not downloaded yet: it will be tried again'; },
    });
    frame.append(img);
    credit.append(h('a', { href: page, onclick: show }, 'Photo'), by && ` · ${by}`, lic && ` · ${lic}`);
    return h('figure', { class: 'mc-photo' }, frame, credit);
  }
  const photoOf = rec => photoSlot(rec?.img, rec?.name || '');
  /** "Photo of Dublin" when the photo is of the capital or largest town rather than the place itself. */
  function credited(fig, rec) {
    const a = fig?.querySelector('.mc-credit a');
    if (a && rec.imgFrom === 'capital' && rec.capital) a.textContent = `Photo of ${rec.capital}`;
    if (a && rec.imgFrom === 'town' && rec.imgTown) a.textContent = `Photo of ${rec.imgTown}`;
    return fig;
  }
  const factList = rows => h('dl', { class: 'mc-facts' }, rows.filter(r => r[1]).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
  // The article opens as a tab too
  const wikiLink = rec => rec?.wiki && h('a', {
    class: 'mc-wiki', href: `https://en.wikipedia.org/wiki/${encodeURIComponent(rec.wiki.replace(/ /g, '_'))}`,
    onclick: e => { e.preventDefault(); onPage(e.currentTarget.href); },
  }, `Wikipedia: ${rec.wiki}`);
  const wdLink = q => q && h('div', { class: 'mc-src' }, h('a', { href: `https://www.wikidata.org/wiki/${q}`, target: '_blank', rel: 'noopener' }, `Wikidata ${q}`));
  const eyebrow = (kind, code) => h('div', { class: 'mc-eyebrow' }, h('span', {}, kind), h('span', { class: 'mc-code' }, code || ''));
  function storiesButton(key, name) {
    const n = key ? count(key) : 0;
    return n > 0 && h('button', { class: 'mc-stories', onclick: () => { close(); onStories(key, name, openedAt); } }, `Show ${plural(n)}`);
  }
  const pane = (...children) => h('div', { class: 'mc-pane' }, ...children);

  function countryPane(iso) {
    const c = facts.info.countries[iso], name = c?.name || geo.countryName.get(iso) || iso;
    if (!c) return pane(eyebrow('Country', iso), h('div', { class: 'mc-name' }, `${flag(iso)} ${name}`), storiesButton(`c:${iso}`, name));
    return pane(credited(photoOf(c), c), eyebrow('Country', iso),
      h('div', { class: 'mc-name' }, h('span', {}, flag(iso)), c.name),
      c.desc && h('div', { class: 'mc-desc' }, c.desc),
      factList([['Capital', c.capital], ['Population', fmt(c.pop)], ['Area', km2(c.area)], ['Density', dens(c.pop, c.area)],
        ['GDP', c.gdp && `$${fmt(c.gdp)}`], ['GDP / person', c.gdp && c.pop && `$${Math.round(c.gdp / c.pop).toLocaleString('en')}`],
        ['Head of state', c.hos], ['Head of gov’t', c.hog !== c.hos && c.hog], ['Languages', c.languages], ['Currency', c.currency], ['Dialling', c.calling]]),
      storiesButton(`c:${iso}`, c.name),
      c.about && h('p', { class: 'mc-about' }, clean(c.about)),
      wikiLink(c), wdLink(c.qid));
  }
  function statePane(f) {
    if (!f) return pane(eyebrow('State / province'), h('div', { class: 'mc-empty' }, 'Point inside a state or province to see it here. This country has none on the map.'));
    const p = f.properties, s = stateInfo(f), name = s.name || p.name;
    return pane(credited(photoOf(s), s), eyebrow(p.kind || 'Region', s.code || p.code),
      h('div', { class: 'mc-name' }, name),
      s.desc && h('div', { class: 'mc-desc' }, s.desc),
      factList([['Capital', s.capital], ['Population', fmt(s.pop)], ['Area', km2(s.area)], ['Density', dens(s.pop, s.area)], ['Leader', s.hog], ['Established', s.founded]]),
      storiesButton(p.code && `a:${p.code}`, name),
      s.about && h('p', { class: 'mc-about' }, clean(s.about)),
      wikiLink(s), wdLink(p.wd));
  }
  function subPane(sub) {
    const s = subInfo(sub), city = sub.kind === 'city';
    const q = city ? sub.c.wd : sub.f.properties.wd, name = subName(sub);
    const pop = s.pop || (city ? sub.c.gpop : null);
    const rows = city
      ? [['Population', fmt(pop)], ['Area', km2(s.area)], ['Density', dens(pop, s.area)], ['Elevation', s.elev != null && `${Math.round(s.elev)} m`], ['Mayor', s.hog], ['Founded', s.founded]]
      : [[sub.f.properties.iso === 'US' ? 'County seat' : 'Seat', s.capital], ['Population', fmt(s.pop)], ['Area', km2(s.area)], ['Density', dens(s.pop, s.area)], ['Leader', s.hog], ['Established', s.founded]];
    return pane(credited(photoOf(s), s),
      eyebrow(city ? (sub.c.capital ? 'Capital city' : 'City') : sub.f.properties.kind, city ? '' : sub.f.properties.code),
      h('div', { class: 'mc-name' }, name),
      s.desc && h('div', { class: 'mc-desc' }, s.desc),
      factList(rows),
      storiesButton(city && `g:${sub.c.gid}`, name),
      s.about && h('p', { class: 'mc-about' }, clean(s.about)),
      wikiLink(s), wdLink(q));
  }

  // Opening, placing, dragging

  let moved = false, drag = null;
  function open(t, ev, latlng) {
    opened = t; openedAt = latlng; onChange();
    const { c, n: na, s, k, x } = label(t), n = 2 + !!t.nation + !!t.county + !!t.sub;
    card.classList.toggle('wide', n === 3); card.classList.toggle('wider', n >= 4);
    card.replaceChildren(
      h('div', { class: 'mc-head', title: 'Drag to move' },
        h('span', { class: 'mc-grip', 'aria-hidden': 'true' }, '⋮⋮'),
        h('span', { class: 'mc-crumb' }, [c, na, s, k, x].filter(Boolean).join(' › ')),
        h('button', { class: 'mc-x', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: `mc-panes n${n}` }, countryPane(t.iso), t.nation && statePane(t.nation), statePane(t.state),
        t.county && subPane({ kind: 'county', f: t.county }), t.sub && subPane(t.sub)));
    card.hidden = false; peek.hidden = true;
    card.scrollTop = 0;
    if (moved) { clamp(); return; }            // once dragged, the card stays where it was put
    // Beside the click point, flipped to stay inside the map
    const box = stage.getBoundingClientRect(), r = card.getBoundingClientRect();
    let px = ev.clientX - box.left + 18, py = ev.clientY - box.top - 40;
    if (px + r.width > box.width - 8) px = ev.clientX - box.left - r.width - 18;
    if (px < 8) px = Math.max(8, (box.width - r.width) / 2);
    py = Math.min(Math.max(8, py), box.height - r.height - 8);
    card.style.left = `${px}px`; card.style.top = `${Math.max(8, py)}px`;
  }
  function close() { if (!opened) return; opened = null; moved = false; card.hidden = true; onChange(); }
  function clamp() {
    const box = stage.getBoundingClientRect(), r = card.getBoundingClientRect();
    if (!box.width || !box.height) return;     // the map is hidden (another tab): there's nothing to fit inside
    card.style.left = `${Math.min(Math.max(0, r.left - box.left), box.width - Math.min(r.width, box.width))}px`;
    card.style.top = `${Math.min(Math.max(0, r.top - box.top), Math.max(0, box.height - 40))}px`;
  }
  card.addEventListener('pointerdown', e => {
    if (!e.target.closest('.mc-head') || e.target.closest('button')) return;
    const r = card.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    card.setPointerCapture(e.pointerId); card.classList.add('dragging');
    e.preventDefault();
  });
  card.addEventListener('pointermove', e => {
    if (!drag) return;
    const box = stage.getBoundingClientRect(), r = card.getBoundingClientRect();
    card.style.left = `${Math.min(Math.max(0, e.clientX - box.left - drag.dx), box.width - Math.min(r.width, box.width))}px`;
    card.style.top = `${Math.min(Math.max(0, e.clientY - box.top - drag.dy), box.height - 40)}px`;   // keep the title bar reachable
    moved = true;
  });
  const endDrag = () => { drag = null; card.classList.remove('dragging'); };
  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);
  card.addEventListener('dblclick', e => { if (e.target.closest('.mc-head')) moved = false; });   // next click places it beside the pointer again
  new ResizeObserver(() => { if (!card.hidden) clamp(); }).observe(stage);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && opened && !e.target.matches('input, select, textarea')) close(); });

  // Hover and click are worked out from the pointer position, at most once per frame. While the map is
  // dragged the place under the pointer doesn't change, so the label just follows it; once the map
  // settles, whatever is under the pointer now is hovered without a nudge.
  let pointer = null, pending = false;
  function hoverAt() {
    pending = false;
    if (!pointer || map._animatingZoom || map.dragging.moving()) return;
    const r = map.getContainer().getBoundingClientRect();
    const t = drawing.targetAt(L.point(pointer.clientX - r.left, pointer.clientY - r.top));
    if (!sameTarget(hovered, t)) { hovered = t; onChange(); }
    map.getContainer().classList.toggle('pointing', !!t);
    showPeek(t, pointer);
  }
  const hoverSoon = () => { if (!pending) { pending = true; requestAnimationFrame(hoverAt); } };
  const unhover = () => { pointer = null; peek.hidden = true; if (hovered) { hovered = null; onChange(); } };
  stage.addEventListener('pointermove', e => {
    // Pins, lists, the card and the controls have their own hover
    if (e.target.closest('.map-card, .map-toolbar, .map-legend, .leaflet-control, .leaflet-marker-icon, .leaflet-popup, .leaflet-tooltip')) { unhover(); return; }
    pointer = { clientX: e.clientX, clientY: e.clientY };
    if (map.dragging.moving()) { if (hovered && !peek.hidden) showPeek(hovered, e); return; }
    hoverSoon();
  }, true);
  stage.addEventListener('pointerleave', unhover);
  map.on('moveend zoomend', () => { if (pointer) hoverSoon(); });

  return {
    get hovered() { return hovered; },
    get opened() { return opened; },
    open, close,
    /** The card's contents are out of date (new stories): rebuild it in place. */
    refresh() { if (opened) { const keep = moved; moved = true; open(opened, null, openedAt); moved = keep; } },
  };
}
