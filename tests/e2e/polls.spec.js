'use strict';

// Opinion polls: an app tab like the map and Global Markets. Tests never go online, so the view first says it's
// fetching, and then gets made-up polls the way main would send them (polls:data).

const { test, expect } = require('./fixtures');

const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * A made-up copy as main sends it: voting intention (three firms, every few days for `days`, ending on `end`,
 * plus the election and an event), a question about leaders polled once a month, and one with a variant per
 * province.
 */
function sample(end = Date.UTC(2026, 10, 7), days = 400) {
  const polls = [];
  const firms = [['Firm A', 3, 'IVR'], ['Firm B', 7, 'Telephone'], ['Firm C', 11, 'Online']];
  for (const [firm, every, method] of firms) {
    for (let t = end; t > end - days * DAY; t -= every * DAY) {
      const k = (end - t) / DAY / days;                     // 0 now … 1 at the start
      polls.push({
        firm, date: iso(t), method, sample: 1000, moe: 3.1, url: `https://example.org/${firm.replace(' ', '')}/${iso(t)}`,
        values: { LPC: +(44 - 4 * k).toFixed(1), CPC: +(31 + 8 * k).toFixed(1), BQ: 6, NDP: +(12 - 3 * k).toFixed(1), GPC: 3, PPC: 2 },
        lead: null,
      });
    }
  }
  polls.push({ firm: '2025 election', date: '2025-04-28', election: true, values: { LPC: 43.8, CPC: 41.3, BQ: 6.3, NDP: 6.3, GPC: 1.2, PPC: 0.7 }, url: null });
  const page = { title: 'Opinion polling for the 46th Canadian federal election', url: 'https://en.wikipedia.org/wiki/Example', revid: 1, edited: end, events: [] };
  const monthly = (values, extra = {}) => Array.from({ length: 6 }, (_, i) => (
    { firm: 'Firm A', date: iso(end - i * 30 * DAY), values: values(i), moe: 3.1, sample: 1000, method: 'IVR', lead: null, url: null, ...extra }));
  return {
    country: 'ca', name: 'Canada', fetchedAt: Date.now(),
    sets: [
      { ...page, id: 'vote', group: 'Federal', label: 'Voting intention', kind: 'parties',
        options: ['LPC', 'CPC', 'BQ', 'NDP', 'GPC', 'PPC'],
        names: { LPC: 'Liberal', CPC: 'Conservative', BQ: 'Bloc Québécois', NDP: 'New Democratic', GPC: 'Green', PPC: "People's Party" },
        partyOf: { LPC: 'Liberal', CPC: 'Conservative', BQ: 'BQ', NDP: 'NDP', GPC: 'Green', PPC: 'PPC' },
        pages: { LPC: 'Liberal Party of Canada', CPC: 'Conservative Party of Canada' },
        variantLabel: null, variants: [],
        polls: polls.sort((a, b) => b.date.localeCompare(a.date)),
        events: [{ date: iso(end - 60 * DAY), text: 'A by-election in Test Riding.' }] },
      { ...page, id: 'pm', group: 'Federal', label: 'Preferred prime minister', kind: 'question', url: 'https://en.wikipedia.org/wiki/Example#Leadership_polls',
        options: ['Ann Alpha', 'Bo Beta', 'Unsure/none', 'Cy Beta'], names: {},
        partyOf: { 'Ann Alpha': 'Liberal', 'Bo Beta': 'NDP', 'Cy Beta': 'NDP' },
        variantLabel: null, variants: [],
        // Cy Beta led the party until three months ago, Bo Beta since
        polls: monthly(i => ({ 'Ann Alpha': 50 - i, [i < 3 ? 'Bo Beta' : 'Cy Beta']: 20 + i, 'Unsure/none': 55 })) },
      { ...page, id: 'regional', group: 'Elsewhere', label: 'Voting intention by province', kind: 'parties',
        options: ['LPC', 'CPC', 'BQ'], names: {}, partyOf: { LPC: 'Liberal', CPC: 'Conservative', BQ: 'BQ' },
        variantLabel: 'Province', variants: ['Quebec', 'Ontario'],
        polls: [...monthly(() => ({ LPC: 40, CPC: 20, BQ: 30 }), { variant: 'Quebec' }), ...monthly(() => ({ LPC: 45, CPC: 42 }), { variant: 'Ontario' }).slice(0, 2)] },
    ],
  };
}

const feed = (window, data) => window.evaluate(async d => (await import('./polls.js')).applyPolls(d), data);

test('the polls button opens its view as a tab, once, and Ctrl+O selects it', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  await expect(window.locator('#polls-view')).toBeVisible();
  await expect(window.locator('#btn-polls')).toHaveClass(/\bon\b/);
  await expect(window.locator('#polls-empty')).toHaveText(/Fetching the polls from Wikipedia/);
  await expect(window.locator('#polls-country')).toHaveValue('ca');
  await expect(window.locator('#polls-set')).toBeHidden();              // nothing to choose from yet

  await window.locator('#btn-markets').click();
  await expect(window.locator('#polls-view')).toBeHidden();
  await window.keyboard.press('Control+o');
  await expect(window.locator('#polls-view')).toBeVisible();
  await expect(window.locator('#tabs .tab .label')).toHaveText(['Map', 'Opinion polls', 'Global Markets']);
  await window.keyboard.press('Control+w');
  await expect(window.locator('#polls-view')).toBeHidden();
  await expect(window.locator('#btn-polls')).not.toHaveClass(/\bon\b/);
  expect(window.pageErrors).toEqual([]);
});

test('polls show as an average per party, a chart with labelled lines and a table with sources', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  await feed(window, sample());

  await expect(window.locator('#polls-empty')).toBeHidden();
  await expect(window.locator('#polls-set')).toHaveValue('vote');
  await expect(window.locator('#polls-variant')).toBeHidden();
  // Tiles, highest first
  await expect(window.locator('.pl-tile .pl-abbr')).toHaveText(['LPC', 'CPC', 'NDP', 'BQ', 'GPC', 'PPC']);
  await expect(window.locator('.pl-tile[data-party="LPC"] .pl-value')).toHaveText(/^4[34]\.\d%$/);
  await expect(window.locator('.pl-tile[data-party="LPC"] .pl-delta')).toHaveAttribute('data-dir', 'up');
  await expect(window.locator('.pl-tile[data-party="CPC"] .pl-delta')).toHaveAttribute('data-dir', 'down');
  await expect(window.locator('.pl-lead')).toHaveText(/^Liberal lead by \d+\.\d points over Conservative$/);

  // The chart: a line and an end label per party, the event as a marker
  await expect(window.locator('#polls-chart .pl-line')).toHaveCount(6);
  await expect(window.locator('#polls-chart .pl-end text')).toHaveCount(6);
  await expect(window.locator('#polls-chart .pl-event-mark')).toHaveCount(1);
  const labels = await window.locator('#polls-chart .pl-end text').evaluateAll(els => els.map(e => e.getBBox()).map(b => [b.y, b.y + b.height]));
  labels.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < labels.length; i++) expect(labels[i][0]).toBeGreaterThanOrEqual(labels[i - 1][1] - 1);   // none overlap

  // Hovering shows each party's average on that day
  const box = await window.locator('#polls-chart').boundingBox();
  await window.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(window.locator('#polls-tip')).toBeVisible();
  await expect(window.locator('#polls-tip .pl-tip-row')).toHaveCount(6);
  await window.mouse.move(box.x + 2, box.y + box.height + 40);
  await expect(window.locator('#polls-tip')).toBeHidden();

  // The table: newest first, the event between the polls, a source link per poll; 1Y leaves out the election
  const rows = window.locator('#polls-table tbody tr');
  await expect(rows.first().locator('td').first()).toHaveText('Firm A');
  await expect(window.locator('#polls-table .pl-event')).toHaveText(/A by-election in Test Riding/);
  await expect(rows.first().locator('a')).toHaveAttribute('href', /^https:\/\/example\.org\/FirmA\//);
  await expect(window.locator('#polls-table .pl-election')).toHaveCount(0);
  await expect(window.locator('#polls-foot')).toContainText('CC BY-SA 4.0');
  await expect(window.locator('#polls-foot a')).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Example');

  // The range: 3M has fewer rows; All reaches back to the election
  const all1y = await rows.count();
  await window.locator('#polls-range button[data-r="3m"]').click();
  await expect(window.locator('#polls-range button[data-r="3m"]')).toHaveClass(/\bon\b/);
  expect(await rows.count()).toBeLessThan(all1y);
  await window.locator('#polls-range button[data-r="all"]').click();
  await expect(window.locator('#polls-table .pl-election')).toHaveCount(1);
  await expect(window.locator('#polls-chart .pl-elect')).toHaveCount(6);
  expect(window.pageErrors).toEqual([]);
});

test('the chosen range is remembered', async ({ window, dataDir }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  await feed(window, sample());
  await window.locator('#polls-range button[data-r="6m"]').click();
  await expect.poll(() => {
    try { return JSON.parse(require('fs').readFileSync(require('path').join(dataDir, 'ui.json'), 'utf8')).pollsRange; } catch { return null; }
  }).toBe('6m');
});

test('another question is chosen from the list: its own answers, colours by party, and it is remembered', async ({ window, dataDir }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  await feed(window, sample());
  await expect(window.locator('#polls-set optgroup')).toHaveCount(2);
  await expect(window.locator('#polls-set optgroup').first()).toHaveAttribute('label', 'Federal');
  await expect(window.locator('#polls-set option')).toHaveText(['Voting intention', 'Preferred prime minister', 'Voting intention by province']);

  await window.locator('#polls-set').selectOption('pm');
  // The former leader has no tile and no label at the chart's edge, but keeps a line, in his party's colour
  await expect(window.locator('.pl-tile .pl-abbr')).toHaveText(['Unsure/none', 'Ann Alpha', 'Bo Beta']);
  await expect(window.locator('.pl-tile[data-party="Ann Alpha"] .pl-full')).toHaveText('Liberal');
  await expect(window.locator('.pl-lead')).toHaveText(/^Ann Alpha leads Bo Beta by \d+\.\d points$/);   // not the undecided
  await expect(window.locator('#polls-chart .pl-line')).toHaveCount(4);
  await expect(window.locator('#polls-chart .pl-end text')).toHaveCount(3);
  const stroke = name => window.locator('#polls-table th', { hasText: name }).locator('.pl-key').evaluate(e => getComputedStyle(e).backgroundColor);
  expect(await stroke('Bo Beta')).toBe(await stroke('Cy Beta'));
  expect(await stroke('Bo Beta')).not.toBe(await stroke('Ann Alpha'));
  await expect(window.locator('#polls-table tbody tr')).toHaveCount(6);
  await expect(window.locator('#polls-status')).toHaveText(/^6 polls · /);
  await expect(window.locator('#polls-foot')).toContainText('previous 90 days');               // monthly polls: a longer window
  await expect(window.locator('#polls-foot a')).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Example#Leadership_polls');
  await expect.poll(() => {
    try { return JSON.parse(require('fs').readFileSync(require('path').join(dataDir, 'ui.json'), 'utf8')).pollsSet; } catch { return null; }
  }).toBe('pm');
  expect(window.pageErrors).toEqual([]);
});

test('a question with variants shows one at a time, with only the answers it has', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  await feed(window, sample());
  await window.locator('#polls-set').selectOption('regional');
  await expect(window.locator('#polls-variant')).toBeVisible();
  await expect(window.locator('#polls-variant')).toHaveAttribute('aria-label', 'Province');
  await expect(window.locator('#polls-variant option')).toHaveText(['Quebec', 'Ontario']);
  await expect(window.locator('.pl-tile .pl-abbr')).toHaveText(['LPC', 'BQ', 'CPC']);
  await expect(window.locator('#polls-table tbody tr')).toHaveCount(6);

  await window.locator('#polls-variant').selectOption('Ontario');
  await expect(window.locator('.pl-tile .pl-abbr')).toHaveText(['LPC', 'CPC']);
  await expect(window.locator('#polls-table tbody tr')).toHaveCount(2);
  await expect(window.locator('#polls-status')).toHaveText(/^2 polls · /);
  // Back on a question without variants, their picker goes
  await window.locator('#polls-set').selectOption('vote');
  await expect(window.locator('#polls-variant')).toBeHidden();
  await window.locator('#polls-set').selectOption('regional');
  await expect(window.locator('#polls-variant')).toHaveValue('Ontario');
  expect(window.pageErrors).toEqual([]);
});

test('a poll long after the one before it still shows its average, and a gap says it has no polls', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  const d = sample();
  const end = Date.UTC(2026, 8, 5);
  d.sets = [{ ...d.sets[1], id: 'gap', label: 'Gap', options: ['Yes', 'No'], partyOf: {}, events: [],
    polls: [[end, 9, 85], [end - 580 * DAY, 15, 77], [end - 594 * DAY, 22, 71], [end - 600 * DAY, 10, 90]]
      .map(([t, yes, no]) => ({ firm: 'Firm A', date: iso(t), values: { Yes: yes, No: no }, moe: null, sample: null, method: null, lead: null, url: null })) }];
  await feed(window, d);
  await window.locator('#polls-range button[data-r="all"]').click();
  // Each line: its run over the early polls, then the last poll on its own, drawn as a dash 8 px wide
  const paths = await window.locator('#polls-chart .pl-line').evaluateAll(els => els.map(e => e.getAttribute('d')));
  expect(paths).toHaveLength(2);
  for (const d of paths) expect(d).toMatch(/L[\d.]+,[\d.]+M[\d.]+,[\d.]+M[\d.]+,[\d.]+h8$/);
  await expect(window.locator('.pl-tile[data-party="No"] .pl-value')).toHaveText('85.0%');
  const box = await window.locator('#polls-chart').boundingBox();
  await window.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await expect(window.locator('#polls-tip .pl-tip-n')).toHaveText(/^No polls in the \d+ days up to this day$/);
  await expect(window.locator('#polls-tip .pl-tip-row')).toHaveCount(0);
  expect(window.pageErrors).toEqual([]);
});

test('seat projections count seats, and approval leads with the net', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  const d = sample();
  const end = Date.UTC(2026, 10, 7);
  const poll = (i, values) => ({ firm: 'Firm A', date: iso(end - i * 30 * DAY), values, moe: null, sample: null, method: null, lead: null, url: null });
  d.sets = [
    { ...d.sets[1], id: 'seats', label: 'Seats', kind: 'parties', unit: 'seats', options: ['EPP', 'S&D', 'Others'], partyOf: {}, events: [],
      polls: [0, 1, 2].map(i => poll(i, { EPP: 173, 'S&D': 120, Others: 8 })) },
    { ...d.sets[1], id: 'approval', label: 'Approval', kind: 'approval', options: ['Approve', 'Disapprove', 'Unsure'], partyOf: {}, events: [],
      polls: [0, 1, 2].map(i => poll(i, { Approve: 38, Disapprove: 59, Unsure: 3 })) },
  ];
  await feed(window, d);
  await expect(window.locator('.pl-tile[data-party="EPP"] .pl-value')).toHaveText('173.0');
  await expect(window.locator('.pl-lead')).toHaveText(/lead by 53\.0 seats over/);
  await expect(window.locator('#polls-chart')).toContainText('150');
  await expect(window.locator('#polls-chart')).not.toContainText('%');

  await window.locator('#polls-set').selectOption('approval');
  await expect(window.locator('.pl-lead')).toHaveText('Net approval −21.0');
  await expect(window.locator('.pl-tile[data-party="Disapprove"] .pl-value')).toHaveText('59.0%');
  // Approve wears green and Disapprove red, whatever order the table gives them
  const fill = p => window.locator(`.pl-tile[data-party="${p}"] .pl-swatch`).getAttribute('style');
  expect(await fill('Approve')).toContain('green');
  expect(await fill('Disapprove')).toContain('red');
  expect(window.pageErrors).toEqual([]);
});

test("a party's tile, table heading or line label opens its Wikipedia article as a tab, as the map's places do", async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-polls').click();
  await feed(window, sample());
  const active = () => window.evaluate(async () => {
    const { state } = await import('./state.js'), t = state.tabs.find(x => x.id === state.activeTabId);
    return { kind: t.kind, site: t.site, url: t.item.url };
  });
  // Only an answer whose heading links an article opens one
  await expect(window.locator('.pl-tile[data-article]')).toHaveCount(2);
  await expect(window.locator('.pl-tile[data-party="BQ"]')).not.toHaveAttribute('data-article');
  await window.locator('.pl-tile[data-party="CPC"]').click();
  await expect(window.locator('#polls-view')).toBeHidden();
  expect(await active()).toEqual({ kind: 'chan', site: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Conservative_Party_of_Canada' });

  await window.locator('#btn-polls').click();
  await expect(window.locator('#polls-view')).toBeVisible();
  await window.locator('#polls-table th[data-article="Liberal Party of Canada"]').click();
  expect(await active()).toEqual({ kind: 'chan', site: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Liberal_Party_of_Canada' });

  await window.locator('#btn-polls').click();
  await window.locator('.pl-end[data-article="Conservative Party of Canada"] text').click();
  expect(await active()).toEqual({ kind: 'chan', site: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Conservative_Party_of_Canada' });
  // The same article again is the tab already open, not a second one
  const wiki = await window.evaluate(async () => (await import('./state.js')).state.tabs.filter(t => t.site === 'wikipedia').length);
  expect(wiki).toBe(2);
  expect(window.pageErrors).toEqual([]);
});
