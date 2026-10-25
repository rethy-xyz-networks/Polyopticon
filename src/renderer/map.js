// Map view: where the stories in the live list are happening. Places come from
// the offline gazetteer (tagged in the feed worker). A story about a whole country
// shades the country, darker with more stories. Every other story is a pin in its
// site's colour, faded with age. A place's pins, and those of places that would
// overlap at the current zoom, gather in one cluster that stops growing at
// CLUSTER_PINS pins; its number is the count of stories. Clicking a cluster or a
// shaded country lists all its stories, with a search box. Fully offline: Natural
// Earth country outlines, no tile server.

import * as L from '../../node_modules/leaflet/dist/leaflet-src.esm.js';
import { $, h, relTime, formatTime } from './dom.js';
import { state, sourceColor } from './state.js';
import { openTab } from './tabs.js';
import { ui, saveUi } from './ui.js';
import { measure } from './perfwatch.js';

const WINDOWS = [['1h', 3600e3], ['6h', 6 * 3600e3], ['24h', 24 * 3600e3], ['All', Infinity]];

// Pins: drawn tip-down at (0, 0), PIN_W × PIN_H px, laid out on a sunflower spiral
// (radius SPACING·√i) so a cluster stays round and grows slowly.
const PIN_W = 10, PIN_H = 15, SPACING = 5.2, GOLDEN_ANGLE = 2.39996;
const PIN_PATH = 'M0 0C-1.2-3.6-5-6.2-5-10a5 5 0 0 1 10 0c0 3.8-3.8 6.4-5 10z';
const CLUSTER_PINS = 30;
const LIST_ROWS = 200;           // rows in a cluster's list before "narrow the search"
const PLACES_LISTED = 10;        // places named in a merged cluster's header
// A country this small (degrees across) can't be seen shaded at world zoom: it gets a pin (Singapore, Bahrain).
const SMALL_COUNTRY = 1.5;
const SHADES = [[15, 0.8], [5, 0.6], [2, 0.42], [1, 0.22]];   // [stories at least, fill opacity]

let map = null;
let world = null;            // GeoJSON country layer
let shadeLayer = null;       // shaded countries, rebuilt when their stories change
let shadeSig = '';
const countryShapes = new Map();   // ISO code -> GeoJSON features (only countries big enough to shade)
let markers = new Map();     // cluster anchor place key -> marker
let markerLayer = null;
let windowMs = 24 * 3600e3;
let dirty = true;
let open = false;
let popupOpen = false;       // clusters stay put while their list is open
let onPlaceFilter = () => {};

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Lifecycle

export function initMap({ onFilter }) {
  onPlaceFilter = onFilter;
  $('btn-map').addEventListener('click', () => (open ? closeMap() : openMap()));
  document.addEventListener('story:activate', () => closeMap());
  document.addEventListener('special-view', e => { if (e.detail !== 'map') closeMap(); });   // the bias chart opened
  const setWindow = name => {
    const w = WINDOWS.find(x => x[0] === name);
    if (!w) return false;
    windowMs = w[1];
    for (const x of document.querySelectorAll('#map-window button')) x.classList.toggle('on', x.dataset.w === name);
    return true;
  };
  setWindow(ui.mapWindow);
  for (const b of document.querySelectorAll('#map-window button'))
    b.addEventListener('click', () => {
      if (setWindow(b.dataset.w)) saveUi({ mapWindow: b.dataset.w });
      refresh(true);
    });
}

export function openMap() {
  open = true;
  document.dispatchEvent(new CustomEvent('special-view', { detail: 'map' }));
  document.querySelector('.story').classList.add('map-open');
  $('btn-map').classList.add('on');
  if (!map) createMap();
  requestAnimationFrame(() => { map.invalidateSize(); refresh(); });
}

export function closeMap() {
  if (!open) return;
  open = false;
  document.querySelector('.story').classList.remove('map-open');
  $('btn-map').classList.remove('on');
}

/**
 * A cluster's tooltip lists every place in it, so it can be larger than the map. It wraps
 * (no wider than the map), goes below the marker when there's no room above, and one near
 * the left or right edge slides back inside; its arrow stays over the marker.
 */
function fitTooltip(tooltip) {
  const el = tooltip.getElement(), box = map.getContainer().getBoundingClientRect();
  const o = tooltip.options;
  o.topOffset ??= o.offset;
  Object.assign(o, { direction: 'top', offset: o.topOffset });
  el.style.marginLeft = '';
  el.style.setProperty('--tip-shift', '0px');
  el.style.maxWidth = `${Math.max(120, Math.min(360, box.width - 16))}px`;
  tooltip.update();                                  // re-measure and re-place: wrapped is taller
  let r = el.getBoundingClientRect();
  if (r.top < box.top + 8) {
    const above = r.bottom - box.top;
    Object.assign(o, { direction: 'bottom', offset: [0, 0] });
    tooltip.update();
    r = el.getBoundingClientRect();
    if (r.bottom > box.bottom - 8 && box.bottom - r.top < above) {    // more room above after all
      Object.assign(o, { direction: 'top', offset: o.topOffset });
      tooltip.update();
      r = el.getBoundingClientRect();
    }
  }
  const shift = Math.round(Math.max(box.left + 8 - r.left, Math.min(0, box.right - 8 - r.right)));
  el.style.marginLeft = `${shift}px`;
  el.style.setProperty('--tip-shift', `${shift}px`);
}

async function createMap() {
  map = L.map('map-canvas', {
    worldCopyJump: true, minZoom: 2, maxZoom: 12, zoomSnap: 0.5,
    attributionControl: true, preferCanvas: true,
  }).setView([30, 25], 2.5);
  map.attributionControl.setPrefix(false);
  markerLayer = L.layerGroup().addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe($('map-canvas'));
  // Clusters depend on the zoom: places that overlap merge, and split again when zoomed in.
  map.on('zoomend', () => refresh(true));
  map.on('popupopen', e => {
    popupOpen = true;
    e.popup.getElement()?.querySelector('input')?.focus();
  });
  map.on('popupclose', () => { popupOpen = false; if (dirty) refresh(true); });
  map.on('tooltipopen', e => { if (!e.tooltip.options.sticky) fitTooltip(e.tooltip); });   // a country's follows the mouse

  const geo = await (await fetch('assets/world.geojson')).json();
  world = L.geoJSON(geo, { style: worldStyle, interactive: false }).addTo(map);
  world.bringToBack();
  map.attributionControl.addAttribution('Natural Earth · GeoNames');
  const spans = new Map();
  for (const f of geo.features) {
    const iso = f.properties.iso;
    if (!iso) continue;
    if (!countryShapes.has(iso)) countryShapes.set(iso, []);
    countryShapes.get(iso).push(f);
    const b = L.geoJSON(f).getBounds(), [w, h0] = spans.get(iso) ?? [0, 0];
    spans.set(iso, [Math.max(w, b.getEast() - b.getWest()), Math.max(h0, b.getNorth() - b.getSouth())]);
  }
  for (const [iso, [w, h0]] of spans) if (Math.max(w, h0) < SMALL_COUNTRY) countryShapes.delete(iso);
  shadeLayer = L.layerGroup().addTo(map);
  refresh(true);                               // countries drawn as pins until the outlines loaded
}

function worldStyle() {
  return { color: css('--map-border'), weight: 0.6, fillColor: css('--map-land'), fillOpacity: 1 };
}

/** Theme changed. */
export function applyMapAppearance() {
  world?.setStyle(worldStyle());
  shadeSig = '';
  if (open) refresh(true);
}

/** A shaded country's style: darker with more stories, outlined when it's the feed's place filter. */
function shadeStyle(n, on) {
  return {
    fillColor: css('--map-shade'), fillOpacity: SHADES.find(([min]) => n >= min)[1],
    color: on ? css('--accent') : css('--map-border'), weight: on ? 2 : 0.6,
  };
}

const isShaded = p => p.key.startsWith('c:') && countryShapes.has(p.key.slice(2));

/** One list of stories, as a cluster's popup shows them, for a place on its own. */
const single = p => ({ places: [p], keys: [p.key], name: p.name, anchor: p, stories: p.items.map(it => ({ it, place: p.name })) });

function drawShades(countries, filtered) {
  const sig = [...countries].map(p => `${p.key}:${p.items.length}:${filtered.has(p.key) ? 1 : 0}:${p.items.slice(0, 1).map(it => it.id)}`).join();
  if (sig === shadeSig) return;
  shadeSig = sig;
  shadeLayer.clearLayers();
  for (const p of countries) {
    const n = p.items.length;
    const layer = L.geoJSON(countryShapes.get(p.key.slice(2)), { style: () => shadeStyle(n, filtered.has(p.key)) });
    layer.bindTooltip(`${p.name} · ${n} stor${n === 1 ? 'y' : 'ies'}`, { sticky: true, direction: 'top' });
    layer.on('click', e => L.popup({ maxWidth: 440, minWidth: 360, className: 'map-popup', autoPanPadding: [20, 20] })
      .setLatLng(e.latlng).setContent(popupFor(single(p))).openOn(map));
    shadeLayer.addLayer(layer);
  }
}

/** Where a place is drawn, in page pixels (for the tests, which can't see into the canvas). */
export function placePoint(lat, lon) {
  const pt = map.latLngToContainerPoint([lat, lon]), box = map.getContainer().getBoundingClientRect();
  return { x: box.left + pt.x, y: box.top + pt.y };
}

// Data

/** Called whenever the visible live list changes. */
export function onVisibleItems() {
  dirty = true;
  if (open) refreshSoon();
}

let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 400);
}

/** Places with the visible stories in the time window, each story newest first. */
function aggregate() {
  const since = Date.now() - windowMs;
  const byPlace = new Map();
  for (const it of state.visible ?? []) {
    if (it.publishedAt < since || !it.places?.length) continue;
    for (const [key, name, lat, lon] of it.places) {
      let p = byPlace.get(key);
      if (!p) byPlace.set(key, p = { key, name, lat, lon, items: [] });
      p.items.push(it);
    }
  }
  for (const p of byPlace.values()) p.items.sort((a, b) => b.publishedAt - a.publishedAt);
  return byPlace;
}

/** How far a cluster of n stories reaches from its centre, in pixels. */
const reach = n => SPACING * Math.sqrt(Math.min(n, CLUSTER_PINS) - 1) + PIN_H;

/** Places that would overlap at the current zoom, merged. Biggest places anchor their cluster. */
function clusterPlaces(places) {
  const zoom = map.getZoom();
  const clusters = [];
  for (const p of [...places.values()].sort((a, b) => b.items.length - a.items.length)) {
    const pt = map.project([p.lat, p.lon], zoom);
    let best = null, bestD = Infinity;
    for (const c of clusters) {
      const d = c.pt.distanceTo(pt);
      if (d < reach(c.size) + reach(p.items.length) && d < bestD) { best = c; bestD = d; }
    }
    if (best) { best.places.push(p); best.size += p.items.length; }
    else clusters.push({ pt, anchor: p, places: [p], size: p.items.length });
  }
  for (const c of clusters) {
    // A story tagged with two places of the cluster is one story.
    const seen = new Map();
    for (const p of c.places) for (const it of p.items) if (!seen.has(it.id)) seen.set(it.id, { it, place: p.name });
    c.stories = [...seen.values()].sort((a, b) => b.it.publishedAt - a.it.publishedAt);
    c.keys = c.places.map(p => p.key);
    c.name = c.places.length > 1 ? `${c.anchor.name} +${c.places.length - 1} nearby` : c.anchor.name;
  }
  return clusters;
}

function ageOpacity(t) {
  const age = Date.now() - t;
  return age < 3600e3 ? 1 : age < 6 * 3600e3 ? 0.8 : age < 24 * 3600e3 ? 0.6 : 0.4;
}

function clusterIcon(c, highlighted) {
  const pins = c.stories.slice(0, CLUSTER_PINS).map(({ it }, i) => {
    const r = SPACING * Math.sqrt(i), a = i * GOLDEN_ANGLE;
    return { it, x: r * Math.cos(a), y: r * Math.sin(a) };
  });
  const minX = Math.min(...pins.map(p => p.x)) - PIN_W / 2 - 1, maxX = Math.max(...pins.map(p => p.x)) + PIN_W / 2 + 1;
  const minY = Math.min(...pins.map(p => p.y)) - PIN_H - 1, maxY = Math.max(...pins.map(p => p.y)) + 1;
  const w = Math.ceil(maxX - minX), ht = Math.ceil(maxY - minY);
  const svg = pins.sort((a, b) => a.y - b.y)                       // lower pins drawn over higher ones
    .map(p => `<g transform="translate(${(p.x - minX).toFixed(1)} ${(p.y - minY).toFixed(1)})" opacity="${ageOpacity(p.it.publishedAt)}">` +
      `<path d="${PIN_PATH}" fill="${sourceColor(p.it.sourceId)}"/><circle cy="-10" r="1.8"/></g>`).join('');
  const n = c.stories.length;
  return L.divIcon({
    className: `map-cluster${highlighted ? ' on' : ''}`,
    html: `<svg width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">${svg}</svg>${n > 1 ? `<span class="map-count">${n}</span>` : ''}`,
    iconSize: [w, ht], iconAnchor: [-minX, -minY],
  });
}

const refresh = (force = false) => measure(() => `map update (${markers.size} clusters)`, () => refreshNow(force));

function refreshNow(force) {
  if (!map || (!dirty && !force)) return;
  if (popupOpen) { dirty = true; return; }   // redrawn when the list closes
  dirty = false;
  const places = aggregate();
  const filtered = new Set(state.placeFilter?.keys ?? []);
  const countries = [...places.values()].filter(isShaded);
  if (shadeLayer) drawShades(countries, filtered);
  const clusters = clusterPlaces(new Map([...places].filter(([, p]) => !isShaded(p))));
  const live = new Set();
  for (const c of clusters) {
    const on = c.keys.some(k => filtered.has(k));
    const sig = [map.getZoom(), on, c.keys.join(), c.stories.slice(0, CLUSTER_PINS).map(s => s.it.id).join(), c.stories.length,
      Math.floor(Date.now() / 600e3)].join('|');   // ages fade over time
    let m = markers.get(c.anchor.key);
    if (!m) {
      m = L.marker([c.anchor.lat, c.anchor.lon], { keyboard: true, riseOnHover: true }).addTo(markerLayer);
      m.bindPopup(layer => popupFor(layer._cluster), { maxWidth: 440, minWidth: 360, className: 'map-popup', autoPanPadding: [20, 20] });
      markers.set(c.anchor.key, m);
    }
    if (m._sig !== sig) {
      m.setIcon(clusterIcon(c, on));
      m.unbindTooltip().bindTooltip(`${c.places.map(p => p.name).join(', ')} · ${c.stories.length} stor${c.stories.length === 1 ? 'y' : 'ies'}`,
        { direction: 'top', offset: [0, -reach(c.stories.length)] });
      m.setZIndexOffset(c.stories.length);      // bigger clusters on top
      m._sig = sig;
    }
    m._cluster = c;
    live.add(c.anchor.key);
  }
  for (const [key, m] of markers) if (!live.has(key)) { markerLayer.removeLayer(m); markers.delete(key); }
  const stories = new Set();
  for (const p of places.values()) for (const it of p.items) stories.add(it.id);
  $('map-summary').textContent = `${places.size} place${places.size === 1 ? '' : 's'} · ${stories.size} stor${stories.size === 1 ? 'y' : 'ies'}`;
}

// A cluster's list

function popupFor(c) {
  const stories = c.stories;
  const latest = stories[0]?.it.publishedAt;
  const multi = c.places.length > 1;
  const list = h('ul', { class: 'map-pop-list' });
  const more = h('div', { class: 'muted map-pop-more' });
  const search = h('input', {
    type: 'search', class: 'map-pop-search', spellcheck: 'false',
    placeholder: `Search ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}${multi ? ' or a place' : ''}`,
  });
  const text = new Map(stories.map(({ it, place }) => [it.id, `${it.title} ${it.sourceName} ${multi ? place : ''}`.toLowerCase()]));
  const row = ({ it, place }) =>
    h('li', {
      onclick: () => { map.closePopup(); openTab(it); },
      onmousedown: e => { if (e.button === 1) { e.preventDefault(); openTab(it); } },   // middle-click -> tab, like the feed (no autoscroll)
      title: (it.kind === 'article' && it.summary ? it.summary.slice(0, 400) : it.title) },   // the description, like the feed's tooltip
      h('span', { class: 'badge', style: `background:${sourceColor(it.sourceId)}` }, it.sourceName),
      h('span', { class: 'map-pop-time', title: relTime(it.publishedAt) }, formatTime(it.publishedAt)),
      multi && h('span', { class: 'map-pop-place' }, place),
      h('div', { class: 'map-pop-title' }, it.title));
  const fill = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length ? stories.filter(s => words.every(w => text.get(s.it.id).includes(w))) : stories;
    list.replaceChildren(...hits.slice(0, LIST_ROWS).map(row));
    list.scrollTop = 0;
    more.textContent = !hits.length ? 'No stories match'
      : hits.length > LIST_ROWS ? `…and ${hits.length - LIST_ROWS} more: narrow the search` : '';
  };
  search.addEventListener('input', fill);
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') map.closePopup();
    else if (e.key === 'Enter') list.firstElementChild?.click();
    e.stopPropagation();                      // typing "+" or "-" mustn't zoom the map
  });
  fill();

  const node = h('div', { class: 'map-pop' },
    h('div', { class: 'map-pop-head' },
      h('b', {}, c.name),
      h('span', { class: 'muted' }, ` · ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}${latest ? ` · latest ${relTime(latest)}` : ''}`)),
    multi && h('div', { class: 'muted map-pop-places' }, c.places.slice(0, PLACES_LISTED).map(p => `${p.name} (${p.items.length})`).join(' · ')
      + (c.places.length > PLACES_LISTED ? ` · ${c.places.length - PLACES_LISTED} more` : '')),
    search, list, more,
    h('button', { class: 'primary-btn', onclick: () => { map.closePopup(); onPlaceFilter({ keys: c.keys, name: multi ? c.places.map(p => p.name).join(', ') : c.name }); } },
      `Show ${multi ? 'these places' : c.name} in the feed`));
  L.DomEvent.disableScrollPropagation(node);
  return node;
}

/** Highlight the filtered place (or clear the highlight). */
export function refreshMapFilter() { if (map) refresh(true); }
