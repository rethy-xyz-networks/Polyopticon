'use strict';

// Runs in the feed worker. For every new item: detect its language, then group
// it with related stories and tag places.
// On startup the grouping index is rebuilt from the database and anything
// stored before these features existed is backfilled. When the place matcher
// changes (GEOTAG_VERSION), every stored item is re-tagged in the background. A national outlet's
// story that names no place is placed in its home country (home.js).

const { Clusterer, WINDOW_MS } = require('./cluster');
const { geotag, countryCode, placeCc, placeSpots, countryPlace, GEOTAG_VERSION } = require('./geotag');
const { HomeShare } = require('./home');
const { detectLang } = require('./text');

const RETAG_CHUNK = 500;

class Enricher {
  /**
   * @param store      db wrapper (feed worker's connection)
   * @param emitUpdate (items[]) -> void   posts updated items to the UI
   */
  constructor({ store, log, emitUpdate }) {
    Object.assign(this, { store, log, emitUpdate });
    this.clusterer = new Clusterer();
    this.homes = new Map();            // source id -> ISO code of its group's country (or null)
    let saved = {};
    try { saved = JSON.parse(store.getMeta('homeShare') || '{}'); } catch { /* start afresh */ }
    this.homeShare = new HomeShare(saved);
  }

  /** The source's home country, from its sidebar group ("USA", "India"); breaks ties between places. */
  homeCc(sourceId) {
    if (!this.homes.has(sourceId)) this.homes.set(sourceId, countryCode(this.store.getSource(sourceId)?.grp));
    return this.homes.get(sourceId);
  }

  /** Sources were added or edited (their group may have changed). */
  sourcesChanged() { this.homes.clear(); }

  /** The matcher's places, counted towards the source's home share. */
  found(it) {
    const cc = this.homeCc(it.sourceId);
    const places = geotag({ title: it.title, summary: it.summary }, { cc });
    this.homeShare.record(it.sourceId, cc, places.map(p => placeCc(p[0])));
    return places;
  }

  /** Places for a story: what it names, else a national outlet's home country. */
  places(it, found = this.found(it)) {
    if (found.length || !this.homeShare.national(it.sourceId)) return found;
    const home = countryPlace(this.homeCc(it.sourceId));
    return home ? [home] : [];
  }

  /** Where a headline says its story is, for grouping: templated headlines differ only there. */
  where(it) {
    const places = geotag({ title: it.title }, { cc: this.homeCc(it.sourceId) });
    return { ccs: [...new Set(places.map(p => placeCc(p[0])).filter(Boolean))], spots: [...new Set(places.flatMap(p => placeSpots(p[0])))] };
  }

  saveHomeShare() { this.store.setMeta('homeShare', JSON.stringify(this.homeShare)); }

  /** Builds the grouping index from recent items and backfills older rows. */
  init() {
    const started = Date.now();
    const rows = this.store.clusterWindow(Date.now() - WINDOW_MS * 1.5);
    const backfilled = [];
    // One transaction per chunk: a commit per row (two writes each) dominated the time of a cold start.
    for (let at = 0; at < rows.length; at += RETAG_CHUNK) {
      this.store.tx(() => {
        for (const r of rows.slice(at, at + RETAG_CHUNK)) {
          if (r.lang == null) {
            r.lang = detectLang(r.origTitle || r.title) || 'en';
            this.store.setLang(r.id, r.lang);
          }
          // Its places (a geotag of the title) only matter if a new item is compared with it: worked out then.
          // The function keeps the title and source, not the whole row (its summary).
          if (r.clusterId != null && r.tagged) {
            const { title, sourceId } = r;
            this.clusterer.add(r.id, title, r.publishedAt, r.clusterId, () => this.where({ title, sourceId }));
            continue;
          }
          const clusterId = this.clusterer.add(r.id, r.title, r.publishedAt, r.clusterId, this.where(r));
          this.store.setEnrichment(r.id, { clusterId, places: this.places(r) });
          backfilled.push(r.id);
        }
      });
    }
    this.log.info(`Grouping index: ${this.clusterer.size} items (${backfilled.length} backfilled) in ${Date.now() - started} ms`);
    // The UI may already be showing these items without groups/places — send the new values.
    this.emitItems(backfilled);
    setInterval(() => this.clusterer.prune(), 3600e3).unref?.();
    if (Number(this.store.getMeta('geotagVersion')) !== GEOTAG_VERSION) this.retag();
  }

  emitItems(ids) {
    for (let i = 0; i < ids.length; i += 200)
      this.emitUpdate(ids.slice(i, i + 200).map(id => this.store.getItem(id)).filter(Boolean));
  }

  /** Re-tags every stored item with the current matcher, a chunk per tick so new items keep flowing. */
  retag() {
    const started = Date.now();
    const rows = this.store.taggedItems();
    // Counted afresh from every stored story first, so the home fallback below uses the full picture.
    this.homeShare = new HomeShare();
    const found = new Map(rows.map(r => [r.id, this.found(r)]));
    this.saveHomeShare();
    const recent = Date.now() - WINDOW_MS * 1.5;
    let changed = 0, at = 0;
    const step = () => {
      const live = [];
      this.store.tx(() => {
        for (const r of rows.slice(at, at + RETAG_CHUNK)) {
          const places = this.places(r, found.get(r.id));
          if (JSON.stringify(places) === r.places) continue;
          this.store.setPlaces(r.id, places);
          changed++;
          if (r.publishedAt >= recent) live.push(r.id);   // only recent items can be on screen
        }
      });
      this.emitItems(live);
      at += RETAG_CHUNK;
      if (at < rows.length) return setImmediate(step);
      this.store.setMeta('geotagVersion', GEOTAG_VERSION);
      this.log.info(`Places re-tagged: ${changed} of ${rows.length} items changed in ${Date.now() - started} ms`);
    };
    step();
  }

  /**
   * Enriches freshly stored items. Returns them with clusterId/places/lang so the
   * worker can post them immediately.
   */
  process(items, source) {
    // The whole poll counts towards the source's home share before any of it falls back to it.
    const found = new Map(items.map(it => { it.sourceId = source.id; return [it, this.found(it)]; }));
    this.store.tx(() => {                 // one commit for the whole poll, not two per item
      for (const it of items) {
        it.lang = detectLang(`${it.title} ${(it.summary || '').slice(0, 200)}`) || 'en';
        this.store.setLang(it.id, it.lang);
        this.enrich(it, found.get(it));
      }
      if (items.length) this.saveHomeShare();
    });
    return items;
  }

  enrich(it, found) {
    it.clusterId = this.clusterer.add(it.id, it.title, it.publishedAt, null, this.where(it));
    it.places = this.places(it, found);
    this.store.setEnrichment(it.id, { clusterId: it.clusterId, places: it.places });
    return it;
  }
}

module.exports = { Enricher };
