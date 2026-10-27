// Map drawing and hit-testing for map.js. Outlines (countries, the UK's nations, states and provinces,
// US counties and Canada's census divisions) are projected once into Web Mercator world units (0–256
// across at zoom 0) and drawn by hand into 256px canvas tiles: Leaflet keeps and reuses them, stretches
// the old ones while zooming, and new tiles are drawn a few per frame, so no view change waits on the
// whole map. Each outline keeps a few simplified copies for zoomed-out views, built ahead in idle time.
// Cities and the hover/selection outlines sit on light canvases above. Hover and click are answered from
// a grid index, testing only the few shapes near the pointer.
//
// Leaflet's own vector layers can't do this: they re-project every shape on each zoom and test every
// shape on each mouse move, and with ~8k outlines the map froze.

import * as L from '../../node_modules/leaflet/dist/leaflet-src.esm.js';

// The places, filled in stage by stage as their data loads (see map.js).
export const geo = {
  lands: [], nations: [], states: [], subs: [], cities: [],
  landsOf: new Map(), countryName: new Map(), stateByCode: new Map(), statesOf: new Map(), nationByCode: new Map(), hasSubs: new Set(),
};

export const merc = (lon, lat) => {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return [(lon + 180) / 360 * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256];
};

/** A shape ready to draw and hit-test: rings in world units, a bounding box, and Path2Ds cached per detail level. */
function shape(geom) {
  const polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).map(p => p.map(r => {
    const a = new Float32Array(r.length * 2);
    for (let i = 0; i < r.length; i++) { const [x, y] = merc(r[i][0], r[i][1]); a[2 * i] = x; a[2 * i + 1] = y; }
    return a;
  }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (let r = p[0], i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i]; if (r[i + 1] < y0) y0 = r[i + 1]; if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return { polys, bb: [x0, y0, x1, y1], paths: [] };
}

const LODS = [3, 5, 7, Infinity];          // detail level used below each zoom
const lodOf = z => LODS.findIndex(l => z < l);
function pathOf(sh, lod) {
  if (sh.paths[lod]) return sh.paths[lod];
  const tol = LODS[lod] === Infinity ? 0 : 0.5 / 2 ** LODS[lod];      // half a pixel at the deepest zoom the level serves
  const p = new Path2D();
  for (const poly of sh.polys) for (const r of poly) {
    let px = r[0], py = r[1]; p.moveTo(px, py);
    for (let i = 2; i < r.length; i += 2) {
      const x = r[i], y = r[i + 1];
      if (Math.abs(x - px) > tol || Math.abs(y - py) > tol || i === r.length - 2) { p.lineTo(x, y); px = x; py = y; }
    }
    p.closePath();
  }
  return (sh.paths[lod] = p);
}

// Heavy preparation runs in short slices between frames, so the app never stalls on it
const idle = fn => window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 16);
export function inSlices(items, fn) {
  return new Promise(done => {
    let i = 0;
    const run = () => {
      const end = performance.now() + 10;
      while (i < items.length && performance.now() < end) fn(items[i++]);
      i < items.length ? idle(run) : done();
    };
    idle(run);
  });
}

// Grid index: world-unit cells (about 1.4° of longitude) listing the shapes whose box touches them
const GRID = 1;
const grids = { land: new Map(), nation: new Map(), state: new Map(), sub: new Map() };
function index(grid, f) {
  const [x0, y0, x1, y1] = f._sh.bb;
  for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++)
    for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) {
      const k = gx * 1024 + gy;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(f);
    }
}
const cell = (grid, x, y) => grid.get(Math.floor(x / GRID) * 1024 + Math.floor(y / GRID)) || [];
function inShape(sh, x, y) {
  const b = sh.bb;
  if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
  let inside = false;                 // even-odd across every ring, so holes work
  for (const poly of sh.polys) for (const r of poly)
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
function edgeDist(sh, x, y) {
  let best = Infinity;
  for (const poly of sh.polys) for (const r of poly)
    for (let i = 2; i < r.length; i += 2) {
      const ax = r[i - 2], ay = r[i - 1], dx = r[i] - ax, dy = r[i + 1] - ay, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
      const ex = ax + t * dx - x, ey = ay + t * dy - y, d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}
const containingIn = (grid, x, y, ok) => cell(grid, x, y).find(f => (!ok || ok(f)) && inShape(f._sh, x, y)) || null;
/** The nearest shape within tol whose edge is closest: outlines from different sources leave slivers between them. */
function nearestIn(grid, x, y, tol, ok) {
  const seen = new Set();
  let best = null, bd = tol;
  for (const [cx, cy] of [[x - tol, y - tol], [x + tol, y - tol], [x - tol, y + tol], [x + tol, y + tol]])
    for (const f of cell(grid, cx, cy)) {
      if (seen.has(f) || (ok && !ok(f))) continue;
      seen.add(f);
      const b = f._sh.bb;
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      const d = edgeDist(f._sh, x, y);
      if (d < bd) { bd = d; best = f; }
    }
  return best;
}

// Adding places

/** Country outlines (world.geojson). */
export async function addLands(features) {
  await inSlices(features, f => {
    const iso = f.properties.iso;
    if (!iso) return;
    f._sh = shape(f.geometry); index(grids.land, f);
    if (!geo.countryName.has(iso)) geo.countryName.set(iso, f.properties.name);
    if (!geo.landsOf.has(iso)) geo.landsOf.set(iso, []);
    geo.landsOf.get(iso).push(f);
  });
  geo.lands = features.filter(f => f._sh);
}
/** A middle tier between country and state (England, Scotland, Wales, Northern Ireland). */
export function addNations(features) {
  for (const f of features) { f._sh = shape(f.geometry); index(grids.nation, f); geo.nationByCode.set(f.properties.code, f); }
  geo.nations = features;
}
export async function addStates(features) {
  await inSlices(features, f => {
    const p = f.properties;
    if (p.code) geo.stateByCode.set(p.code, f);
    if (!geo.statesOf.has(p.iso)) geo.statesOf.set(p.iso, []);
    geo.statesOf.get(p.iso).push(f);
    f._sh = shape(f.geometry); index(grids.state, f);
  });
  geo.states = features;
}
/** Counties and census divisions; they can arrive in more than one batch. */
export async function addSubs(features) {
  await inSlices(features, f => { f._sh = shape(f.geometry); index(grids.sub, f); geo.hasSubs.add(f.properties.parent); });
  geo.subs = geo.subs.concat(features);
  for (const c of geo.cities) c._t = null;      // a city's county may have just arrived
}
export function setCities(cities) {
  for (const c of cities) [c.x, c.y] = merc(c.lon, c.lat);
  geo.cities = cities.sort((x, y) => y.gpop - x.gpop);
}

// Drawing

const colors = {};
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export function readColors() {
  for (const k of ['ocean', 'land', 'shade-1', 'shade-2', 'shade-3', 'shade-4', 'country', 'nation', 'admin', 'admin2', 'city', 'city-edge', 'hover']) colors[k] = css(`--map-${k}`);
  colors.accent = css('--accent'); colors.text = css('--text');
  colors.font = `600 ${css('--fs-xs')} ${css('--font')}`;
}
export const cityR = c => c.gpop >= 5e6 ? 5 : c.gpop >= 1e6 ? 4 : c.gpop >= 250e3 ? 3.2 : 2.6;

/** A Leaflet canvas renderer that, instead of drawing Leaflet layers, calls paint(ctx, view). */
const Painter = L.Canvas.extend({
  options: { padding: 0.25 },
  initialize(paint, options) { L.Canvas.prototype.initialize.call(this, options); this._paint = paint; },
  _initContainer() {
    L.Canvas.prototype._initContainer.call(this);
    L.DomEvent.off(this._container);                     // hover and click are handled on the map instead
    this._container.style.pointerEvents = 'none';
  },
  // Leaflet asks for an update more than once per view change; paint once, just before the next frame
  _updatePaths() { if (!this._postponeUpdatePaths) this._redrawRequest ||= L.Util.requestAnimFrame(this._redraw, this); },
  _draw() {
    if (!this._ctx || !this._bounds) return;
    const s = 2 ** this._zoom, o = this._map.getPixelOrigin(), b = this._bounds;
    // The canvas covers b (layer pixels); in world units that is:
    const v = { s, o, z: this._zoom, lod: lodOf(this._zoom), x0: (b.min.x + o.x) / s, y0: (b.min.y + o.y) / s, x1: (b.max.x + o.x) / s, y1: (b.max.y + o.y) / s, b };
    this._ctx.save(); this._paint(this._ctx, v); this._ctx.restore();
  },
});
const inView = (bb, v) => bb[2] >= v.x0 && bb[0] <= v.x1 && bb[3] >= v.y0 && bb[1] <= v.y1;
const toWorld = (ctx, v) => ctx.transform(v.s, 0, 0, v.s, -v.o.x, -v.o.y);

/**
 * Adds the map's drawing to a Leaflet map.
 *   shadeOf(iso)   shade class (1-4, --map-shade-N) for a country with stories about it, or 0
 *   marks()        outlines to draw over the map: [{ t (a target, or { iso } for a whole country), color, px }]
 *   cityName(c)    a city's label
 */
export function createDrawing(map, { shadeOf, marks, cityName }) {
  readColors();

  /** One tile: land, a tint for countries with stories, then lines, smallest units first so bigger borders
   *  draw over them. A unit's lines appear once it is a few pixels across. */
  function drawTile(tile, c) {
    const r = window.devicePixelRatio || 1, s = 2 ** c.z, n = 256 / s, m = 3 / s;     // world units per tile; margin for line width
    const v = { s, lod: lodOf(c.z), x0: c.x * n - m, y0: c.y * n - m, x1: (c.x + 1) * n + m, y1: (c.y + 1) * n + m };
    const ctx = tile.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, tile.width, tile.height);
    ctx.setTransform(r * s, 0, 0, r * s, -c.x * 256 * r, -c.y * 256 * r); ctx.lineJoin = 'round';
    const plain = new Path2D();
    for (const f of geo.lands) if (inView(f._sh.bb, v)) plain.addPath(pathOf(f._sh, v.lod));
    ctx.fillStyle = colors.land; ctx.fill(plain, 'evenodd');
    for (const f of geo.lands) {
      const n = inView(f._sh.bb, v) && shadeOf(f.properties.iso);
      if (n) { ctx.fillStyle = colors[`shade-${n}`]; ctx.fill(pathOf(f._sh, v.lod), 'evenodd'); }
    }
    const lines = (list, color, px, minPx) => {
      const p = new Path2D(), min = minPx / s;
      let any = false;
      for (const f of list) { const b = f._sh.bb; if (inView(b, v) && Math.max(b[2] - b[0], b[3] - b[1]) >= min) { p.addPath(pathOf(f._sh, v.lod)); any = true; } }
      if (any) { ctx.strokeStyle = color; ctx.lineWidth = px / s; ctx.stroke(p); }
    };
    lines(geo.subs, colors.admin2, 0.7, 3);
    lines(geo.states, colors.admin, 1, 3);
    lines(geo.nations, colors.nation, 1.3, 0);
    lines(geo.lands, colors.country, 1.6, 0);
  }
  const tileQueue = [];
  let tilesPending = false;
  function drawTiles() {
    const end = performance.now() + 8;                   // a slice per frame, then let the browser paint
    while (tileQueue.length && performance.now() < end) {
      const { tile, coords, done } = tileQueue.shift();
      if (tile.isConnected) drawTile(tile, coords);      // skip tiles already zoomed or panned away
      done?.(null, tile);
    }
    tilesPending = tileQueue.length > 0;
    if (tilesPending) requestAnimationFrame(drawTiles);
  }
  const queueTile = job => { tileQueue.push(job); if (!tilesPending) { tilesPending = true; requestAnimationFrame(drawTiles); } };
  const Outlines = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas'), r = window.devicePixelRatio || 1;
      tile.width = tile.height = 256 * r;
      queueTile({ tile, coords, done });
      return tile;
    },
    /** Redraws the tiles in place (new data or colours), without blanking the map first. */
    refresh() { for (const t of Object.values(this._tiles)) queueTile({ tile: t.el, coords: t.coords }); },
  });

  let drawn = [];                // cities on screen at the last paint: { c, x, y, r }
  /** City dots by size, then names biggest first wherever they fit without overlapping. */
  function paintCities(ctx, v) {
    const z = v.z, minPop = z < 3 ? 5e6 : z < 4 ? 2e6 : z < 5 ? 1e6 : z < 6 ? 250e3 : 0;
    drawn = [];
    for (const c of geo.cities) {
      if (!(c.gpop >= minPop || (c.capital && z >= 3))) continue;
      const x = c.x * v.s - v.o.x, y = c.y * v.s - v.o.y;
      if (x < v.b.min.x || x > v.b.max.x || y < v.b.min.y || y > v.b.max.y) continue;
      drawn.push({ c, x, y, r: cityR(c) });
    }
    ctx.fillStyle = colors.city; ctx.strokeStyle = colors['city-edge']; ctx.lineWidth = 1.2;
    for (const d of drawn) { ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); }
    if (z < 3.5) return;
    ctx.font = colors.font; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const taken = drawn.map(d => [d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r]);
    const free = r => !taken.some(t => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
    for (const d of drawn) {
      const name = cityName(d.c), w = ctx.measureText(name).width;
      const right = [d.x + d.r + 3, d.y - 7, d.x + d.r + 3 + w, d.y + 7], left = [d.x - d.r - 3 - w, d.y - 7, d.x - d.r - 3, d.y + 7];
      const r = free(right) ? right : free(left) ? left : null;
      if (!r) continue;
      taken.push(r);
      ctx.strokeStyle = colors['city-edge']; ctx.lineWidth = 3; ctx.strokeText(name, r[0], d.y);   // a halo against any fill
      ctx.fillStyle = colors.text; ctx.fillText(name, r[0], d.y);
    }
  }
  /** Outlines of what's hovered, open or filtered, on their own canvas so hovering never redraws the map. */
  function paintMarks(ctx, v) {
    for (const { t, color, px } of marks()) {
      if (t.sub?.kind === 'city') {
        const c = t.sub.c, x = c.x * v.s - v.o.x, y = c.y * v.s - v.o.y;
        ctx.beginPath(); ctx.arc(x, y, cityR(c) + 2.5, 0, 2 * Math.PI); ctx.strokeStyle = colors[color] ?? color; ctx.lineWidth = 2.5; ctx.stroke();
        continue;
      }
      const f = t.sub?.f || t.state;
      ctx.save(); toWorld(ctx, v); ctx.lineJoin = 'round'; ctx.strokeStyle = colors[color] ?? color; ctx.lineWidth = px / v.s;
      for (const g of f ? [f] : geo.landsOf.get(t.iso) || []) ctx.stroke(pathOf(g._sh, v.lod));
      ctx.restore();
    }
  }

  map.createPane('map-marks').style.zIndex = 450;             // above the outlines (overlayPane, 400), below pins (600)
  const outlines = new Outlines({ updateWhenZooming: false, keepBuffer: 3 }).addTo(map);
  const cityLayer = new Painter(paintCities).addTo(map), markLayer = new Painter(paintMarks, { pane: 'map-marks' }).addTo(map);

  /** What's under a container point: the smallest unit there (city, county, state, country), with its parents. */
  function targetAt(cp) {
    const lp = map.containerPointToLayerPoint(cp), s = 2 ** map.getZoom(), o = map.getPixelOrigin();
    let best = null, bd = Infinity;
    // Positions from the current view, not the last drawing, which may predate a zoom that just ended
    for (const d of drawn) { const dd = Math.hypot(d.c.x * s - o.x - lp.x, d.c.y * s - o.y - lp.y); if (dd <= d.r + 3 && dd < bd) { bd = dd; best = d.c; } }
    if (best) return cityTarget(best);
    const x = (((lp.x + o.x) / s) % 256 + 256) % 256, y = (lp.y + o.y) / s, tol = Math.min(0.9, 6 / s);
    const land = containingIn(grids.land, x, y);
    let sub = containingIn(grids.sub, x, y), st = null;
    if (sub) st = geo.stateByCode.get(sub.properties.parent) || null;
    else {
      st = containingIn(grids.state, x, y)
        || (land ? (geo.statesOf.has(land.properties.iso) ? nearestIn(grids.state, x, y, tol, f => f.properties.iso === land.properties.iso) : null) : nearestIn(grids.state, x, y, tol));
      // Inside a state that has counties, always land on one: the nearest, if the outlines leave a gap here
      if (st && geo.hasSubs.has(st.properties.code)) sub = nearestIn(grids.sub, x, y, Math.min(0.9, 40 / s), f => f.properties.parent === st.properties.code);
    }
    const iso = sub?.properties.iso || st?.properties.iso || land?.properties.iso;
    const nation = (st && geo.nationByCode.get(st.properties.nation)) || containingIn(grids.nation, x, y, f => f.properties.iso === iso);
    return iso ? { iso, nation, state: st, county: null, sub: sub ? { kind: 'county', f: sub } : null } : null;
  }

  return {
    targetAt,
    /** New outlines or colours: redraw everything. */
    redraw() { outlines.refresh(); cityLayer._redraw(); markLayer._redraw(); },
    /** Only the marks changed (hover, selection). */
    redrawMarks() { markLayer._redraw(); },
    /** Builds every simplified outline ahead of time, nearest the current zoom first, so no zoom waits on first use. */
    prebuild(list) {
      const here = lodOf(map.getZoom()), order = LODS.map((_, l) => l).sort((a, b) => Math.abs(a - here) - Math.abs(b - here));
      return inSlices(order.flatMap(l => list.map(f => [f._sh, l])), ([sh, l]) => pathOf(sh, l));
    },
  };
}

/** A city as a target, with the county, state and nation it's in. */
export function cityTarget(c) {
  if (!c._t) {
    const county = containingIn(grids.sub, c.x, c.y, f => f.properties.iso === c.iso);
    const st = (county && geo.stateByCode.get(county.properties.parent)) || containingIn(grids.state, c.x, c.y, f => f.properties.iso === c.iso);
    const nation = (st && geo.nationByCode.get(st.properties.nation)) || containingIn(grids.nation, c.x, c.y);
    c._t = { iso: c.iso, nation, state: st, county, sub: { kind: 'city', c } };
  }
  return c._t;
}

/** A country's outline bounding box in degrees: [width, height]. */
export function countrySpan(iso) {
  let w = 0, h = 0;
  for (const f of geo.landsOf.get(iso) ?? []) {
    const [x0, y0, x1, y1] = f._sh.bb;
    w = Math.max(w, (x1 - x0) * 360 / 256);
    h = Math.max(h, unmercY(y0) - unmercY(y1));
  }
  return [w, h];
}
const unmercY = y => Math.atan(Math.sinh(Math.PI * (1 - y / 128))) * 180 / Math.PI;
