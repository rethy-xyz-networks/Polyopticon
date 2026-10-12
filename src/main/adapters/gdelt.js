'use strict';

// GDELT 2.0 Global Knowledge Graph. Every 15 minutes GDELT publishes a zipped
// file of all English-language news it saw worldwide (~500–700 articles) with
// headline, themes, locations and tone. One shared download serves every
// GDELT source; each source filters it locally. No key, no rate limit.

const zlib = require('zlib');
const { Adapter } = require('./base');
const { SourceError, request, decodeEntities, parseDate, sanePublished, trunc } = require('./util');

const LAST_UPDATE = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';

// GKG 2.1 column indexes
const C = { date: 1, source: 3, url: 4, themesV1: 7, themes: 8, locsV1: 9, locs: 10, tone: 15, extras: 26 };

/** Extracts the single entry from a one-file zip archive. */
function unzipSingle(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new SourceError('PARSE', 'GDELT file is not a zip');
  const method = buf.readUInt16LE(8);
  const start  = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const data   = buf.subarray(start);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

const tag = (extras, name) => {
  const m = extras.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : null;
};

function parseGkg(csv) {
  const rows = [];
  for (const line of csv.split('\n')) {
    if (!line) continue;
    const r = line.split('\t');
    const url = r[C.url];
    if (!url || !/^https?:/.test(url)) continue;
    const extras = r[C.extras] || '';
    const title = tag(extras, 'PAGE_TITLE');
    if (!title) continue;
    // V2 locations end with their offset in the article: earliest mentioned first (V1 has no offsets).
    const locs = (r[C.locs] || r[C.locsV1] || '').split(';').map(l => l.split('#'));
    if (r[C.locs]) locs.sort((a, b) => (+a[a.length - 1] || 0) - (+b[b.length - 1] || 0));
    const locNames = [...new Set(locs.map(l => l[1]).filter(Boolean))];
    rows.push({
      url, title,
      titleLower: title.toLowerCase(),
      // Path only — keywords shouldn't match the site's domain (e.g. 'israel' in israelnationalnews.com).
      pathLower: (() => { try { return decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return ''; } })(),
      source: r[C.source],
      authors: tag(extras, 'PAGE_AUTHORS'),
      published: parseDate(tag(extras, 'PAGE_PRECISEPUBTIMESTAMP') || r[C.date]),
      themes: (r[C.themes] || r[C.themesV1] || '').toUpperCase(),
      locations: locNames,
      locLower: locNames.join(' | ').toLowerCase(),
      tone: Number((r[C.tone] || '').split(',')[0]) || 0,
    });
  }
  return rows;
}

// Shared download (one per worker)

const shared = { url: null, rows: [], pending: null };

async function latestBatch(signal, log) {
  if (shared.pending) return shared.pending;
  shared.pending = (async () => {
    const resp = await request(LAST_UPDATE, { signal });
    if (!resp.ok) throw new SourceError(`HTTP ${resp.status}`, `GDELT lastupdate: HTTP ${resp.status}`);
    const line = (await resp.text()).split('\n').find(l => l.includes('.gkg.csv.zip'));
    const url = line?.trim().split(/\s+/)[2];
    if (!url) throw new SourceError('PARSE', 'GDELT lastupdate.txt had no GKG entry');
    if (url !== shared.url) {
      const zip = await request(url, { signal, timeout: 60000 });
      if (!zip.ok) throw new SourceError(`HTTP ${zip.status}`, `GDELT GKG download: HTTP ${zip.status}`);
      const csv = unzipSingle(Buffer.from(await zip.arrayBuffer())).toString('utf8');
      shared.rows = parseGkg(csv);
      shared.url = url;
      log.info(`[GDELT] New batch ${url.match(/\d{14}/)?.[0]} — ${shared.rows.length} articles`);
    }
    return { url: shared.url, rows: shared.rows };
  })().finally(() => { shared.pending = null; });
  return shared.pending;
}

const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);

class GdeltAdapter extends Adapter {
  constructor(source, ctx) {
    super(source, ctx);
    this.lastBatch = null;
    this.keywords  = list(this.config.keywords).map(k => k.toLowerCase());
    this.themes    = list(this.config.themes).map(t => t.toUpperCase());
    this.location  = (this.config.location || '').trim().toLowerCase();
  }

  matches(r) {
    if (this.keywords.length && !this.keywords.some(k => r.titleLower.includes(k) || r.pathLower.includes(k.replace(/\s+/g, '-')))) return false;
    if (this.themes.length && !this.themes.some(t => r.themes.includes(t))) return false;
    if (this.location && !r.locLower.includes(this.location)) return false;
    return true;
  }

  async fetchItems(signal) {
    const { url, rows } = await latestBatch(signal, this.log);
    if (url === this.lastBatch) return null;
    this.lastBatch = url;
    return rows.filter(r => this.matches(r)).map(r => ({
      extId: r.url,
      title: trunc(r.title, 300),
      url: r.url,
      author: r.authors ? `${r.source} · ${trunc(r.authors, 60)}` : r.source,
      summary: [r.locations.length ? `Locations: ${r.locations.slice(0, 6).join('; ')}` : null,
                `Tone ${r.tone.toFixed(1)}`].filter(Boolean).join(' · '),
      publishedAt: sanePublished(r.published ?? Date.now()),
      extra: { tone: r.tone, domain: r.source },
    }));
  }
}

module.exports = { GdeltAdapter, parseGkg, unzipSingle };
