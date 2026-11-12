'use strict';

// Opinion polls: the Wikipedia poll-table parser, the sets built from a page and the fetcher's pacing. The wikitext
// below is made up in the pages' layouts (templates, references over several lines, event rows, the election row,
// cells spanning rows, a question over its answers), not copied from them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDate, expandTemplates, findTable, tablesOf, refsOf, parsePollTable, buildSet, pagesOf, createPolls, COUNTRIES, REFRESH_MS } = require('../../src/main/polls');

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
|}
== Leadership polls ==
=== 2026 ===
{| class="wikitable"
! rowspan="2" |Polling firm
! rowspan="2" |Last date {{nowrap|of polling}}
! rowspan="2" |Link
! style="width:40px;" |[[Ann Alpha]]
! style="width:40px;" |[[Bo Beta]]
! rowspan="2" |Unsure/{{wbr}}none
! rowspan="2" |Lead
|- class="sorttop"
! style="background-color:{{Party colour|XX|Alpha}} " |
! style="background-color:{{Party colour|XX|Beta}} " |
|-
|Firm One || {{dts|November 6, 2026}} || <ref name="one" /> || '''54.4''' || 20.4 || 12.4 || '''34.0'''
|}
=== 2025 ===
{| class="wikitable"
! rowspan="2" |Polling firm
! rowspan="2" |Last date {{nowrap|of polling}}
! rowspan="2" |Link
! style="width:40px;" |[[Ann Alpha]]
! style="width:40px;" |[[Cy Beta]]
! rowspan="2" |Unsure/{{wbr}}none
! rowspan="2" |Lead
|- class="sorttop"
! style="background-color:{{Party colour|XX|Alpha}} " |
! style="background-color:{{Party colour|XX|Beta}} " |
|-
|Firm One || {{dts|May 2, 2025}} || [https://example.org/old.pdf PDF] || '''46.9''' || 40.7 || 8.5 || '''6.2'''
|}
== Regional polls ==
=== East ===
==== [[North Province|North]] ====
${TABLE}
==== South ====
${TABLE.replace('Firm One', 'Firm Nine')}
== Independence ==
{| class="wikitable sortable"
! rowspan="2" |Date(s)<br />conducted
! rowspan="2" |Polling organisation/client
! rowspan="2" |Sample size
! colspan="3" |Should Northland be an independent country?
! rowspan="2" |Lead
|-
! class="unsortable" style="background: green;" | Yes
! class="unsortable" style="background: red;" |No
! class="unsortable" | Undecided
|-
| colspan="12" align="center" |The '''[[Northland Party]] is elected''' (October 5, 2026)
|-
| data-sort-value="2026-05-18" | May 11–18, 2026
|[https://example.org/indep.pdf Firm Three/The Paper]
|| 1,027 || 32% || style="background: red;"|'''68%''' || – || 36
|-
|July–August 2025
|[https://polls.example.org/summer.pdf]
|| 1000 || 41% || '''59%''' || 9% || 18
|}
== Another leader ==
{| class="wikitable"
! Polling firm !! Last date<br />of polling !! Link !! Hypothetical Leader !! [[Alpha Party|AP]] !! [[Beta Party|BP]] !! [[Undecided]] !! Sample<br />size
|-
| rowspan="2" |[[Firm Two]]
| rowspan="2" |{{opdrts|4|8|Nov|2025|year}}
| rowspan="2" |<ref>{{cite web |title=What if |url=https://example.org/whatif}}</ref>
|[[Dee Delta]]
|'''40'''
|23
|17
| rowspan="2" |1,244
|-
|[[Ed Echo]]
|36
|'''38'''
|15
|}`;

test('parseDate reads the formats the tables use', () => {
  assert.equal(parseDate('November 7, 2026'), '2026-11-07');
  assert.equal(parseDate('7 November 2026'), '2026-11-07');
  assert.equal(parseDate('2025-4-28'), '2025-04-28');
  assert.equal(parseDate('2025-04-28'), '2025-04-28');
  assert.equal(parseDate('February 30, 2026'), null);
  assert.equal(parseDate('Lead'), null);
});

test('parseDate takes the last day of a range, and of a month given alone', () => {
  assert.equal(parseDate('October 16–18, 2026'), '2026-10-18');
  assert.equal(parseDate('Oct 30 – Nov 2, 2026'), '2026-11-02');
  assert.equal(parseDate('16–28 Sep 2026'), '2026-09-28');
  assert.equal(parseDate('Sep 17, 2025–20, 2025'), '2025-09-20');
  assert.equal(parseDate('December 28, 2025 – January 3, 2026'), '2026-01-03');
  assert.equal(parseDate('August 2026'), '2026-08-31');
  assert.equal(parseDate('July–August 2025'), '2025-08-31');
  assert.equal(parseDate('Decision 5, 2026'), null);          // not a month
  assert.equal(parseDate(null), null);
});

test('expandTemplates keeps dates and wrapped text, drops shading and footnotes', () => {
  assert.equal(expandTemplates('{{dts|May 2, 2025}}'), 'May 2, 2025');
  assert.equal(expandTemplates('{{nowrap|of polling{{efn|x}}}}'), 'of polling');
  assert.equal(expandTemplates('{{Party shading/Liberal}} |44'), ' |44');
  assert.equal(expandTemplates('{{Dts|May 3, 2026|format=hide}} May 3, 2026'), ' May 3, 2026');
  assert.equal(expandTemplates('{{opdrts|22|26|Oct|2026|year}}'), '26 Oct 2026');
  assert.equal(expandTemplates('{{opdrts|27|Jan|2|Feb|2026}}'), '2 Feb 2026');
  assert.equal(expandTemplates('{{opdrts|4|6|1|2026|year}}'), '2026-1-6');             // the month as a number
  assert.equal(expandTemplates("{{white|'''+37%'''}}"), "'''+37%'''");
  assert.equal(expandTemplates('{{tooltip|2=Margin of Error|MoE}}'), 'MoE');
  assert.equal(expandTemplates('background:{{Canadian party colour|CA|Liberal}};'), 'background:@@pc:Liberal@@;');
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
  const { options, names, partyOf, polls, events } = parsePollTable(findTable(PAGE, 'Table of polls'));
  assert.deepEqual(options, ['AP', 'BP', 'Others']);
  assert.deepEqual(names, { AP: 'Alpha Party', BP: 'Beta Party' });              // "List of parties" is no party's name
  assert.deepEqual(partyOf, { AP: 'AP', BP: 'BP' });
  assert.equal(polls.length, 3);
  assert.deepEqual(polls[0], {
    firm: 'Firm One', date: '2026-11-07', values: { AP: 44, BP: 31 }, moe: 3.1, sample: 1000, method: 'IVR', lead: 13,
    url: 'https://example.org/one.pdf',
  });
  assert.deepEqual(polls[1], {
    firm: 'Firm Two', date: '2026-10-02', values: { AP: 47.2, BP: 26.4, Others: 1.4 }, moe: 1.7, sample: 2020, method: 'Telephone', lead: 20.8,
    url: null,                                         // a reused reference has no URL of its own
  });
  const cited = parsePollTable(findTable(PAGE, 'Table of polls'), { refs: refsOf(PAGE) });
  assert.equal(cited.polls[1].url, 'https://example.org/one.pdf');               // found where the reference is defined
  assert.equal(polls[2].firm, '2025 election');
  assert.equal(polls[2].election, true);
  assert.equal(polls[2].date, '2025-04-28');
  assert.deepEqual(polls[2].values, { AP: 43.8, BP: 41.3, Others: 0.4 });
  assert.deepEqual(events, [{ date: '2026-08-31', text: 'By-elections in North Riding and South Riding.' }]);
});

const page = () => ({ title: 'Opinion polling for the 1st election', revid: 7, edited: 1, wikitext: PAGE });

test('tablesOf gives every table the headings above it', () => {
  assert.deepEqual(tablesOf(PAGE).map(t => t.path.join(' > ')), [
    'National polls > Table of polls', 'National polls > Another table', 'Leadership polls > 2026', 'Leadership polls > 2025',
    'Regional polls > East > North', 'Regional polls > East > South', 'Independence', 'Another leader',
  ]);
});

test('a set of several tables by period is one series, each answer wearing its party', () => {
  const set = buildSet({ id: 'pm', group: 'G', label: 'Preferred PM', page: 'P', under: [/^Leadership/i], merge: true }, page());
  assert.deepEqual(set.options, ['Ann Alpha', 'Bo Beta', 'Unsure/none', 'Cy Beta']);
  assert.deepEqual(set.partyOf, { 'Ann Alpha': 'Alpha', 'Bo Beta': 'Beta', 'Cy Beta': 'Beta' });
  assert.deepEqual(set.polls.map(p => [p.date, p.values['Ann Alpha'], p.lead, p.url]), [
    ['2026-11-06', 54.4, 34, 'https://example.org/one.pdf'], ['2025-05-02', 46.9, 6.2, 'https://example.org/old.pdf'],
  ]);
  assert.deepEqual(set.variants, []);
  assert.equal(set.kind, 'question');
  assert.equal(set.url, 'https://en.wikipedia.org/wiki/Opinion_polling_for_the_1st_election#Leadership_polls');
});

test('a set of a table per place has a variant per table, named by its heading', () => {
  const set = buildSet({ id: 'r', group: 'G', label: 'By province', kind: 'parties', page: 'P', under: ['Regional polls'], variant: 'Province' }, page());
  assert.equal(set.variantLabel, 'Province');
  assert.deepEqual(set.variants, ['North', 'South']);
  assert.equal(set.polls.filter(p => p.variant === 'South').length, 3);
  assert.equal(set.polls.find(p => p.variant === 'South').firm, 'Firm Nine');
  assert.deepEqual(set.events.map(e => e.variant), ['North', 'South']);
  // The table directly under the headings takes the base name; one whose heading is skipped is left out
  const base = buildSet({ id: 'n', group: 'G', label: 'National', page: 'P', under: ['National polls'], variant: 'Voters', base: 'Everyone', skip: /another/i }, page());
  assert.deepEqual(base.variants, ['Table of polls']);
  assert.equal(buildSet({ id: 'x', group: 'G', label: 'X', page: 'P', under: ['No such heading'] }, page()), null);
});

test('a question over its answers: the date column first, a firm given as a link, an event dated in its text', () => {
  const { options, polls, events } = parsePollTable(findTable(PAGE, 'Independence'));
  assert.deepEqual(options, ['Yes', 'No', 'Undecided']);
  assert.deepEqual(polls, [
    { firm: 'Firm Three/The Paper', date: '2026-05-18', values: { Yes: 32, No: 68 }, moe: null, sample: 1027, method: null, lead: 36, url: 'https://example.org/indep.pdf' },
    { firm: 'polls.example.org', date: '2025-08-31', values: { Yes: 41, No: 59, Undecided: 9 }, moe: null, sample: 1000, method: null, lead: 18, url: 'https://polls.example.org/summer.pdf' },
  ]);
  assert.deepEqual(events, [{ date: '2026-10-05', text: 'The Northland Party is elected (October 5, 2026)' }]);
});

test('a cell template like {{N/A}} carries its attributes: N/A across two rows is no number', () => {
  const { polls } = parsePollTable(`{| class="wikitable"
! colspan="5" |Should it happen?
|-
!Date
!Pollster/company
!Yes
!No
!Unsure
|-
|January 16, 2025
|[[Firm One]]
|20%
|'''80%'''
|rowspan="2" {{N/A}}
|-
|January 14, 2025
|[[Firm Two]]
|10%
|'''90%'''
|-
|December 10, 2024
|Firm Three
|13%
|82%
|style="color:grey" {{n/a}}
|-
|December 1, 2024
|Firm Four
|12%
|80%
|8%
|}`);
  assert.deepEqual(polls.map(p => [p.firm, p.values]), [
    ['Firm One', { Yes: 20, No: 80 }], ['Firm Two', { Yes: 10, No: 90 }], ['Firm Three', { Yes: 13, No: 82 }], ['Firm Four', { Yes: 12, No: 80, Unsure: 8 }],
  ]);
});

test('a column that splits the table is the variant, and cells spanning rows reach every row they cover', () => {
  const { options, variantLabel, polls } = parsePollTable(findTable(PAGE, 'Another leader'));
  assert.deepEqual(options, ['AP', 'BP', 'Undecided']);
  assert.equal(variantLabel, 'Hypothetical Leader');
  assert.deepEqual(polls.map(p => [p.firm, p.date, p.variant, p.values.AP, p.sample, p.url]), [
    ['Firm Two', '2025-11-08', 'Dee Delta', 40, 1244, 'https://example.org/whatif'],
    ['Firm Two', '2025-11-08', 'Ed Echo', 36, 1244, 'https://example.org/whatif'],
  ]);
});

// The API: every page the country's sets name exists and holds PAGE, unless `missing` matches its title. A
// "Next …" title redirects, as the real ones do.
const FEDERAL = COUNTRIES.ca.sets[0].page;
function fakeApi(statuses, { missing = /general election|sovereignty|separatist|annexation/, revid = () => 7 } = {}) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const u = new URL(url);
    const titles = u.searchParams.get('titles').split('|');
    const content = u.searchParams.get('rvprop').includes('content');
    calls.push({ url, titles, content, ua: opts.headers['User-Agent'] });
    const status = statuses.shift() ?? 200;
    const body = { query: { redirects: [], pages: [] } };
    for (const t of titles) {
      const to = t.replace(' the next ', ' the 1st ');
      if (to !== t) body.query.redirects.push({ from: t, to });
      if (missing.test(to)) body.query.pages.push({ title: to, missing: true });
      else body.query.pages.push({ title: to, revisions: [{ revid: revid(to), timestamp: '2026-11-10T17:18:24Z', ...(content ? { slots: { main: { content: PAGE } } } : {}) }] });
    }
    return { ok: status === 200, status, headers: { get: h => (h === 'retry-after' && status === 429 ? '120' : null) }, json: async () => body };
  };
  return { fetchFn, calls };
}

test('answers under several headings are read heading by heading, each heading a variant with its own lead', () => {
  const { options, variantLabel, polls } = parsePollTable(`{| class="wikitable"
|-
! colspan="9" | Leader approval
|-
! rowspan="2" | Pollster !! rowspan="2" | Fieldwork date !! rowspan="2" | Sample size
! colspan="3" | [[Ann Alpha]] !! colspan="3" | [[Bo Beta]]
|-
! Pos. !! Neg. !! Net !! Pos. !! Neg. !! Net
|-
| Firm One || 3–5 Nov 2026 || 2.004 || 40 || 45 || {{Nowrap|–5}} || 30 || 20 || +10
|-
| Firm Two || 1 Nov 2026 || 1,500 || 42 || 40 || +2 || 31 || 22 || +9
|}`);
  // The title across the table is no heading; "2.004" is a thousands dot; "–5" is minus five
  assert.deepEqual(options, ['Pos.', 'Neg.']);
  assert.equal(variantLabel, 'Group');
  assert.deepEqual(polls.map(p => [p.firm, p.variant, p.values['Pos.'], p.values['Neg.'], p.lead, p.sample]), [
    ['Firm One', 'Ann Alpha', 40, 45, -5, 2004], ['Firm One', 'Bo Beta', 30, 20, 10, 2004],
    ['Firm Two', 'Ann Alpha', 42, 40, 2, 1500], ['Firm Two', 'Bo Beta', 31, 22, 9, 1500],
  ]);
});

test('a party over its parts is given whole or added up; a number across other answers is theirs jointly', () => {
  const { options, polls } = parsePollTable(`{| class="wikitable"
! rowspan="2" | Date !! rowspan="2" | Firm !! rowspan="2" | ALP !! colspan="2" | L/NP !! rowspan="2" | {{vert header|Grn}} !! rowspan="2" | Ref !! rowspan="2" | Others
|-
! Lib !! Nat
|-
| 12–14 Mar || Firm One || 30 || colspan="2" | 35 || 12 || 8 || 15
|-
| 5–7 Mar || Firm Two || 31 || 29 || 4 || 12 || 9 || 15
|-
| 1 Mar || Firm Three || 32 || 30 || 3 || colspan="2" | 20 || 15
|}`, { year: 2026 });
  // Dates without a year take the year of the heading; "Ref" full of numbers is a party, not a reference
  assert.deepEqual(options, ['ALP', 'Lib', 'Nat', 'Grn', 'Ref', 'Others', 'L/NP', 'Grn + Ref']);
  assert.deepEqual(polls.map(p => [p.date, p.values]), [
    ['2026-03-14', { ALP: 30, 'L/NP': 35, Grn: 12, Ref: 8, Others: 15 }],
    ['2026-03-07', { ALP: 31, Lib: 29, Nat: 4, Grn: 12, Ref: 9, Others: 15, 'L/NP': 33 }],
    ['2026-03-01', { ALP: 32, Lib: 30, Nat: 3, 'Grn + Ref': 20, Others: 15, 'L/NP': 33 }],
  ]);
});

test('a heading over some answers that no poll gives as one number is a question, not an answer', () => {
  const { options, polls } = parsePollTable(`{| class="wikitable"
! rowspan="2" | Firm !! rowspan="2" | Date !! colspan="2" | Referendum in 2023? !! rowspan="2" | Unsure/<br>Other
|-
! Yes !! No
|-
| Firm One || 2 May 2026 || 22 || 68 || 10
|-
| Firm Two || 1 May 2026 || 25 || 65 || 10
|}`);
  assert.deepEqual(options, ['Yes', 'No', 'Unsure/Other']);
  assert.deepEqual(polls[0].values, { Yes: 22, No: 68, 'Unsure/Other': 10 });
});

test("each answer keeps the article its heading links; a person's party in brackets is not part of their name", () => {
  const { options, names, pages } = parsePollTable(`{| class="wikitable"
! Firm !! Date !! {{vert header|mw=35px|stp=1|[[Nathalie Arthaud]] [[Lutte Ouvrière|(LO)]]}} !! [[Labour Party (UK)|Lab]] !! [[Reform UK]] !! Others
|-
| Firm One || 2 May 2026 || 2 || 30 || 28 || 40
|-
| Firm Two || 1 May 2026 || 1 || 31 || 27 || 41
|}`);
  assert.deepEqual(options, ['Nathalie Arthaud', 'Lab', 'Reform UK', 'Others']);
  assert.deepEqual(pages, { 'Nathalie Arthaud': 'Nathalie Arthaud', Lab: 'Labour Party (UK)', 'Reform UK': 'Reform UK' });
  assert.deepEqual(names, { Lab: 'Labour Party' });
});

test('seat projections run to the hundreds, percentages stop at 100', () => {
  const table = `{| class="wikitable"
! Firm !! Date !! EPP !! S&D !! Others
|-
| Firm One || 31 Oct 2026 || 173 || 120 || 8
|-
| Firm Two || 30 Sep 2026 || 171 || 118 || 7
|}`;
  assert.deepEqual(parsePollTable(table, { max: 1000 }).polls[0].values, { EPP: 173, 'S&D': 120, Others: 8 });
  assert.equal(parsePollTable(table)?.polls.length ?? 0, 0);                  // read as percentages, no poll is left
  const set = buildSet({ id: 's', group: 'G', label: 'Seats', page: 'P', unit: 'seats', under: ['Seats'] },
    { title: 'P', revid: 1, edited: 1, wikitext: `== Seats ==\n${table}` });
  assert.equal(set.unit, 'seats');
  assert.equal(set.polls[0].values.EPP, 173);
});

test('pagesOf follows redirects to each title asked for, and a missing page has no entry', () => {
  const body = { query: { redirects: [{ from: 'Next', to: 'First' }], pages: [
    { title: 'First', revisions: [{ revid: 7, timestamp: '2026-11-10T17:18:24Z', slots: { main: { content: 'text' } } }] }, { title: 'Gone', missing: true }] } };
  const pages = pagesOf([body], ['Next', 'Gone']);
  assert.deepEqual([...pages.keys()], ['Next']);
  assert.deepEqual(pages.get('Next'), { title: 'First', revid: 7, edited: Date.parse('2026-11-10T17:18:24Z'), wikitext: 'text' });
});

function setup(statuses = [], opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polls-test-'));
  let t = 1_000_000;
  const timers = [];
  const data = [], status = [];
  const api = fakeApi(statuses, opts);
  const polls = createPolls({
    dir, userAgent: () => 'Test/1 (contact)', fetchFn: api.fetchFn, now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return null; },
    onData: d => data.push(d), onStatus: s => status.push(s),
  });
  return { dir, polls, api, data, status, timers, advance: ms => { t += ms; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('the fetcher asks for revision ids, then for the text of the pages that changed, and saves the sets', async () => {
  const s = setup();
  assert.equal(s.polls.get('ca'), null);
  await settle();
  // ids of the fixed titles; ids of the title derived from where the federal page now lives; the text of both
  assert.deepEqual(s.api.calls.map(c => c.content), [false, false, true]);
  assert.ok(s.api.calls[0].titles.includes(FEDERAL));
  assert.deepEqual(s.api.calls[1].titles, ['Opinion polling for the 1st Canadian federal election by constituency']);
  assert.deepEqual(s.api.calls[2].titles, [FEDERAL, 'Opinion polling for the 1st Canadian federal election by constituency']);
  assert.match(s.api.calls[0].url, /redirects=1/);
  assert.equal(s.api.calls[0].ua, 'Test/1 (contact)');
  const d = s.data[0];
  assert.deepEqual(d.sets.map(x => x.id), ['vote', 'pm', 'regional', 'ridings']);   // the tables PAGE has; pages that don't exist give none
  assert.equal(d.sets[0].polls.length, 3);
  assert.equal(d.sets[0].names.AP, 'Alpha Party');
  assert.equal(d.sets[0].title, 'Opinion polling for the 1st Canadian federal election');
  assert.deepEqual(s.status.map(x => x.state), ['loading', 'ok']);
  assert.equal(s.polls.get('ca').sets[0].revid, 7);  // fresh: answered from memory
  await settle();
  assert.equal(s.api.calls.length, 3);
  assert.ok(fs.existsSync(path.join(s.dir, 'ca.json')));
  s.done();
});

test('a later check is one request while no page has changed, and reads only the page that has', async () => {
  let federal = 7;
  const s = setup([], { revid: t => (/constituency/.test(t) ? 3 : federal) });
  s.polls.get('ca');
  await settle();
  s.advance(REFRESH_MS);
  s.polls.get('ca');
  await settle();
  assert.equal(s.api.calls.length, 4);
  assert.equal(s.api.calls[3].content, false);
  assert.ok(s.api.calls[3].titles.includes('Opinion polling for the 1st Canadian federal election by constituency'));   // last time's title, asked with the rest
  assert.equal(s.data[1].sets.length, 4);
  assert.equal(s.data[1].fetchedAt, 1_000_000 + REFRESH_MS);
  federal = 8;
  s.advance(REFRESH_MS);
  s.polls.get('ca');
  await settle();
  assert.deepEqual(s.api.calls.slice(4).map(c => [c.content, c.titles.length]), [[false, s.api.calls[0].titles.length + 1], [true, 1]]);
  assert.deepEqual(s.data[2].sets.map(x => x.revid), [8, 8, 8, 3]);
  s.done();
});

test('a saved copy is shown at once by a new fetcher; offline never asks; an older format is not used', async () => {
  const s = setup();
  s.polls.get('ca');
  await settle();
  const fresh = () => createPolls({ dir: s.dir, userAgent: () => 'x', fetchFn: () => { throw new Error('should not fetch'); }, now: () => 1_000_000 });
  assert.equal(fresh().get('ca', { offline: true }).sets[0].polls.length, 3);
  assert.equal(fresh().get('xx'), null);
  fs.writeFileSync(path.join(s.dir, 'ca.json'), JSON.stringify({ country: 'ca', polls: [], parties: [] }));
  assert.equal(fresh().get('ca', { offline: true }), null);
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
  assert.equal(s.api.calls.length, 4);
  assert.equal(s.status.at(-1).state, 'ok');
  s.done();
});

test('Refresh on a fresh copy asks at most once a minute', async () => {
  const s = setup();
  s.polls.get('ca');
  await settle();
  s.polls.get('ca', { force: true });
  await settle();
  assert.equal(s.api.calls.length, 3);
  s.advance(60_000);
  s.polls.get('ca', { force: true });
  await settle();
  assert.equal(s.api.calls.length, 4);
  s.done();
});

test('no poll table anywhere is an error, retried later', async () => {
  const s = setup([], { missing: /./ });
  s.polls.get('ca');
  await settle();
  assert.equal(s.status.at(-1).state, 'error');
  assert.equal(s.data.length, 0);
  s.done();
});
