'use strict';

// Political-lean ratings for news sources, from the MediaBias News API (mediabias.news), which
// republishes the verdicts of AllSides, Ad Fontes Media and Media Bias/Fact Check.
//
// Each RSS source is looked up once and the answer (or "no match") is kept in the database; a row
// there means "checked", so nothing is asked again unless the user forces a recheck (Settings).
//
// Which fields we use, from comparing the API's answers for every default feed:
//   bias.reviews[]      each rater's verdict (left … right). Their mean places an outlet more finely
//                       than `bias.rating` (5 steps) or `bias.side` (3 steps), and keeps raters that
//                       disagree visible instead of rounding them away.
//   factuality.reviews  the same for reliability: the chart's second axis.
//   domains[]           how a search hit is confirmed as the outlet behind a feed. The search is fuzzy
//                       ("pbs.org" also returns cascadepbsorg), so a hit counts only if one of its
//                       domains is the feed's.
// Entries with no reviews (the "-affiliated" records for RT, TASS …) carry a rating no rater gave;
// they are matched, but not plotted.

const API = 'https://mediabias.news/api/v1';

const SIDE = { left: -2, leanLeft: -1, center: 0, centre: 0, leanRight: 1, right: 2 };
const FACT = { veryLow: 0, low: 1, mixed: 2, mostlyFactual: 3, high: 3, veryHigh: 4 };

const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);

/** Hostname without a leading www. */
const bare = host => String(host || '').toLowerCase().replace(/^www\./, '');

function hostOf(url) {
  try { return bare(new URL(url).hostname); } catch { return ''; }
}

// The labels that sit under a country code as a public suffix (co.uk, com.au, or.jp …), not a name of their own.
const SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/** `a.b.example.com` -> [a.b.example.com, b.example.com, example.com], never down to a bare `co.uk`. */
function hostVariants(host) {
  const parts = host.split('.');
  const out = [];
  for (let i = 0; parts.length - i >= 2; i++) {
    const rest = parts.slice(i);
    if (rest.length === 2 && rest[1].length === 2 && SUFFIX_LABELS.has(rest[0])) break;     // co.uk, com.au …
    out.push(rest.join('.'));
  }
  return out;
}

/** The hosts that identify a source: its feed's, then the most common ones among its story links. */
function sourceHosts(feedUrl, storyUrls = []) {
  const counts = new Map();
  for (const u of storyUrls) { const h = hostOf(u); if (h) counts.set(h, (counts.get(h) || 0) + 1); }
  const linked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => h);
  return [...new Set([hostOf(feedUrl), ...linked].filter(Boolean))];
}

/** Does any of the outlet's domains equal one of the hosts, or contain it as a parent domain? */
function domainsMatch(domains, hosts) {
  return (domains || []).some(d => {
    d = bare(d);
    return hosts.some(h => h === d || h.endsWith(`.${d}`));
  });
}

const verdicts = (block, scale) =>
  (block?.reviews || []).filter(r => r.verdict in scale).map(r => ({ reviewer: r.reviewer, verdict: r.verdict, value: scale[r.verdict] }));

/** The API's outlet record -> what we keep: a position on the chart plus the evidence for it. */
function summarise(o) {
  const bias = verdicts(o.bias, SIDE), fact = verdicts(o.factuality, FACT);
  return {
    slug: o.slug,
    name: o.name,
    url: o.links?.canonical || `https://mediabias.news/sources/${o.slug}`,
    x: round2(mean(bias.map(r => r.value))),                  // -2 (left) … 2 (right); null = no rater has rated it
    y: round2(mean(fact.map(r => r.value))),                  // 0 (low) … 4 (very high); null = no factuality rating
    rating: o.bias?.rating ?? null,
    factuality: o.factuality?.rating ?? null,
    bias: bias.map(r => [r.reviewer, r.verdict]),
    fact: fact.map(r => [r.reviewer, r.verdict]),
    stories: o.observed?.storyCount ?? 0,
    satire: !!o.satire,
    assessedAt: o.assessedAt ?? null,
  };
}

/**
 * The outlet behind a source, or null when the database has none. `getJson(url)` returns the parsed
 * answer (null for a 404) and throws when the service can't be reached, which is not "no match".
 */
async function findOutlet(hosts, getJson) {
  if (!hosts.length) return null;
  const details = new Map();
  const detail = async slug => {
    if (!details.has(slug)) details.set(slug, (await getJson(`${API}/outlets/${encodeURIComponent(slug)}`))?.outlet ?? null);
    return details.get(slug);
  };
  const queries = [...new Set(hosts.flatMap(hostVariants))];
  for (const q of queries) {
    const found = await getJson(`${API}/outlets?q=${encodeURIComponent(q)}&limit=10`);
    const matches = [];
    for (const hit of (found?.outlets || []).slice(0, 6)) {
      const o = await detail(hit.slug);
      if (o && domainsMatch(o.domains, hosts)) matches.push(o);
    }
    if (matches.length) {
      const rated = o => (o.bias?.reviews?.length ? 1 : 0);
      matches.sort((a, b) => rated(b) - rated(a) || (b.observed?.storyCount ?? 0) - (a.observed?.storyCount ?? 0));
      return summarise(matches[0]);
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * getJson for findOutlet over a fetch function. The API answers 429 with Retry-After when asked too
 * much, so that is waited out (a few times) rather than treated as an answer; a 404 is null; a service
 * that can't be reached, or keeps refusing, throws an error flagged `offline` (the lookup stops and
 * tries again another time).
 */
function httpJson(fetchFn, { wait = sleep, log = { info() {} }, retries = 3 } = {}) {
  const get = async (url, attempt = 0) => {
    let res;
    try { res = await fetchFn(url); }
    catch (e) { throw Object.assign(new Error(`unreachable: ${e.message}`), { offline: true }); }
    if (res.status === 404) return null;
    if (res.status === 429) {
      if (attempt >= retries) throw Object.assign(new Error('rate limited'), { offline: true });
      const secs = Math.min(Math.max(Number(res.headers.get('retry-after')) || 60, 1), 120);
      log.info(`Bias: rate limited, waiting ${secs}s`);
      await wait(secs * 1000 + 500);
      return get(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  return get;
}

/**
 * Looks sources up in the background, one request at a time (gapMs apart), and records each answer.
 *   db       the database (listSources, listBias, setBias, clearBias, recentUrls)
 *   getJson  see findOutlet
 *   onChange called after answers are stored (the chart and Settings redraw)
 *   onProgress({ done, total } | null)
 */
function createChecker({ db, getJson: rawGetJson, onChange = () => {}, onProgress = () => {}, log = { info() {}, warn() {} }, gapMs = 550 }) {
  let running = null;
  let again = false;
  // Answers are reused within a run: sources of one outlet (five SCMP feeds) share every request.
  const cache = new Map();
  // The API allows about 120 requests a minute (then 429, Retry-After: 60): stay under it.
  let lastAt = 0;
  const getJson = async url => {
    if (!cache.has(url)) {
      const wait = lastAt + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      cache.set(url, await rawGetJson(url));
    }
    return cache.get(url);
  };

  const feedUrl = s => (s.type === 'rss' ? s.config?.url : null);

  async function run() {
    cache.clear();
    const done = new Set(db.listBias().map(r => r.sourceId));
    const todo = db.listSources().filter(s => feedUrl(s) && !done.has(s.id));
    if (!todo.length) return;
    log.info(`Bias: looking up ${todo.length} source(s)`);
    let n = 0, rated = 0;
    for (const s of todo) {
      onProgress({ done: n++, total: todo.length });
      try {
        const urls = db.recentUrls(s.id, 40);
        const outlet = await findOutlet(sourceHosts(feedUrl(s), urls), getJson);
        // A source that has published nothing yet can't be told apart from an unknown one by its
        // links (a feed on bbci.co.uk, a site on bbc.co.uk); ask again later rather than settle on "no match".
        if (outlet || urls.length) db.setBias(s.id, outlet);
        if (outlet?.x != null) rated++;
      } catch (e) {
        log.warn(`Bias: lookup of "${s.name}" failed (${e.message}); will retry later`);
        if (e.offline) break;                                    // offline or limited: don't go on asking for every source
      }
      onChange();
    }
    onProgress(null);
    log.info(`Bias: done, ${rated} of ${todo.length} rated`);
  }

  /** Looks up every source that hasn't been checked yet. */
  function checkPending() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await run(); } while (again); }
      catch (e) { log.warn(`Bias: ${e.message}`); }
      finally { running = null; onProgress(null); onChange(); }
    })();
    return running;
  }

  /** Forget every answer and look everything up again. */
  async function recheckAll() {
    db.clearBias();
    onChange();
    return checkPending();
  }

  return { checkPending, recheckAll, isRunning: () => !!running };
}

module.exports = { API, httpJson, SIDE, FACT, hostOf, hostVariants, sourceHosts, domainsMatch, summarise, findOutlet, createChecker };
