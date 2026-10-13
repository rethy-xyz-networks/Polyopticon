'use strict';

// Runs in an Electron utility process so fetching, parsing and SQLite inserts
// never block the main process. Hosts one adapter per enabled source, stores
// new items, and posts them to the main process.

const db = require('./db');
const { Enricher } = require('./enrich');
const { ADAPTERS, CREDENTIAL_DEPS, telegramService } = require('./adapters');

const port = process.parentPort;
const post = msg => port.postMessage(msg);

// Forward logger calls to the main process, which owns the log files.
const forward = method => (...args) =>
  post({ type: 'log', method, args: args.map(a => (a instanceof Error ? { name: a.name, message: a.message } : a)) });
const log = {
  debug: forward('debug'), info: forward('info'), warn: forward('warn'), error: forward('error'),
  set: forward('set'), onError: forward('onError'), snapshot: forward('snapshot'),
};

let store = null;
let settings = { intervalSeconds: 5, staggerMs: 300 };
let credentials = {};
const running = new Map();             // source id -> { adapter, sig }

const ctx = {
  log,
  get credentials() { return credentials; },

  ingest(source, items) {
    const added = store.insertItems(source.id, items);
    if (added.length) {
      enricher.process(added, source);
      post({
        type: 'items',
        items: added.map(it => ({
          id: it.id, sourceId: source.id, sourceName: source.name, kind: it.kind || 'article',
          title: it.title, summary: it.summary ?? null, url: it.url ?? null, author: it.author ?? null,
          publishedAt: it.publishedAt, clusterId: it.clusterId, places: it.places, lang: it.lang,
          translating: !!it.translating, site: it.extra?.site ?? null,
        })),
      });
    }
    return added;
  },

  status(source, label, isError) { post({ type: 'status', sourceId: source.id, label, isError }); },

  intervalMs(source, meta) {
    const def = meta.defaultInterval === 'global' ? settings.intervalSeconds : meta.defaultInterval;
    return Math.max(meta.minInterval, source.config.interval || def) * 1000;
  },
};

const signature = s => JSON.stringify([s.type, s.name, s.config]);

/** Starts, stops or restarts adapters so they match the enabled sources. */
function syncSources(sources, { restartTypes = [] } = {}) {
  const wanted = new Map(sources.filter(s => s.enabled && ADAPTERS[s.type]).map(s => [s.id, s]));

  for (const [id, run] of running) {
    const s = wanted.get(id);
    if (!s || signature(s) !== run.sig || restartTypes.includes(s.type)) {
      run.adapter.stop();
      running.delete(id);
      if (!s) post({ type: 'status', sourceId: id, label: '', isError: false });
    }
  }

  let stagger = 0;
  for (const [id, s] of wanted) {
    if (running.has(id)) continue;
    const adapter = new ADAPTERS[s.type](s, ctx);
    running.set(id, { adapter, sig: signature(s) });
    adapter.start(stagger);
    stagger += settings.staggerMs;
  }
  log.info(`Sources: ${running.size} active`);
}

let lastSources = [];

async function handle(data) {
  switch (data.cmd) {
    case 'init':
      store = db.open(data.dbPath);
      settings = data.settings;
      credentials = data.credentials || {};
      enricher = new Enricher({
        store, log, translate: requestTranslation, translateEnabled: settings.translate !== false,
        emitUpdate: items => post({ type: 'items-updated', items }),
      });
      enricher.init();
      enricher.backfillTranslations();
      break;

    case 'translated':
      pendingTranslations.get(data.reqId)?.(data.out);
      pendingTranslations.delete(data.reqId);
      break;

    case 'sources':
      lastSources = data.sources;
      enricher?.sourcesChanged();
      syncSources(lastSources);
      break;

    case 'settings':
      settings = { ...settings, ...data.settings };
      enricher?.setTranslation(settings.translate !== false);
      for (const { adapter } of running.values()) adapter.reschedule();
      break;

    case 'credentials': {
      const prev = credentials;
      credentials = data.credentials || {};
      const changed = Object.keys({ ...prev, ...credentials })
        .filter(k => JSON.stringify(prev[k]) !== JSON.stringify(credentials[k]));
      const types = Object.entries(CREDENTIAL_DEPS).filter(([, deps]) => deps.some(d => changed.includes(d))).map(([t]) => t);
      if (types.length) syncSources(lastSources, { restartTypes: types });
      break;
    }

    case 'refresh':
      log.info(`Manual refresh — polling ${running.size} sources`);
      await Promise.all([...running.values()].map(r => r.adapter.pollOnce()));
      post({ type: 'refreshed', id: data.id });
      break;

    // Telegram account
    case 'tg-login': {
      const answers = new Map();
      tgAnswer = (what, value) => { answers.get(what)?.(value); answers.delete(what); };
      const ask = (what, hint) => new Promise(resolve => { answers.set(what, resolve); post({ type: 'tg-ask', what, hint: hint || null }); });
      try {
        const res = await telegramService.login(data, ask, err => { log.info(`Telegram login: ${err.errorMessage || err.message} — asking again`); post({ type: 'tg-error', message: err.errorMessage || err.message, fatal: false }); });
        post({ type: 'tg-done', session: res.session, user: res.user });
      } catch (e) {
        const message = e.errorMessage || e.message;
        log.warn(`Telegram login failed: ${message}`);
        post({ type: 'tg-error', message, fatal: true });
      } finally {
        tgAnswer = null;
      }
      break;
    }
    case 'tg-answer':
      tgAnswer?.(data.what, data.value);
      break;
    case 'tg-logout':
      await telegramService.logout();
      post({ type: 'tg-logged-out' });
      break;

    case 'stop':
      for (const { adapter } of running.values()) adapter.stop();
      running.clear();
      await telegramService.disconnect();
      store?.close();
      process.exit(0);
  }
}

let tgAnswer = null;

// Translation (done by the translator process, brokered by main)
let enricher = null;
let translationSeq = 0;
const pendingTranslations = new Map();
function requestTranslation(lang, texts, priority) {
  const reqId = ++translationSeq;
  return new Promise(resolve => {
    pendingTranslations.set(reqId, resolve);
    post({ type: 'translate', reqId, lang, texts, priority });
  });
}

port.on('message', ({ data }) => {
  handle(data).catch(e => log.error(`Worker command '${data.cmd}' failed`, e));
});
