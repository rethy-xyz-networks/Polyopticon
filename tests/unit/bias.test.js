'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { httpJson, hostVariants, sourceHosts, domainsMatch, summarise, findOutlet, createChecker } = require('../../src/main/bias');

// What the API returns for an outlet (trimmed to the fields we read).
const outlet = (slug, domains, bias = [], fact = [], extra = {}) => ({
  slug, name: slug.toUpperCase(), domains,
  bias: { rating: 'x', reviews: bias.map(([reviewer, verdict]) => ({ reviewer, verdict })) },
  factuality: { rating: 'y', reviews: fact.map(([reviewer, verdict]) => ({ reviewer, verdict })) },
  observed: { storyCount: extra.stories ?? 10 },
  links: { canonical: `https://mediabias.news/sources/${slug}` },
});

/** A fake API: search by substring of the slug, detail by slug. Counts requests. */
function fakeApi(outlets) {
  const calls = [];
  const getJson = async url => {
    calls.push(url);
    const u = new URL(url);
    const m = u.pathname.match(/\/outlets\/(.+)$/);
    if (m) { const o = outlets.find(x => x.slug === decodeURIComponent(m[1])); return o ? { outlet: o } : null; }
    const q = u.searchParams.get('q');
    return { outlets: outlets.filter(o => o.slug.includes(q.split('.')[0]) || o.domains.some(d => d.includes(q))).map(o => ({ slug: o.slug })) };
  };
  return { getJson, calls };
}

test('hostVariants: parent domains, but never a bare public suffix like co.uk', () => {
  assert.deepEqual(hostVariants('abcnews.go.com'), ['abcnews.go.com', 'go.com']);
  assert.deepEqual(hostVariants('feeds.bbci.co.uk'), ['feeds.bbci.co.uk', 'bbci.co.uk']);
  assert.deepEqual(hostVariants('npr.org'), ['npr.org']);
  // A short name under a country code is a site, not a suffix (this once produced no queries for CBC, RFI, RÚV)
  assert.deepEqual(hostVariants('cbc.ca'), ['cbc.ca']);
  assert.deepEqual(hostVariants('www.rfi.fr'), ['www.rfi.fr', 'rfi.fr']);
  assert.deepEqual(hostVariants('ruv.is'), ['ruv.is']);
  assert.deepEqual(hostVariants('japantimes.co.jp'), ['japantimes.co.jp']);
});

test('sourceHosts: the feed host plus the most common hosts of its story links', () => {
  const links = ['https://www.bbc.co.uk/a', 'https://www.bbc.co.uk/b', 'https://bbc.com/c', 'https://cdn.example.org/d', 'not a url'];
  assert.deepEqual(sourceHosts('https://feeds.bbci.co.uk/news/rss.xml', links), ['feeds.bbci.co.uk', 'bbc.co.uk', 'bbc.com']);
  assert.deepEqual(sourceHosts('https://www.npr.org/rss', []), ['npr.org']);
});

test('domainsMatch: the outlet\'s domain, or a parent of the host; not a look-alike', () => {
  assert.ok(domainsMatch(['go.com', 'abcnews.com'], ['abcnews.go.com']));
  assert.ok(domainsMatch(['pbs.org'], ['pbs.org']));
  assert.ok(!domainsMatch(['cascadepbs.org'], ['pbs.org']));
  assert.ok(!domainsMatch(['news.sky.com'], ['sky.com']));      // narrower than the feed's host: not shown to be the same outlet
  assert.ok(!domainsMatch([], ['pbs.org']));
});

test('summarise: the mean of the raters places an outlet more finely than the API\'s own rating', () => {
  const nbc = summarise(outlet('nbc', ['nbcnews.com'],
    [['AllSides', 'leanLeft'], ['Ad Fontes Media', 'center'], ['Media Bias/Fact Check', 'leanLeft']],
    [['Ad Fontes Media', 'mixed'], ['Media Bias/Fact Check', 'high']]));
  assert.equal(nbc.x, -0.67);                      // between "lean left" (-1) and "center" (0)
  assert.equal(nbc.y, 2.5);                        // between mixed and high
  assert.deepEqual(nbc.bias[0], ['AllSides', 'leanLeft']);
  assert.equal(nbc.url, 'https://mediabias.news/sources/nbc');
});

test('summarise: british "centre", unknown verdicts and missing reviews', () => {
  assert.equal(summarise(outlet('a', ['a.com'], [['AllSides', 'centre']])).x, 0);
  assert.equal(summarise(outlet('b', ['b.com'], [['AllSides', 'somethingNew'], ['MBFC', 'right']])).x, 2);   // unknown verdicts are ignored
  const none = summarise(outlet('c', ['c.com']));
  assert.equal(none.x, null);                      // no rater: matched, but nothing to plot
  assert.equal(none.y, null);
});

test('findOutlet: a fuzzy hit counts only when its domains include the feed\'s', async () => {
  const api = fakeApi([
    outlet('cascadepbsorg', ['cascadepbs.org'], [['AllSides', 'leanLeft']], [], { stories: 999 }),
    outlet('pbs-newshour', ['pbs.org'], [['AllSides', 'leanLeft']], [['Ad Fontes Media', 'veryHigh']], { stories: 5 }),
  ]);
  const found = await findOutlet(['pbs.org'], api.getJson);
  assert.equal(found.slug, 'pbs-newshour');
  assert.equal(await findOutlet(['example.net'], api.getJson), null);
});

test('findOutlet: story-link hosts find an outlet whose domains don\'t include the feed\'s host', async () => {
  const api = fakeApi([outlet('bbc-news', ['bbc.com', 'bbc.co.uk'], [['AllSides', 'center']])]);
  assert.equal(await findOutlet(['feeds.bbci.co.uk'], api.getJson), null);
  assert.equal((await findOutlet(['feeds.bbci.co.uk', 'bbc.co.uk'], api.getJson)).slug, 'bbc-news');
});

test('findOutlet: an entry with reviews beats an unreviewed "-affiliated" one', async () => {
  const api = fakeApi([
    outlet('rt-affiliated', ['rt.com'], [], [], { stories: 500 }),
    outlet('rt-reviewed', ['rt.com'], [['MBFC', 'right']], [], { stories: 1 }),
  ]);
  assert.equal((await findOutlet(['rt.com'], api.getJson)).slug, 'rt-reviewed');
});

// The background run

function fakeDb(sources, urls = {}) {
  const bias = new Map();
  return {
    bias,
    listSources: () => sources,
    listBias: () => [...bias].map(([sourceId, outlet]) => ({ sourceId, checkedAt: 1, outlet })),
    setBias: (id, o) => bias.set(id, o),
    clearBias: id => (id == null ? bias.clear() : bias.delete(id)),
    recentUrls: id => urls[id] ?? [],
  };
}
const rss = (id, url) => ({ id, name: `s${id}`, type: 'rss', config: { url } });

test('createChecker: each source is looked up once; a second run asks nothing', async () => {
  const api = fakeApi([outlet('npr', ['npr.org'], [['AllSides', 'leanLeft']])]);
  const db = fakeDb([rss(1, 'https://feeds.npr.org/1001/rss.xml'), rss(2, 'https://example.net/feed'), { id: 3, name: 'tg', type: 'telegram', config: {} }],
    { 1: ['https://www.npr.org/a'], 2: ['https://example.net/a'] });
  const checker = createChecker({ db, getJson: api.getJson, gapMs: 0 });
  await checker.checkPending();
  assert.equal(db.bias.get(1).slug, 'npr');
  assert.equal(db.bias.get(2), null);              // checked, nothing matched: marked off all the same
  assert.equal(db.bias.has(3), false);             // only RSS feeds have a site to look up
  const asked = api.calls.length;
  await checker.checkPending();
  assert.equal(api.calls.length, asked);
});

test('createChecker: a source that has published nothing yet is not marked "no match"', async () => {
  const api = fakeApi([]);
  const db = fakeDb([rss(1, 'https://example.net/feed')]);
  await createChecker({ db, getJson: api.getJson, gapMs: 0 }).checkPending();
  assert.equal(db.bias.has(1), false);
});

test('createChecker: sources of one outlet share the requests; recheckAll forgets and asks again', async () => {
  const api = fakeApi([outlet('scmp', ['scmp.com'], [['AllSides', 'center']])]);
  const db = fakeDb([rss(1, 'https://www.scmp.com/rss/4/feed'), rss(2, 'https://www.scmp.com/rss/5/feed/')], { 1: ['https://scmp.com/a'], 2: ['https://scmp.com/b'] });
  const checker = createChecker({ db, getJson: api.getJson, gapMs: 0 });
  await checker.checkPending();
  assert.equal(db.bias.size, 2);
  assert.equal(api.calls.length, 2);               // one search and one detail for both feeds
  await checker.recheckAll();
  assert.equal(db.bias.size, 2);
  assert.equal(api.calls.length, 4);
});

test('createChecker: when the service can\'t be reached, nothing is marked and the run stops', async () => {
  let calls = 0;
  const db = fakeDb([rss(1, 'https://a.com/f'), rss(2, 'https://b.com/f')], { 1: ['https://a.com/x'], 2: ['https://b.com/x'] });
  const getJson = async () => { calls++; throw Object.assign(new Error('unreachable'), { offline: true }); };
  await createChecker({ db, getJson, gapMs: 0, log: { info() {}, warn() {} } }).checkPending();
  assert.equal(db.bias.size, 0);
  assert.equal(calls, 1);
});

// HTTP

const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });

test('httpJson: 404 is null; 429 waits out Retry-After and tries again; failures are flagged offline', async () => {
  const waits = [];
  const wait = async ms => waits.push(ms);
  const queue = [res(429, null, { 'retry-after': '60' }), res(200, { ok: 1 })];
  assert.deepEqual(await httpJson(async () => queue.shift(), { wait })('u'), { ok: 1 });
  assert.deepEqual(waits, [60_500]);

  assert.equal(await httpJson(async () => res(404), { wait })('u'), null);
  await assert.rejects(httpJson(async () => { throw new Error('ENOTFOUND'); }, { wait })('u'), e => e.offline === true);
  await assert.rejects(httpJson(async () => res(429, null, { 'retry-after': '1' }), { wait, retries: 2 })('u'), e => e.offline === true);
  await assert.rejects(httpJson(async () => res(500), { wait })('u'), e => !e.offline && /HTTP 500/.test(e.message));
});
