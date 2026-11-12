'use strict';

// Where the bias chart's names go (src/renderer/bias-layout.js): every dot is named, nothing overlaps.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '../../src/renderer/bias-layout.js')));
const R = 7, BOX = { x: 74, y: 12, w: 770, h: 590 };
const widthOf = name => name.length * 6.2;
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const NAMES = ['NASA (Source)', 'Axios', 'RTÉ', 'France24', 'Foreign Policy', 'Radio France Internationale', 'The Diplomat', 'MarketWatch',
  '연합뉴스-Yonhap News Agency', 'The Straits Times', 'Al Jazeera', 'Meduza', 'Global Voices', 'Balkan Insight', 'The Syrian Observer'];
const dotsAt = points => points.map(([px, py], i) => ({ px, py, name: `${NAMES[i % NAMES.length]} ${i}` }));

/** Every dot named, inside the box, clear of every dot and every other name. */
function assertClean(dots, box = BOX) {
  for (const d of dots) {
    assert.ok(d.label, `${d.name} has a name`);
    const q = d.label;
    assert.ok(q.x >= box.x && q.x + q.w <= box.x + box.w && q.y >= box.y && q.y + q.h <= box.y + box.h, `${d.name} is inside the chart`);
    for (const o of dots) {
      assert.ok(!hit(q, { x: o.cx - R, y: o.cy - R, w: 2 * R, h: 2 * R }), `${d.name} does not cover the dot of ${o.name}`);
      if (o !== d) assert.ok(!hit(q, o.label), `${d.name} does not cover ${o.name}`);
    }
  }
}

test('a dot on its own has its name beside it, with no leader line', async () => {
  const { spread, placeLabels } = await load();
  const dots = dotsAt([[400, 300]]);
  spread(dots, R);
  assert.equal(placeLabels(dots, BOX, R, widthOf), 0);
  assert.equal(dots[0].leader, null);
  assert.equal(dots[0].label.x, 400 + R + 3);
});

test('sixty outlets rated alike, all on one point: every one is named, none overlap', async () => {
  const { spread, placeLabels } = await load();
  const dots = dotsAt(Array.from({ length: 60 }, () => [459, 307]));
  spread(dots, R);
  assert.equal(placeLabels(dots, BOX, R, widthOf), 0);
  assertClean(dots);
  const led = dots.filter(d => d.leader);
  assert.ok(led.length > 30, 'the ones inside the pile are joined to their names by a line');
  for (const d of led) assert.ok(Math.abs(Math.hypot(d.leader.x1 - d.cx, d.leader.y1 - d.cy) - R) < 0.01, 'a line starts at the edge of its dot');
});

test('piles on the rating grid, as real feeds make: every one is named, none overlap', async () => {
  const { spread, placeLabels } = await load();
  const points = [];
  for (let i = 0; i < 60; i++) points.push([[300, 380, 459, 459, 459, 540, 620][i % 7], [210, 307, 307, 210, 500, 307, 400][i % 7]]);
  const dots = dotsAt(points).sort((a, b) => a.py - b.py || a.px - b.px);
  spread(dots, R);
  assert.equal(placeLabels(dots, BOX, R, widthOf), 0);
  assertClean(dots);
});

test('no room at all: reports the names that did not fit, and still names them when forced', async () => {
  const { spread, placeLabels } = await load();
  const small = { x: 0, y: 0, w: 160, h: 60 };
  const make = () => { const d = dotsAt(Array.from({ length: 12 }, () => [80, 30])); spread(d, R); return d; };
  const dots = make();
  const missing = placeLabels(dots, small, R, widthOf);
  assert.ok(missing > 0);
  assert.equal(dots.filter(d => !d.label).length, missing);
  const forced = make();
  placeLabels(forced, small, R, widthOf, 14, { force: true });
  assert.ok(forced.every(d => d.label));
});
