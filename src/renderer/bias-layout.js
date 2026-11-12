// Where the bias chart's dots and their names go (bias.js draws them). No DOM here, so it is unit tested.

/** Dots at the same spot fan out along a spiral until they don't overlap. */
export function spread(dots, r) {
  const placed = [];
  const gap = (2 * r + 1.5) ** 2;
  for (const d of dots) {
    d.cx = d.px; d.cy = d.py;
    for (let k = 0; k < 400; k++) {
      const a = k * 2.39996, dist = k ? r * 1.15 * Math.sqrt(k) : 0;
      const x = d.px + dist * Math.cos(a), y = d.py + dist * Math.sin(a);
      if (placed.every(q => (q.cx - x) ** 2 + (q.cy - y) ** 2 >= gap)) { d.cx = x; d.cy = y; break; }
    }
    placed.push(d);
  }
}

const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Does the segment pass through the rectangle? (Liang-Barsky) */
function segHitsRect(s, r) {
  let t0 = 0, t1 = 1;
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  for (const [p, q] of [[-dx, s.x1 - r.x], [dx, r.x + r.w - s.x1], [-dy, s.y1 - r.y], [dy, r.y + r.h - s.y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

function segsCross(a, b) {
  const side = (s, x, y) => Math.sign((s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1));
  return side(a, b.x1, b.y1) !== side(a, b.x2, b.y2) && side(b, a.x1, a.y1) !== side(b, a.x2, a.y2);
}

function segNearPoint(s, x, y, dist) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / len2)) : 0;
  return (s.x1 + t * dx - x) ** 2 + (s.y1 + t * dy - y) ** 2 < dist * dist;
}

const LEADER_GAP = 5;                             // a name further than this from its dot gets a line to it
const STEP = 6;                                   // between the rings of places tried

/**
 * A name for every dot. Each goes beside its dot where there is room; otherwise in the nearest free
 * place around it, joined to the dot by a leader line. Names never cover a dot or another name.
 * Sets d.label { x, y, w, h } (the name's box) and d.leader { x1, y1, x2, y2 } or null on each dot.
 * Returns how many names found no place inside the box (with force, those are put beside their
 * dot regardless, so every dot has a label).
 *
 * @param dots     [{ cx, cy, name }]
 * @param box      { x, y, w, h } the names must stay inside
 * @param r        the dots' radius
 * @param widthOf  name -> its width in px
 * @param lineH    height of a name
 */
export function placeLabels(dots, box, r, widthOf, lineH = 14, { force = false } = {}) {
  for (const d of dots) { d.label = null; d.leader = null; }
  const dotRects = dots.map(d => ({ x: d.cx - r - 1, y: d.cy - r - 1, w: 2 * r + 2, h: 2 * r + 2 }));
  const labels = [], leaders = [];
  const inside = q => q.x >= box.x && q.x + q.w <= box.x + box.w && q.y >= box.y && q.y + q.h <= box.y + box.h;
  const free = q => inside(q) && !dotRects.some(t => hit(q, t)) && !labels.some(t => hit(q, t));

  // The most crowded first: they have the fewest places to choose from.
  const near = d => dots.reduce((n, o) => n + ((o.cx - d.cx) ** 2 + (o.cy - d.cy) ** 2 < (6 * r) ** 2), 0);
  const order = dots.map(d => ({ d, n: near(d) })).sort((a, b) => b.n - a.n || a.d.cy - b.d.cy || a.d.cx - b.d.cx).map(e => e.d);
  const maxR = Math.hypot(box.w, box.h);
  let missing = 0;

  for (const d of order) {
    const w = Math.ceil(widthOf(d.name)) + 4, h = lineH;
    /** The line from the dot to a name at q, or null when the name is beside the dot. */
    const leaderTo = q => {
      const nx = Math.max(q.x, Math.min(q.x + q.w, d.cx)), ny = Math.max(q.y, Math.min(q.y + q.h, d.cy));
      const len = Math.hypot(nx - d.cx, ny - d.cy);
      if (len - r <= LEADER_GAP) return null;
      return { x1: d.cx + (nx - d.cx) / len * r, y1: d.cy + (ny - d.cy) / len * r, x2: nx, y2: ny };
    };
    /** What is wrong with a free place: lines it lies on, and what its own line runs through. */
    const penalty = (q, line) => {
      let p = 0;
      for (const l of leaders) if (segHitsRect(l, q)) p += 60;
      if (!line) return p;
      for (const t of labels) if (segHitsRect(line, t)) p += 60;
      for (const l of leaders) if (segsCross(line, l)) p += 40;
      for (const o of dots) if (o !== d && segNearPoint(line, o.cx, o.cy, r + 1)) p += 25;
      return p;
    };

    let best = null, bestCost = Infinity;
    const consider = (q, base) => {
      if (base >= bestCost || !free(q)) return;
      const line = leaderTo(q), cost = base + penalty(q, line);
      if (cost < bestCost) { best = { q, line }; bestCost = cost; }
    };

    // Beside the dot: right, left, above, below
    consider({ x: d.cx + r + 3, y: d.cy - h / 2, w, h }, 0);
    consider({ x: d.cx - r - 3 - w, y: d.cy - h / 2, w, h }, 0.5);
    consider({ x: d.cx - w / 2, y: d.cy - r - h - 1, w, h }, 1);
    consider({ x: d.cx - w / 2, y: d.cy + r + 1, w, h }, 1.5);
    // Then rings around it, growing until nothing further out could be better
    for (let R = r + 2, k = 0; R < maxR && 2 + (R - r) < bestCost; R += STEP, k++) {
      const n = Math.max(16, Math.min(72, Math.round(2 * Math.PI * R / 24)));
      for (let i = 0; i < n; i++) {
        const a = (i + (k % 2) / 2) / n * 2 * Math.PI;
        consider({ x: d.cx + Math.cos(a) * (R + w / 2) - w / 2, y: d.cy + Math.sin(a) * (R + h / 2) - h / 2, w, h }, 2 + (R - r));
      }
    }

    if (!best) {
      missing++;
      if (!force) continue;
      const x = Math.max(box.x, Math.min(box.x + box.w - w, d.cx + r + 3));
      best = { q: { x, y: Math.max(box.y, Math.min(box.y + box.h - h, d.cy - h / 2)), w, h }, line: null };
    }
    d.label = best.q;
    d.leader = best.line;
    labels.push(best.q);
    if (best.line) leaders.push(best.line);
  }
  return missing;
}
