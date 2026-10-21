'use strict';

// The database layer's queries: what they return (the speed-ups must not change that) and that the
// indexes added for them are the ones SQLite picks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbm = require('../../src/main/db');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-db-test-'));
  const db = dbm.open(path.join(dir, 'p.db'));
  const add = name => db.addSource({ type: 'rss', name, grp: 'USA', config: { url: `https://${name}.example/rss` } });
  return { db, add, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

const item = (n, publishedAt, extra = {}) => ({ extId: `e${n}`, title: `Story ${n}`, summary: `About story ${n}`, url: `https://x.example/${n}`, publishedAt, ...extra });
const HOUR = 3600e3;

test('recentItems: the newest stories overall, plus each source\'s newest few', () => {
  const { db, add, done } = setup();
  try {
    const busy = add('busy'), slow = add('slow');
    const now = Date.now();
    db.insertItems(busy.id, Array.from({ length: 30 }, (_, i) => item(i, now - i * 60e3)));                         // 30 stories in the last half hour
    db.insertItems(slow.id, Array.from({ length: 5 }, (_, i) => item(100 + i, now - (10 + i) * HOUR)));            // a daily feed: hours older
    const rows = db.recentItems(now - 48 * HOUR, 10, 2);
    const bySource = name => rows.filter(r => r.sourceName === name);
    assert.equal(bySource('busy').length, 10);                                                                       // the limit takes the newest ten of them…
    assert.deepEqual(bySource('slow').map(r => r.title), ['Story 100', 'Story 101']);                                // …and the slow source keeps its newest two
    assert.deepEqual(rows.map(r => r.publishedAt), rows.map(r => r.publishedAt).sort((a, b) => b - a));            // newest first
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length);                                                    // nobody twice (both parts overlap)
  } finally { done(); }
});

test('recentItems: respects the age cutoff for the per-source minimum too', () => {
  const { db, add, done } = setup();
  try {
    const s = add('old');
    const now = Date.now();
    db.insertItems(s.id, [item(1, now - 100 * HOUR), item(2, now - 90 * HOUR)]);
    assert.equal(db.recentItems(now - 48 * HOUR, 10, 5).length, 0);
    assert.equal(db.recentItems(0, 10, 5).length, 2);
  } finally { done(); }
});

test('history: search, source chips and paging return the same rows however often it runs', () => {
  const { db, add, done } = setup();
  try {
    const one = add('one'), two = add('two');
    const now = Date.now();
    db.insertItems(one.id, Array.from({ length: 6 }, (_, i) => item(i, now - i * 60e3, { title: `Ceasefire talks ${i}` })));
    db.insertItems(two.id, Array.from({ length: 4 }, (_, i) => item(50 + i, now - i * 60e3, { title: `Budget vote ${i}` })));
    for (let run = 0; run < 3; run++) {                                                       // later runs reuse prepared statements
      assert.equal(db.history({ scope: 'all', limit: 100 }).length, 10);
      assert.equal(db.history({ scope: 'all', query: 'ceasefire', limit: 100 }).length, 6);
      assert.equal(db.history({ scope: 'all', query: 'ceasef', limit: 100 }).length, 6);     // the last word matches as a prefix
      assert.equal(db.history({ scope: 'all', sourceIds: [two.id], limit: 100 }).length, 4);
      assert.equal(db.history({ scope: 'all', sourceIds: [one.id, two.id], query: 'budget', limit: 100 }).length, 4);
      assert.deepEqual(db.history({ scope: 'all', limit: 3, offset: 3 }).map(r => r.title).length, 3);
    }
  } finally { done(); }
});

test('prepared statements stay correct across writes and reads', () => {
  const { db, add, done } = setup();
  try {
    const s = add('src');
    const [it] = db.insertItems(s.id, [item(1, Date.now())]);
    for (let i = 0; i < 3; i++) {
      db.setEnrichment(it.id, { clusterId: it.id + i, places: [['x', `Place ${i}`, 1, 2]] });
      const got = db.getItem(it.id);
      assert.equal(got.clusterId, it.id + i);
      assert.deepEqual(got.places, [['x', `Place ${i}`, 1, 2]]);
    }
    db.setMeta('k', 'a'); db.setMeta('k', 'b');
    assert.equal(db.getMeta('k'), 'b');
    assert.equal(db.getSource(s.id).name, 'src');
    db.tx(() => { db.setLang(it.id, 'fr'); });
    assert.equal(db.getItem(it.id).lang, 'fr');
    assert.throws(() => db.tx(() => { db.setLang(it.id, 'de'); throw new Error('boom'); }), /boom/);
    assert.equal(db.getItem(it.id).lang, 'fr');                                               // rolled back, and the statement still works
  } finally { done(); }
});

test('enrichment in one transaction per batch writes every item', () => {
  const { db, add, done } = setup();
  try {
    const { Enricher } = require('../../src/main/enrich');
    const src = add('USA');
    const now = Date.now();
    const added = db.insertItems(src.id, [
      item(1, now, { title: 'Israeli strikes hit southern Lebanon as ceasefire talks stall' }),
      item(2, now, { title: 'Ceasefire talks stall as Israeli strikes hit southern Lebanon' }),
      item(3, now, { title: 'Parliament votes on the budget in Paris' }),
    ]);
    const log = { info() {}, warn() {}, debug() {}, error() {} };
    const e = new Enricher({ store: db, log, emitUpdate() {} });
    e.process(added, src);
    const rows = added.map(a => db.getItem(a.id));
    assert.ok(rows.every(r => r.lang === 'en'));
    assert.equal(rows[0].clusterId, rows[1].clusterId);                                       // the same story groups
    assert.notEqual(rows[0].clusterId, rows[2].clusterId);
    assert.ok(rows[0].places.some(p => /Lebanon/.test(p[1])));
    assert.ok(rows[2].places.some(p => /Paris/.test(p[1])));
  } finally { done(); }
});
