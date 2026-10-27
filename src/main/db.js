'use strict';

// SQLite store (built-in node:sqlite). Opened by both the main process (history,
// snapshots, source management) and the feed worker (item ingestion). WAL mode
// lets the two connections read and write concurrently.

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

// Each entry upgrades the database by one version (index 0 -> version 2, …).
const MIGRATIONS = [
  // v2: story grouping, places, translation
  `ALTER TABLE items ADD COLUMN cluster_id   INTEGER;
   ALTER TABLE items ADD COLUMN places       TEXT;     -- JSON [[placeId, name, lat, lon], …]
   ALTER TABLE items ADD COLUMN lang         TEXT;     -- detected language (ISO 639-1)
   ALTER TABLE items ADD COLUMN orig_title   TEXT;     -- set when title/summary were translated
   ALTER TABLE items ADD COLUMN orig_summary TEXT;
   CREATE INDEX IF NOT EXISTS items_cluster ON items(cluster_id);
   ALTER TABLE snapshots ADD COLUMN lang            TEXT;
   ALTER TABLE snapshots ADD COLUMN translated_text TEXT;`,
  // v3: how the text was extracted, and whether the site only served part of the article
  `ALTER TABLE snapshots ADD COLUMN method  TEXT;
   ALTER TABLE snapshots ADD COLUMN partial INTEGER NOT NULL DEFAULT 0;`,
  // v4: country groups instead of regions (only sources still in the old seeded groups),
  //     and a key/value table for one-off bookkeeping such as the seed revision.
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
   UPDATE sources SET category = 'US' WHERE name IN ('NBC World', 'Al-Monitor') AND grp IN ('International', 'Middle East');
   UPDATE sources SET category = 'UK' WHERE name = 'Middle East Eye' AND grp = 'Middle East';
   UPDATE sources SET grp = CASE category
       WHEN 'US' THEN 'USA'      WHEN 'CA' THEN 'Canada'  WHEN 'UK' THEN 'UK'
       WHEN 'FR' THEN 'France'   WHEN 'DE' THEN 'Germany' WHEN 'IL' THEN 'Israel'
       WHEN 'QA' THEN 'Qatar'    WHEN 'PK' THEN 'Pakistan' ELSE grp END
     WHERE grp IN ('Americas', 'Middle East', 'International');`,
  // v5: each source's newest items, for the live list's per-source minimum (recentItems)
  `CREATE INDEX IF NOT EXISTS items_source_published ON items(source_id, published_at DESC);`,
  // v6: political-lean lookup per source (bias.js). A row means the source was checked; outlet is NULL when nothing matched.
  `CREATE TABLE IF NOT EXISTS source_bias (
     source_id  INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
     checked_at INTEGER NOT NULL,
     outlet     TEXT
   );`,
  // v7: foreign-language items still waiting for a translation (untranslated()). Only those rows are in the index,
  //     so finding them no longer reads every recent item. The query must repeat these conditions to use it.
  `CREATE INDEX IF NOT EXISTS items_untranslated ON items(published_at)
     WHERE lang IS NOT NULL AND lang != 'en' AND orig_title IS NULL;`,
  // v8: headline translation was removed, so nothing reads the v7 index any more.
  `DROP INDEX IF EXISTS items_untranslated;`,
  // v9–v11: a topic web was tried and removed. Its two tables were created at v9 and v10 on databases that ran it;
  // the version numbers stay taken, and v11 drops the tables wherever they are.
  `DROP TABLE IF EXISTS item_vectors;`,
  `DROP TABLE IF EXISTS topic_images;`,
  `DROP TABLE IF EXISTS item_vectors; DROP TABLE IF EXISTS topic_images;`,
];
const SCHEMA_VERSION = 1 + MIGRATIONS.length;

function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version || 1;
  while (v < SCHEMA_VERSION) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v - 1]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration to v${v + 1} failed: ${e.message}`);
    }
    v++;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL,
  name       TEXT    NOT NULL UNIQUE,
  grp        TEXT    NOT NULL DEFAULT 'Other',
  category   TEXT,
  color      TEXT,
  config     TEXT    NOT NULL DEFAULT '{}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ext_id       TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'article',
  title        TEXT    NOT NULL,
  summary      TEXT,
  url          TEXT,
  author       TEXT,
  published_at INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL,
  extra        TEXT,
  UNIQUE (source_id, ext_id)
);
CREATE INDEX IF NOT EXISTS items_published ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS items_url       ON items(url);

CREATE TABLE IF NOT EXISTS opens (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  via       TEXT    NOT NULL DEFAULT 'tab'
);
CREATE INDEX IF NOT EXISTS opens_item ON opens(item_id);
CREATE INDEX IF NOT EXISTS opens_time ON opens(opened_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  item_id      INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  captured_at  INTEGER NOT NULL,
  final_url    TEXT,
  mhtml_path   TEXT,
  mhtml_bytes  INTEGER,
  title        TEXT,
  byline       TEXT,
  site_name    TEXT,
  excerpt      TEXT,
  content_html TEXT,
  text         TEXT,
  word_count   INTEGER
);

-- Full-text index; rowid = items.id. 'article' is filled in when a snapshot is saved.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, summary, article, tokenize = 'unicode61 remove_diacritics 2');
`;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // cache_size: the default 2 MB is smaller than the recent part of the table, so reading it in published order
  // (every startup, every history page) re-read the same pages from disk over and over: 3.5x faster with 64 MB.
  // Pages are only taken as they are used.
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
           PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;`);
  db.exec(SCHEMA);
  migrate(db);
  return wrap(db);
}

const parseSource = r => r && ({ ...r, enabled: !!r.enabled, config: JSON.parse(r.config || '{}') });

// The source's name is a subquery, not a JOIN: node:sqlite reads a joined row ~4x slower (getItem: ~50 µs
// joined, ~6 µs this way). Items can't outlive their source (ON DELETE CASCADE), so both give the same rows.
const ITEM_COLS = `i.id, i.source_id AS sourceId, (SELECT name FROM sources WHERE id = i.source_id) AS sourceName, i.kind, i.title, i.summary, i.url,
                   i.author, i.published_at AS publishedAt, i.cluster_id AS clusterId, i.places, i.lang,
                   i.orig_title AS origTitle, json_extract(i.extra, '$.site') AS site`;

/** Row -> renderer item (places JSON parsed). Set in place: copying a row (null prototype) costs more than reading it. */
const itemRow = r => { if (r) r.places = r.places ? JSON.parse(r.places) : []; return r; };

/** FTS5 query from free text: every word must match (prefix match on the last). */
function ftsQuery(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

function wrap(db) {
  // Preparing a statement costs more than running it (a lookup by id takes ~100 µs prepared each time, ~5 µs
  // reused), so statements are kept by their SQL text. Queries built from user input (history with source
  // chips) are prepared fresh instead of filling the cache.
  const prepared = new Map();
  const q = sql => {
    let st = prepared.get(sql);
    if (!st) prepared.set(sql, st = db.prepare(sql));
    return st;
  };

  const stmts = {
    insertItem: q(`INSERT OR IGNORE INTO items (source_id, ext_id, kind, title, summary, url, author, published_at, seen_at, extra)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFts:  q(`INSERT INTO items_fts (rowid, title, summary, article) VALUES (?, ?, ?, '')`),
  };

  const api = {
    raw: db,
    close: () => db.close(),

    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    // Sources
    listSources: () => q(`SELECT * FROM sources ORDER BY sort, id`).all().map(parseSource),
    getSource:   id => parseSource(q(`SELECT * FROM sources WHERE id = ?`).get(id)),
    countSources: () => q(`SELECT count(*) AS n FROM sources`).get().n,

    // Bias lookups (bias.js)
    listBias: () => q(`SELECT source_id AS sourceId, checked_at AS checkedAt, outlet FROM source_bias`).all()
      .map(r => ({ ...r, outlet: r.outlet ? JSON.parse(r.outlet) : null })),
    setBias: (sourceId, outlet) => q(`INSERT INTO source_bias (source_id, checked_at, outlet) VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET checked_at = excluded.checked_at, outlet = excluded.outlet`).run(sourceId, Date.now(), outlet ? JSON.stringify(outlet) : null),
    clearBias: sourceId => (sourceId == null ? q(`DELETE FROM source_bias`).run() : q(`DELETE FROM source_bias WHERE source_id = ?`).run(sourceId)),
    recentUrls: (sourceId, limit) => q(`SELECT url FROM items WHERE source_id = ? AND url IS NOT NULL ORDER BY published_at DESC LIMIT ?`).all(sourceId, limit).map(r => r.url),

    getMeta: key => q(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ?? null,
    setMeta: (key, value) => q(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value)),

    addSource(s) {
      const sort = q(`SELECT coalesce(max(sort), 0) + 1 AS n FROM sources`).get().n;
      const r = q(`INSERT INTO sources (type, name, grp, category, color, config, enabled, sort, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.type, s.name, s.grp || 'Other', s.category || null, s.color || null,
             JSON.stringify(s.config || {}), s.enabled === false ? 0 : 1, s.sort ?? sort, Date.now());
      return api.getSource(Number(r.lastInsertRowid));
    },

    updateSource(id, s) {
      q(`UPDATE sources SET name = ?, grp = ?, category = ?, color = ?, config = ?, enabled = ? WHERE id = ?`)
        .run(s.name, s.grp || 'Other', s.category || null, s.color || null, JSON.stringify(s.config || {}), s.enabled ? 1 : 0, id);
      return api.getSource(id);
    },

    deleteSource(id) {
      api.tx(() => {
        q(`DELETE FROM items_fts WHERE rowid IN (SELECT id FROM items WHERE source_id = ?)`).run(id);
        q(`DELETE FROM sources WHERE id = ?`).run(id);
      });
    },

    // Items
    /** Inserts new items; returns only the ones that weren't already stored. */
    insertItems(sourceId, items) {
      const now = Date.now();
      const added = [];
      api.tx(() => {
        for (const it of items) {
          const r = stmts.insertItem.run(sourceId, it.extId, it.kind || 'article', it.title, it.summary ?? null,
            it.url ?? null, it.author ?? null, it.publishedAt, now, it.extra ? JSON.stringify(it.extra) : null);
          if (!r.changes) continue;
          const id = Number(r.lastInsertRowid);
          stmts.insertFts.run(id, it.title, it.summary ?? '');
          added.push({ id, ...it });
        }
      });
      return added;
    },

    /** The live list at startup: the newest `limit` items, plus each source's newest
     *  `perSource` (so slow sources aren't crowded out — see trimToMax in feed.js). */
    recentItems: (since, limit, perSource = 10) =>
      q(`SELECT ${ITEM_COLS}, (SELECT 1 FROM snapshots WHERE item_id = i.id) AS saved
         FROM items i
         WHERE i.id IN (
           SELECT id FROM (SELECT id FROM items WHERE published_at >= $since ORDER BY published_at DESC LIMIT $limit)
           UNION
           -- each source's newest few, read from items_source_published (the old row_number() over the whole window
           -- sorted every recent item by source: ~5x slower, and this runs on the main thread at start-up)
           SELECT j.id FROM sources s2 JOIN items j ON j.id IN (
             SELECT id FROM items WHERE source_id = s2.id AND published_at >= $since ORDER BY published_at DESC LIMIT $perSource))
         ORDER BY i.published_at DESC`).all({ $since: since, $limit: limit, $perSource: perSource }).map(itemRow),

    getItem: id =>
      itemRow(q(`SELECT ${ITEM_COLS} FROM items i WHERE i.id = ?`).get(id)),

    // Enrichment (worker): grouping, places, language
    /** Items for the clustering index: newest first within the window. */
    clusterWindow: since =>
      q(`SELECT id, source_id AS sourceId, title, summary, published_at AS publishedAt, cluster_id AS clusterId, lang, orig_title AS origTitle, places IS NOT NULL AS tagged
         FROM items WHERE published_at >= ? ORDER BY published_at ASC`).all(since),

    setEnrichment(id, { clusterId, places }) {
      q(`UPDATE items SET cluster_id = ?, places = ? WHERE id = ?`).run(clusterId ?? null, JSON.stringify(places ?? []), id);
    },

    /** Every tagged item, oldest first, for re-tagging after the place matcher changed. */
    taggedItems: () =>
      q(`SELECT id, source_id AS sourceId, title, summary, published_at AS publishedAt, places FROM items
         WHERE places IS NOT NULL ORDER BY id`).all(),

    setPlaces: (id, places) => q(`UPDATE items SET places = ? WHERE id = ?`).run(JSON.stringify(places ?? []), id),

    setLang: (id, lang) => q(`UPDATE items SET lang = ? WHERE id = ?`).run(lang, id),

    saveSnapshotTranslation: (itemId, text) =>
      q(`UPDATE snapshots SET translated_text = ? WHERE item_id = ?`).run(text, itemId),

    // Opens / history
    recordOpen: (itemId, via) =>
      q(`INSERT INTO opens (item_id, opened_at, via) VALUES (?, ?, ?)`).run(itemId, Date.now(), via),

    /**
     * scope 'opened' -> articles you opened, newest open first.
     * scope 'all'    -> everything stored, newest published first.
     * query          -> full-text search over title, summary and saved article text.
     */
    history({ scope = 'opened', query = '', sourceIds = [], limit = 200, offset = 0 } = {}) {
      const match = ftsQuery(query);
      const ftsJoin  = match ? `JOIN items_fts f ON f.rowid = i.id AND items_fts MATCH $match` : '';
      // Optional "only these sources" (search-bar chips); ids are checked integers, so inlined.
      const ids = (Array.isArray(sourceIds) ? sourceIds : []).filter(Number.isInteger);
      const where = ids.length ? `WHERE i.source_id IN (${ids.join(',')})` : '';
      const run = ids.length ? sql => db.prepare(sql) : q;     // the inlined ids make every such query different
      const params   = { $limit: limit, $offset: offset, ...(match ? { $match: match } : {}) };
      const snapCols = `sn.captured_at AS savedAt, sn.mhtml_path IS NOT NULL AS hasPage, sn.text IS NOT NULL AS hasText`;
      if (scope === 'opened') {
        return run(`SELECT ${ITEM_COLS}, o.lastOpened, o.opens, ${snapCols}
                  FROM (SELECT item_id, max(opened_at) AS lastOpened, count(*) AS opens FROM opens GROUP BY item_id) o
                  JOIN items i ON i.id = o.item_id ${ftsJoin}
                  LEFT JOIN snapshots sn ON sn.item_id = i.id ${where}
                  ORDER BY o.lastOpened DESC LIMIT $limit OFFSET $offset`).all(params).map(itemRow);
      }
      return run(`SELECT ${ITEM_COLS}, NULL AS lastOpened, 0 AS opens, ${snapCols}
                FROM items i ${ftsJoin}
                LEFT JOIN snapshots sn ON sn.item_id = i.id ${where}
                ORDER BY i.published_at DESC LIMIT $limit OFFSET $offset`).all(params).map(itemRow);
    },

    // Snapshots
    getSnapshot: itemId => q(`SELECT * FROM snapshots WHERE item_id = ?`).get(itemId),

    saveSnapshot(itemId, s) {
      api.tx(() => {
        q(`INSERT OR REPLACE INTO snapshots
             (item_id, captured_at, final_url, mhtml_path, mhtml_bytes, title, byline, site_name, excerpt, content_html, text, word_count, lang, method, partial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(itemId, s.capturedAt, s.finalUrl ?? null, s.mhtmlPath ?? null, s.mhtmlBytes ?? null, s.title ?? null,
               s.byline ?? null, s.siteName ?? null, s.excerpt ?? null, s.contentHtml ?? null, s.text ?? null, s.wordCount ?? null, s.lang ?? null, s.method ?? null, s.partial ? 1 : 0);
        if (s.text) api.indexArticle(itemId, s.text);
      });
    },

    /** Replaces only the extracted text of a snapshot (the saved page file stays). */
    updateSnapshotText(itemId, s) {
      api.tx(() => {
        q(`UPDATE snapshots SET title = ?, byline = ?, site_name = ?, excerpt = ?, content_html = ?, text = ?, word_count = ?,
              lang = ?, method = ?, partial = ?, translated_text = NULL WHERE item_id = ?`)
          .run(s.title ?? null, s.byline ?? null, s.siteName ?? null, s.excerpt ?? null, s.contentHtml ?? null, s.text ?? null,
               s.wordCount ?? null, s.lang ?? null, s.method ?? null, s.partial ? 1 : 0, itemId);
        if (s.text) api.indexArticle(itemId, s.text);
      });
    },

    /** Saved pages whose text predates the current extractor (or came out empty). */
    snapshotsToReextract: () =>
      q(`SELECT item_id AS itemId, mhtml_path AS mhtmlPath FROM snapshots
         WHERE mhtml_path IS NOT NULL AND (method IS NULL OR text IS NULL) ORDER BY captured_at DESC`).all(),

    /** Puts saved article text into the search index (call inside a transaction). */
    indexArticle(itemId, text) {
      const it = q(`SELECT title, summary FROM items WHERE id = ?`).get(itemId);
      q(`DELETE FROM items_fts WHERE rowid = ?`).run(itemId);
      q(`INSERT INTO items_fts (rowid, title, summary, article) VALUES (?, ?, ?, ?)`)
        .run(itemId, it?.title ?? '', it?.summary ?? '', text);
    },

    /** Drops saved page files older than the cutoff (clean text is kept). Returns their paths. */
    expirePages(cutoff) {
      const rows = q(`SELECT item_id, mhtml_path FROM snapshots WHERE mhtml_path IS NOT NULL AND captured_at < ?`).all(cutoff);
      q(`UPDATE snapshots SET mhtml_path = NULL, mhtml_bytes = NULL WHERE mhtml_path IS NOT NULL AND captured_at < ?`).run(cutoff);
      return rows.map(r => r.mhtml_path);
    },

    /** Deletes every saved article (page and text) and drops its text from search. Returns the page paths. */
    clearSnapshots() {
      let paths = [];
      api.tx(() => {
        paths = q(`SELECT mhtml_path FROM snapshots WHERE mhtml_path IS NOT NULL`).all().map(r => r.mhtml_path);
        q(`UPDATE items_fts SET article = '' WHERE rowid IN (SELECT item_id FROM snapshots)`).run();
        q(`DELETE FROM snapshots`).run();
      });
      return paths;
    },

    stats: () => q(`SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM opens) AS opens,
                           (SELECT count(*) FROM snapshots) AS snapshots,
                           (SELECT coalesce(sum(mhtml_bytes), 0) FROM snapshots) AS pageBytes`).get(),
  };
  return api;
}

module.exports = { open, ftsQuery };
