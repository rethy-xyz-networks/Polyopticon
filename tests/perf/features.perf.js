'use strict';

// Time from an action to the next painted frame, for each feature of the window, with a realistic
// amount of data (5000 stories, 150 sources, places on most stories).
// Not part of `npm test` (timings vary by machine): `npm run test:perf`, or
// `npx playwright test --config playwright.perf.config.js features`.
// Prints one `PERF <name> {…}` line per feature; set PERF_JSON=<file> to also write them as JSON.

const fs = require('fs');
const { test, expect } = require('../e2e/fixtures');

test.use({ settings: { MaxFeedItems: 5000, GroupStories: true } });

const results = {};
const report = (name, value) => { results[name] = value; console.log(`PERF ${name} ${JSON.stringify(value)}`); };
test.afterAll(() => { if (process.env.PERF_JSON) fs.writeFileSync(process.env.PERF_JSON, JSON.stringify(results, null, 1)); });

test('feature timings', async ({ window }) => {
  test.setTimeout(240_000);
  const out = await window.evaluate(async () => {
    const feed = await import('./feed.js');
    const { state } = await import('./state.js');
    const sidebar = await import('./sidebar.js');
    const settings = await import('./settings.js');
    const map = await import('./map.js');
    const scratch = await import('./scratchpad.js');

    // Data
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const W = 'government officials said talks continue next week amid growing pressure allies rising prices region ceasefire strike minister parliament election court police border troops oil attack leader protest'.split(' ');
    const sentence = n => Array.from({ length: n }, () => W[Math.floor(rnd() * W.length)]).join(' ');
    const PLACES = [['us', 'United States', 38, -97], ['gb', 'United Kingdom', 54, -2], ['il', 'Israel', 31, 35], ['ua', 'Ukraine', 49, 32], ['ru', 'Russia', 60, 90], ['ir', 'Iran', 32, 53],
      ['kyiv', 'Kyiv', 50.4, 30.5], ['gaza', 'Gaza', 31.5, 34.4], ['dc', 'Washington', 38.9, -77], ['ldn', 'London', 51.5, -0.1], ['pek', 'Beijing', 39.9, 116.4], ['del', 'Delhi', 28.6, 77.2],
      ['cai', 'Cairo', 30, 31.2], ['teh', 'Tehran', 35.7, 51.4], ['mow', 'Moscow', 55.7, 37.6], ['par', 'Paris', 48.9, 2.3], ['ber', 'Berlin', 52.5, 13.4], ['tok', 'Tokyo', 35.7, 139.7]];

    // 150 sources
    const sources = Array.from({ length: 150 }, (_, i) => ({
      id: 1000 + i, type: 'rss', name: `Source ${i}`, grp: ['USA', 'UK', 'Israel', 'India', 'France', 'Germany', 'Other'][i % 7], category: null,
      color: `hsl(${(i * 37) % 360} 60% 45%)`, enabled: true, config: { url: `https://feed${i}.example.com/rss` },
    }));
    const { setSources } = await import('./state.js');
    setSources(sources);

    const N = 5000;
    const now = Date.now();
    const items = Array.from({ length: N }, (_, i) => ({
      id: 8e8 + i, sourceId: sources[i % 150].id, sourceName: sources[i % 150].name, kind: 'article',
      title: `Story ${i}: ${sentence(10)}`, summary: sentence(45), url: `https://feed${i % 150}.example.com/n/${i}`,
      publishedAt: now - i * 20e3, clusterId: 8e8 + Math.floor(i / 3) * 3 - (i % 5 === 0 ? 3 : 0),
      places: rnd() < 0.8 ? [PLACES[Math.floor(rnd() * PLACES.length)]] : [], lang: 'en',
    }));

    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const settle = async () => { await frame(); await frame(); };
    const time = async fn => { await settle(); const t0 = performance.now(); await fn(); await settle(); return performance.now() - t0; };
    const stats = a => { a = [...a].sort((x, y) => x - y); return { median: +a[a.length >> 1].toFixed(1), p95: +a[Math.min(a.length - 1, Math.floor(a.length * 0.95))].toFixed(1), n: a.length }; };
    const repeat = async (n, fn) => { const ts = []; for (let i = 0; i < n; i++) ts.push(await time(() => fn(i))); return stats(ts); };
    const R = {};

    // Feed. Arriving stories render at most every 350 ms (BATCH_RENDER_GAP_MS), so a timing could end before its
    // render; asking for one (as a user action does) puts the render inside the timing.
    const ingest = (list, fresh) => { feed.ingest(list, { fresh }); feed.scheduleRender(); };
    R.ingest5000 = Math.round(await time(() => ingest(items, false)));
    R.rows = document.querySelectorAll('#feed-list .item').length;

    const arrivals = n => Array.from({ length: n }, (_, i) => ({ ...items[0], id: 9e8 + Math.floor(rnd() * 1e8) + i, url: `https://n.example.com/${rnd()}`, title: `Breaking ${sentence(8)}`, publishedAt: Date.now() }));
    R.newArrivals25 = await repeat(10, () => ingest(arrivals(25), true));

    const search = document.getElementById('search');
    const type = text => { search.value = text; search.dispatchEvent(new Event('input')); };
    R.searchKeystroke = await repeat(12, i => type('government officials said'.slice(0, 3 + i)));
    type(''); await settle();
    R.searchRare = await repeat(6, i => type(i % 2 ? 'zzzz' : ''));
    R.searchCleared = await repeat(5, i => type(i % 2 ? 'oil' : ''));
    type(''); await settle();

    state.settings.GroupStories = false;
    R.ungroup = await repeat(4, () => { state.settings.GroupStories = !state.settings.GroupStories; feed.scheduleRender(); });
    state.settings.GroupStories = true;

    R.tagAdd = await repeat(6, i => { state.tags.Inclusions = i % 2 ? [] : [{ Text: 'police', IsActive: true, Scope: 0 }]; feed.rebuildTagCache(); feed.scheduleRender(); });
    state.tags.Inclusions = []; feed.rebuildTagCache(); feed.scheduleRender(); await settle();

    R.toggleSourceVisibility = await repeat(6, i => { for (let s = 0; s < 30; s++) { const id = sources[s].id; if (i % 2) state.hiddenSources.add(id); else state.hiddenSources.delete(id); } feed.scheduleRender(); });
    state.hiddenSources.clear(); feed.scheduleRender(); await settle();

    R.descriptionLengthChange = await repeat(4, i => { state.settings.DescriptionLength = i % 2 ? 300 : 120; feed.refreshRows(); });

    R.workerUpdate50 = await repeat(8, () => { feed.updateItems(items.slice(100, 150).map(it => ({ ...it, origTitle: null, places: it.places }))); feed.scheduleRender(); });

    // Scrolling through the whole list
    const list = document.getElementById('feed-list');
    const frames = []; let last = performance.now();
    for (let y = 0; y < 60000; y += 400) { list.scrollTop = y; await frame(); const t = performance.now(); frames.push(t - last); last = t; }
    R.scrollFrames = stats(frames);
    list.scrollTop = 0; await settle();

    // Sidebar
    R.renderSources = await repeat(5, () => sidebar.renderSources());
    const filter = document.getElementById('source-filter');
    R.sourceFilterKeystroke = await repeat(8, i => { filter.value = 'source 1'.slice(0, 2 + i); sidebar.applySourceFilter(); });
    filter.value = ''; sidebar.applySourceFilter();
    R.repaintCounts = await repeat(5, () => sidebar.repaintCounts());

    // Settings
    R.openSettings = await repeat(3, async () => { settings.openSettings('sources'); });
    R.renderSourceList = await repeat(5, () => settings.renderSourceList());
    settings.closeSettings(); await settle();

    // Map
    let t0 = performance.now();
    map.openMap();
    await new Promise(r => setTimeout(r, 1500));
    R.mapOpenAndFirstDraw = Math.round(performance.now() - t0);
    R.mapRefresh = await repeat(5, () => { map.onVisibleItems(); return new Promise(r => setTimeout(r, 600)); });
    R.mapFilterToggle = await repeat(4, i => { state.placeFilter = i % 2 ? null : { keys: ['us'], name: 'United States' }; map.refreshMapFilter(); });
    state.placeFilter = null;
    map.closeMap(); await settle();

    // Scratchpad highlighter
    const note = Array.from({ length: 400 }, (_, i) => `# Heading ${i}\n- item **bold** and *italic* with [a link](https://example.com/${i}) and \`code\`\n${sentence(30)}`).join('\n');
    const hl = [];
    for (let i = 0; i < 6; i++) { const t = performance.now(); scratch.highlight(note); hl.push(performance.now() - t); }
    R.scratchHighlight = stats(hl);

    R.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
    return R;
  });
  for (const [k, v] of Object.entries(out)) report(k, v);
  expect(out.rows).toBeGreaterThan(100);
});
