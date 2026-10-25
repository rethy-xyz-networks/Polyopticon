'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Clusterer, WINDOW_MS } = require('../../src/main/enrich/cluster');

const T0 = Date.UTC(2026, 9, 5, 12);
const H = 3600e3;

// Background noise so word rarity (IDF) behaves like a real feed.
function seeded() {
  const c = new Clusterer();
  const filler = [
    'Stock markets close higher on tech rally', 'Heavy rain floods streets in Mumbai',
    'Football club signs new striker for record fee', 'Central bank holds interest rates steady',
    'Wildfire forces evacuations in California hills', 'Scientists discover new species of frog',
    'Airline cancels flights over pilot strike', 'Parliament debates housing bill',
  ];
  filler.forEach((t, i) => c.add(`f${i}`, t, T0 - 2 * H));
  return c;
}

test('similar headlines from different sources join one group', () => {
  const c = seeded();
  const a = c.add('a', 'Earthquake of magnitude 7.1 strikes off coast of Japan', T0);
  const b = c.add('b', 'Magnitude 7.1 earthquake strikes off Japan coast, tsunami warning issued', T0 + 10 * 60e3);
  assert.equal(a, 'a');
  assert.equal(b, 'a');
});

test('unrelated headlines start their own groups', () => {
  const c = seeded();
  c.add('a', 'Earthquake of magnitude 7.1 strikes off coast of Japan', T0);
  assert.equal(c.add('b', 'Election results delayed in Kenya after protests', T0), 'b');
});

test('matching stories too far apart in time are not grouped', () => {
  const c = seeded();
  c.add('a', 'Earthquake of magnitude 7.1 strikes off coast of Japan', T0);
  assert.equal(c.add('b', 'Magnitude 7.1 earthquake strikes off Japan coast', T0 + WINDOW_MS + H), 'b');
});

test('a stored cluster id is kept as-is', () => {
  const c = seeded();
  assert.equal(c.add('x', 'Anything at all here', T0, 'stored-cluster'), 'stored-cluster');
});

test('remove and prune drop documents', () => {
  const c = seeded();
  const before = c.size;
  c.add('a', 'Earthquake strikes Japan coast', T0);
  assert.equal(c.size, before + 1);
  c.remove('a');
  assert.equal(c.size, before);
  c.prune(T0 + 10 * WINDOW_MS);
  assert.equal(c.size, 0);
});

test('templated headlines about different places are not grouped', () => {
  const c = seeded();
  const at = (cc, ...spots) => ({ ccs: [cc], spots });
  c.add('a', 'Clima hoy en Esquel, Chubut: el pronóstico del tiempo para este jueves', T0, null, at('AR', 'c:esquel'));
  assert.equal(c.add('b', 'Clima hoy en Azul, Buenos Aires: el pronóstico del tiempo para este jueves', T0, null, at('AR', 'c:azul')), 'b');
  c.add('d', 'Dólar hoy en Bolivia: cotización de cierre del 22 de octubre', T0, null, at('BO'));
  assert.equal(c.add('e', 'Dólar hoy en Brasil: cotización de cierre del 22 de octubre', T0, null, at('BR')), 'e');
  // The same place, or one headline naming none, still groups
  assert.equal(c.add('f', 'Clima hoy en Esquel, Chubut: el pronóstico del tiempo para este jueves 22', T0, null, at('AR', 'c:esquel')), 'a');
  assert.equal(c.add('g', 'Dólar hoy: cotización de cierre del 22 de octubre en Bolivia', T0), 'd');
});
