'use strict';

// Runs in the feed worker. For every new item:
//   1. detect its language
//   2. English -> group with related stories + tag places, right away
//      Other  -> post it as-is, translate it in the background, then group/tag
//               the English text and post an update.
// On startup the grouping index is rebuilt from the database and anything
// stored before these features existed is backfilled. When the place matcher
// changes (GEOTAG_VERSION), every stored item is re-tagged in the background.

const { Clusterer, WINDOW_MS } = require('./cluster');
const { geotag, countryCode, GEOTAG_VERSION } = require('./geotag');
const { detectLang } = require('./text');
const { headline } = require('../adapters/util');

const BACKFILL_TRANSLATE_HOURS = 24;
const RETAG_CHUNK = 500;

// "Urgent |" style prefixes that translation models garble; replaced with BREAKING.
const BREAKING_RX = /^\s*[❗️❕‼️🔴⚡️🚨\s]*(عاجل(?: جدا)?|מבזק|דחוף|فوری|خبر فوری|Срочно|СРОЧНО|Терміново|ТЕРМІНОВО|Молния|МОЛНИЯ)\s*[|:：\-–—]?\s*/u;

function splitBreaking(text) {
  if (!text) return { breaking: false, text };
  const m = text.match(BREAKING_RX);
  return m ? { breaking: true, text: text.slice(m[0].length) } : { breaking: false, text };
}

class Enricher {
  /**
   * @param store      db wrapper (feed worker's connection)
   * @param translate  (lang, texts, priority) -> Promise<string[]|null>
   * @param emitUpdate (items[]) -> void   posts updated items to the UI
   */
  constructor({ store, log, translate, emitUpdate, translateEnabled = true }) {
    Object.assign(this, { store, log, translate, emitUpdate, translateEnabled });
    this.clusterer = new Clusterer();
    this.pending = new Set();          // item ids being translated
    this.homes = new Map();            // source id -> ISO code of its group's country (or null)
  }

  /** The source's home country, from its sidebar group ("USA", "India"); breaks ties between places. */
  homeCc(sourceId) {
    if (!this.homes.has(sourceId)) this.homes.set(sourceId, countryCode(this.store.getSource(sourceId)?.grp));
    return this.homes.get(sourceId);
  }

  /** Sources were added or edited (their group may have changed). */
  sourcesChanged() { this.homes.clear(); }

  places(it) {
    return geotag({ title: it.title, summary: it.summary }, { cc: this.homeCc(it.sourceId) });
  }

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
          const foreignUntranslated = r.lang !== 'en' && !r.origTitle;
          if (r.clusterId != null && r.tagged) { this.clusterer.add(r.id, r.title, r.publishedAt, r.clusterId); continue; }
          if (foreignUntranslated && this.translateEnabled) continue;   // handled by the translation backfill
          const clusterId = this.clusterer.add(r.id, r.title, r.publishedAt, r.clusterId);
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
    const recent = Date.now() - WINDOW_MS * 1.5;
    let changed = 0, at = 0;
    const step = () => {
      const live = [];
      this.store.tx(() => {
        for (const r of rows.slice(at, at + RETAG_CHUNK)) {
          const places = this.places(r);
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

  setTranslation(enabled) {
    const was = this.translateEnabled;
    this.translateEnabled = enabled;
    if (enabled && !was) this.backfillTranslations();
  }

  /** Queues translation for recent foreign-language items that never got one. */
  backfillTranslations() {
    if (!this.translateEnabled) return;
    const rows = this.store.untranslated(Date.now() - BACKFILL_TRANSLATE_HOURS * 3600e3, 300);
    if (rows.length) this.log.info(`Translation backfill: ${rows.length} item(s) queued`);
    for (const r of rows) this.queueTranslation({ ...r, kind: null }, 0);
  }

  /**
   * Enriches freshly stored items. Returns them with clusterId/places/lang so the
   * worker can post them immediately.
   */
  process(items, source) {
    const translate = [];
    this.store.tx(() => {                 // one commit for the whole poll, not two per item
      for (const it of items) {
        it.sourceId = source.id;
        it.lang = detectLang(`${it.title} ${(it.summary || '').slice(0, 200)}`) || 'en';
        this.store.setLang(it.id, it.lang);
        if (it.lang !== 'en' && this.translateEnabled) {
          it.translating = true;
          it.places = [];
          it.clusterId = it.id;
          translate.push(it);
          continue;
        }
        this.enrich(it);
      }
    });
    for (const it of translate) this.queueTranslation(it, 1);     // async: runs after the transaction closed
    return items;
  }

  enrich(it) {
    it.clusterId = this.clusterer.add(it.id, it.title, it.publishedAt);
    it.places = this.places(it);
    this.store.setEnrichment(it.id, { clusterId: it.clusterId, places: it.places });
    return it;
  }

  async queueTranslation(it, priority) {
    if (this.pending.has(it.id)) return;
    this.pending.add(it.id);
    try {
      // Posts/messages: the title is just the first line of the text, so translate
      // the text once and take the new first line. Articles: translate both.
      const isShort = it.summary && it.title && it.summary.startsWith(it.title.replace(/…$/, '').slice(0, 40));
      const head = splitBreaking(isShort ? it.summary : it.title);
      const texts = isShort ? [head.text.slice(0, 1200)] : [head.text, it.summary ? it.summary.slice(0, 800) : ''];
      const out = await this.translate(it.lang, texts, priority);
      if (!out) { this.enrichOriginal(it); return; }
      if (head.breaking) out[0] = `BREAKING: ${out[0]}`;
      const title   = isShort ? headline(out[0], 200) : out[0];
      const summary = isShort ? out[0] : (out[1] || null);
      this.store.applyTranslation(it.id, { title, summary, lang: it.lang });
      const full = this.store.getItem(it.id);
      if (!full) return;
      this.enrich(full);
      this.emitUpdate([{ ...full, translating: false }]);
    } catch (e) {
      this.log.warn(`Translation of item ${it.id} failed: ${e.message}`);
      this.enrichOriginal(it);
    } finally {
      this.pending.delete(it.id);
    }
  }

  /** Translation unavailable: group/tag on the original text and tell the UI it's final. */
  enrichOriginal(it) {
    const full = this.store.getItem(it.id);
    if (!full) return;
    this.enrich(full);
    this.emitUpdate([{ ...full, translating: false }]);
  }
}

module.exports = { Enricher };
