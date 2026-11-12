'use strict';

// Opinion polls: the Wikipedia poll-table parser and the fetcher's pacing. The wikitext below is made up in the
// page's layout (templates, references over several lines, event rows, the election row), not copied from it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDate, expandTemplates, findTable, parsePollTable, pageOf, createPolls, REFRESH_MS } = require('../../src/main/polls');

const TABLE = `{| class="wikitable sortable" style="text-align:center;"
|- style="height:40px;"
! rowspan="2" | Polling firm
! rowspan="2" | Last date {{nowrap|of polling{{efn|name=order|Ordered by date.}}}}
! rowspan="2" | Link
! style="width:40px;" | [[Alpha Party|AP]]
![[Beta Party|BP]]
! rowspan="2" style="width:40px" | [[List of parties|Others]]
! rowspan="2" | Margin<br/>{{nowrap|of error}}
! rowspan="2" | Sample<br/>size
! rowspan="2" | Polling<br/>method
! rowspan="2" | Lead
|- class="sorttop"
! style="background:{{Party colour|AP}};" |
! style="background:{{Party colour|BP}};" |
|-
|Firm One
|{{dts|November 7, 2026}}
|<ref name="one">{{Cite web |date=November 9, 2026 |title=Tracker
|url=https://example.org/one.pdf|website=example.org}}</ref>
| {{Party shading/Alpha}} |'''44'''
|31
|{{N/A}}
|±3.1 [[Percentage point|pp]]
|1,000
|IVR
| {{Party shading/Alpha}} |'''13'''
|-
| [[Firm Two Research|Firm Two]] ||{{Date table sorting|October 2, 2026}} || <ref name="one" /> || {{Party shading/Alpha}}|'''47.2'''
|| 26.4 || 1.4 || ±1.7 pp || 2,020 (1/4) || Telephone || {{Party shading/Alpha}} |'''20.8'''
|-
| style="border-right-style:hidden;" | || style="border-right-style:hidden;" | '''{{dts|August 31, 2026}}''' || colspan="8" | '''[[By-election]]s in [[North Riding]] and [[South Riding]].'''
|-
! colspan="10" |
|- style="background:#ffd;"
| ''[[2025 general election|2025 election]]'' || {{dts|2025|4|28}} || <ref>[https://results.example.org Results]</ref> || {{Party shading/Alpha}} | '''''43.8''''' || ''41.3'' || ''0.4'' || {{n/a}} || ''19,597,674'' || {{n/a}} || {{Party shading/Alpha}} | '''''2.5'''''
|}`;

const PAGE = `Intro.
== National polls ==
=== Graphical summary ===
[[File:Chart.svg]]
=== Table of polls ===
${TABLE}
=== Another table ===
{| class="wikitable"
|-
! Not this
|}`;

test('parseDate reads the formats the tables use', () => {
  assert.equal(parseDate('November 7, 2026'), '2026-11-07');
  assert.equal(parseDate('7 November 2026'), '2026-11-07');
  assert.equal(parseDate('2025-4-28'), '2025-04-28');
  assert.equal(parseDate('2025-04-28'), '2025-04-28');
  assert.equal(parseDate('February 30, 2026'), null);
  assert.equal(parseDate('Lead'), null);
});

test('expandTemplates keeps dates and wrapped text, drops shading and footnotes', () => {
  assert.equal(expandTemplates('{{dts|May 2, 2025}}'), 'May 2, 2025');
  assert.equal(expandTemplates('{{nowrap|of polling{{efn|x}}}}'), 'of polling');
  assert.equal(expandTemplates('{{Party shading/Liberal}} |44'), ' |44');
});

test('findTable takes the table under its heading, not the next one', () => {
  const t = findTable(PAGE, 'Table of polls');
  assert.ok(t.startsWith('{| class="wikitable sortable"'));
  assert.ok(t.endsWith('|}'));
  assert.ok(!t.includes('Not this'));
  assert.equal(findTable(PAGE, 'Graphical summary'), null);   // a heading with no table before the next heading
  assert.equal(findTable(PAGE, 'Missing'), null);
});

test('parsePollTable reads parties, polls, events and the election row', () => {
  const { parties, polls, events } = parsePollTable(findTable(PAGE, 'Table of polls'));
  assert.deepEqual(parties, ['AP', 'BP', 'Others']);
  assert.equal(polls.length, 3);
  assert.deepEqual(polls[0], {
    firm: 'Firm One', date: '2026-11-07', values: { AP: 44, BP: 31 }, moe: 3.1, sample: 1000, method: 'IVR', lead: 13,
    url: 'https://example.org/one.pdf',
  });
  assert.deepEqual(polls[1], {
    firm: 'Firm Two', date: '2026-10-02', values: { AP: 47.2, BP: 26.4, Others: 1.4 }, moe: 1.7, sample: 2020, method: 'Telephone', lead: 20.8,
    url: null,                                         // a reused reference has no URL of its own
  });
  assert.equal(polls[2].firm, '2025 election');
  assert.equal(polls[2].election, true);
  assert.equal(polls[2].date, '2025-04-28');
  assert.deepEqual(polls[2].values, { AP: 43.8, BP: 41.3, Others: 0.4 });
  assert.deepEqual(events, [{ date: '2026-08-31', text: 'By-elections in North Riding and South Riding.' }]);
});

const apiBody = (wikitext = PAGE) => ({ query: { pages: [{ title: 'Opinion polling for the next election', revisions: [{ revid: 7, timestamp: '2026-11-10T17:18:24Z', slots: { main: { content: wikitext } } }] }] } });

test('pageOf reads the revisions answer, and a missing page is null', () => {
  assert.equal(pageOf(apiBody()).revid, 7);
  assert.equal(pageOf({ query: { pages: [{ title: 'X', missing: true }] } }), null);
});

/** A fake API answering with each of `statuses` in turn (200 = the page). */
function fakeApi(statuses) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, ua: opts.headers['User-Agent'] });
    const status = statuses.shift() ?? 200;
    return { ok: status === 200, status, headers: { get: h => (h === 'retry-after' && status === 429 ? '120' : null) }, json: async () => apiBody() };
  };
  return { fetchFn, calls };
}

function setup(statuses = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polls-test-'));
  let t = 1_000_000;
  const timers = [];
  const data = [], status = [];
  const api = fakeApi(statuses);
  const polls = createPolls({
    dir, userAgent: () => 'Test/1 (contact)', fetchFn: api.fetchFn, now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return null; },
    onData: d => data.push(d), onStatus: s => status.push(s),
  });
  return { dir, polls, api, data, status, timers, advance: ms => { t += ms; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const settle = () => new Promise(r => setImmediate(r));

test('the fetcher asks once, saves the copy, and asks again only when it is stale', async () => {
  const s = setup();
  assert.equal(s.polls.get('ca'), null);
  await settle();
  assert.equal(s.api.calls.length, 1);
  assert.match(s.api.calls[0].url, /redirects=1/);
  assert.equal(s.api.calls[0].ua, 'Test/1 (contact)');
  assert.equal(s.data[0].polls.length, 3);
  assert.deepEqual(s.status.map(x => x.state), ['loading', 'ok']);
  assert.equal(s.polls.get('ca').revid, 7);          // fresh: answered from memory
  await settle();
  assert.equal(s.api.calls.length, 1);
  assert.ok(fs.existsSync(path.join(s.dir, 'ca.json')));
  s.advance(REFRESH_MS);
  s.polls.get('ca');
  await settle();
  assert.equal(s.api.calls.length, 2);
  s.done();
});

test('a saved copy is shown at once by a new fetcher; offline never asks', async () => {
  const s = setup();
  s.polls.get('ca');
  await settle();
  const again = createPolls({ dir: s.dir, userAgent: () => 'x', fetchFn: () => { throw new Error('should not fetch'); }, now: () => 1_000_000 });
  assert.equal(again.get('ca', { offline: true }).polls.length, 3);
  assert.equal(again.get('xx'), null);
  s.done();
});

test('a rate limit waits for Retry-After and retries on its own while the view is wanted', async () => {
  const s = setup([429]);
  s.polls.get('ca');
  await settle();
  assert.equal(s.status.at(-1).state, 'limited');
  assert.equal(s.status.at(-1).retryIn, 120);
  assert.equal(s.timers.at(-1).ms, 120_000);
  s.polls.get('ca', { force: true });                // paused: Refresh doesn't ask during the wait
  await settle();
  assert.equal(s.api.calls.length, 1);
  s.advance(120_000);
  s.timers.at(-1).fn();
  await settle();
  assert.equal(s.api.calls.length, 2);
  assert.equal(s.status.at(-1).state, 'ok');
  s.done();
});

test('Refresh on a fresh copy asks at most once a minute', async () => {
  const s = setup();
  s.polls.get('ca');
  await settle();
  s.polls.get('ca', { force: true });
  await settle();
  assert.equal(s.api.calls.length, 1);
  s.advance(60_000);
  s.polls.get('ca', { force: true });
  await settle();
  assert.equal(s.api.calls.length, 2);
  s.done();
});
