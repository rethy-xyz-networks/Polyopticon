'use strict';

// Opinion polls: an app tab like the map and Global Markets. Tests never go online, so the view first says it's
// fetching, and then gets made-up polls the way main would send them (polls:data).

const { test, expect } = require('./fixtures');

const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

/** Made-up polls: three firms, every few days for `days`, ending on `end`, plus the election and an event. */
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
  return {
    country: 'ca', name: 'Canada', title: 'Opinion polling for the 46th Canadian federal election', url: 'https://en.wikipedia.org/wiki/Example',
    revid: 1, edited: end, fetchedAt: Date.now(),
    parties: ['LPC', 'CPC', 'BQ', 'NDP', 'GPC', 'PPC'],
    partyNames: { LPC: 'Liberal', CPC: 'Conservative', BQ: 'Bloc Québécois', NDP: 'New Democratic', GPC: 'Green', PPC: "People's Party" },
    polls: polls.sort((a, b) => b.date.localeCompare(a.date)),
    events: [{ date: iso(end - 60 * DAY), text: 'A by-election in Test Riding.' }],
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
