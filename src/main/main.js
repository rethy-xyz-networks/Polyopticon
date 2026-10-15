'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, session, utilityProcess, protocol, nativeTheme, screen, webContents, net } = require('electron');
const fs        = require('fs');
const path      = require('path');
const log       = require('./logger');
const store     = require('./store');
const blocker   = require('./blocker');
const secrets   = require('./secrets');
const scratchpad = require('./scratchpad');
const snapshots = require('./snapshots');
const screenshot = require('./screenshot');
const favicons  = require('./favicons');
const chat      = require('./chat');
const irc       = require('./irc');
const fourchan  = require('./fourchan');
const perfwatch = require('./perfwatch');
const database  = require('./db');
const biasLookup = require('./bias');
const { SEED_GROUPS, SEED_REVISION, RETIRED, RENAMED } = require('./config');
const { TYPES, validateSource } = require('./adapters/types');

// POLYOPTICON_DATA_DIR runs a separate copy (own database, settings, logins), e.g. for testing.
// POLYOPTICON_OFFSCREEN=1 (set by the tests) opens the window off-screen, unfocused and
// out of the taskbar, so a test run doesn't get in the way of using the computer.
const OFFSCREEN         = process.env.POLYOPTICON_OFFSCREEN === '1';
const migrated          = [];       // logged once the log is open
const DATA_DIR          = process.env.POLYOPTICON_DATA_DIR || renamedDir(path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Polyopticon'));
if (process.env.POLYOPTICON_DATA_DIR) app.setPath('userData', path.join(DATA_DIR, 'browser'));
// Site logins, cookies and cache: Electron's default spot (%AppData%\Polyopticon), named here so
// the move from the old name can be tested with APPDATA pointing elsewhere.
else app.setPath('userData', renamedDir(path.join(process.env.APPDATA || app.getPath('appData'), 'Polyopticon')));
const DB_PATH           = renamedFile(path.join(DATA_DIR, 'polyopticon.db'), ['itsover.db', 'itsjoever.db'], ['-wal', '-shm', ''])   // database last;

// The app was called ItsJoever, then ItsOver (until 2026-10). Its folders (and database file) are
// moved to the new names on the first launch after the rename. If a move fails —
// e.g. the old version is still running — this run keeps using the old location,
// so nothing looks lost; the move is tried again next launch.
function renamedDir(dir) {
  const old = ['ItsOver', 'ItsJoever'].map(n => path.join(path.dirname(dir), n)).find(fs.existsSync);
  if (fs.existsSync(dir) || !old) return dir;
  try { fs.renameSync(old, dir); migrated.push(`${old} -> ${dir}`); return dir; }
  catch (e) { migrated.push(`could not move ${old} (${e.code || e.message}) — using it as is`); return old; }
}
function renamedFile(file, oldNames, suffixes) {
  const old = oldNames.map(n => path.join(path.dirname(file), n)).find(fs.existsSync);
  if (fs.existsSync(file) || !old) return file;
  try {
    for (const x of suffixes) if (fs.existsSync(old + x)) fs.renameSync(old + x, file + x);
    migrated.push(`${old} -> ${file}`);
    return file;
  } catch (e) { migrated.push(`could not rename ${old} (${e.code || e.message}) — using it as is`); return old; }
}
const ARTICLE_PARTITION = 'persist:articles';
// Direct video links in the stream area (any site, so not the chat session); memory only.
// Same name as DIRECT_PARTITION in src/renderer/streams.js — keep them alike.
const DIRECT_PARTITION  = 'direct-video';
let directSession = null;
const READER_SCHEME     = 'polyopticon-reader';
const ICON_SCHEME       = 'polyopticon-icon';

protocol.registerSchemesAsPrivileged([
  { scheme: READER_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: ICON_SCHEME,   privileges: { standard: true, secure: true } },
]);

let win      = null;
let worker   = null;
let settings = null;
let db       = null;
let refreshSeq = 0;
const pendingRefreshes = new Map();

const isWebUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);

function openExternal(url) {
  if (!isWebUrl(url)) return;
  log.info(`Open in browser -> ${url}`);
  shell.openExternal(url).catch(e => log.warn(`openExternal failed: ${e.message}`));
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Sources

function seedSources() {
  const strip = ({ since, ...s }) => s;
  if (db.countSources() === 0) {
    let sort = 0;
    for (const g of SEED_GROUPS)
      for (const s of g.sources) db.addSource({ ...strip(s), grp: g.grp, sort: ++sort });
    log.info(`Seeded ${sort} default sources`);
  } else {
    // Existing database: add sources introduced since its last seed, once.
    // Anything with the same name is left alone (it may have been edited).
    const rev = Number(db.getMeta('seed_revision') ?? 1);
    if (rev >= SEED_REVISION) return;
    // Renames first, so a renamed source isn't added again under its new name.
    for (const r of RENAMED.filter(r => r.since > rev)) {
      const s = db.listSources().find(x => x.name === r.from && x.config?.url === r.url);
      if (s) { db.updateSource(s.id, { ...s, name: r.to }); log.info(`Renamed default source: ${r.from} -> ${r.to}`); }
    }
    const names = new Set(db.listSources().map(s => s.name.toLowerCase()));
    const added = [];
    for (const g of SEED_GROUPS)
      for (const s of g.sources)
        if ((s.since ?? 1) > rev && !names.has(s.name.toLowerCase())) { db.addSource({ ...strip(s), grp: g.grp }); added.push(s.name); }
    if (added.length) log.info(`Added ${added.length} new default sources: ${added.join(', ')}`);
    for (const r of RETIRED.filter(r => r.since > rev)) {
      const s = db.listSources().find(x => x.name === r.name && x.config?.url === r.url);
      if (s) { db.deleteSource(s.id); log.info(`Removed retired default source: ${r.name} (and its stories)`); }
    }
  }
  db.setMeta('seed_revision', SEED_REVISION);
}

// Political lean (bias.js)
// Each RSS source is looked up once, a little after start-up (its first poll has filled in the links the
// lookup also uses); Settings can force all of them again. Tests don't go online (OFFSCREEN).

let biasChecker = null;
let biasTimer = null;

function setupBias() {
  const get = async url => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try { return await net.fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } }); }
    finally { clearTimeout(timer); }
  };
  biasChecker = biasLookup.createChecker({
    db, log, getJson: biasLookup.httpJson(get, { log }),
    onChange: () => send('bias:changed', db.listBias()),
    onProgress: p => send('bias:progress', p),
  });
  scheduleBiasCheck(20_000);
}

function scheduleBiasCheck(delayMs) {
  if (OFFSCREEN || !biasChecker) return;
  clearTimeout(biasTimer);
  biasTimer = setTimeout(() => biasChecker.checkPending(), delayMs);
  biasTimer.unref?.();
}

function sourcesChanged() {
  const sources = db.listSources();
  worker?.postMessage({ cmd: 'sources', sources });
  send('sources:changed', sources);
}

// Feed worker
// Fetching, parsing and item inserts run in a utility process so they never
// stall the main process. The worker forwards log calls here.

function workerSettings() {
  return { intervalSeconds: settings.RefreshIntervalSeconds, staggerMs: settings.SourceStaggerMs, translate: settings.TranslateEnabled };
}

// Translator process
// Started on first use; models download into DATA_DIR/models.

let translator = null;
let translateSeq = 0;
let translationPaused = false;   // after Stop: background (headline) translation stays off until the user translates something or toggles the setting
let stopping = false;
const pendingTranslate = new Map();
const MODELS_DIR = path.join(DATA_DIR, 'models');

function ensureTranslator() {
  if (translator) return translator;
  translator = utilityProcess.fork(path.join(__dirname, 'translator.js'), [], { serviceName: 'Polyopticon Translator' });
  translator.postMessage({ cmd: 'init', cacheDir: MODELS_DIR, options: { allowLarge: settings.TranslateLargeModel } });
  translator.on('message', msg => {
    if (msg.type === 'result') { pendingTranslate.get(msg.id)?.(msg); pendingTranslate.delete(msg.id); }
    else if (msg.type === 'progress') send('translate:progress', msg);
    else if (msg.type === 'log') (log[msg.level] ?? log.info)(msg.msg);
  });
  translator.on('exit', code => {
    log.warn(`Translator ${stopping ? 'stopped by the user' : 'exited'} (code ${code})`);
    translator = null;
    for (const resolve of pendingTranslate.values()) resolve({ out: null, reason: stopping ? 'cancelled' : 'translator exited' });
    pendingTranslate.clear();
    if (stopping) { removePartialDownloads(MODELS_DIR); send('translate:progress', { stage: 'stopped' }); }
    stopping = false;
  });
  return translator;
}

/** Hard stop: ends the translator process (and with it any download, model load or translation in progress). */
function stopTranslation() {
  translationPaused = true;
  if (!translator) return false;
  stopping = true;
  translator.kill();
  return true;
}

/** Stops the translator (it holds the model files open), then deletes every downloaded model.
 *  Headline translation stays paused, as after Stop, so the models aren't fetched again straight away. */
async function clearModels() {
  const t = translator;
  if (t) await new Promise(resolve => { t.once('exit', resolve); stopTranslation(); });
  else translationPaused = true;
  fs.rmSync(MODELS_DIR, { recursive: true, force: true, maxRetries: 3 });
  log.info('Cleared translation models');
}

/** A killed download leaves `*.tmp.*` files in the models folder; the finished files are untouched. */
function removePartialDownloads(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) removePartialDownloads(p);
      else if (/\.tmp\.\d+\./.test(e.name)) fs.rmSync(p, { force: true });
    }
  } catch { /* no models folder yet */ }
}

/** -> { out: string[] | null, reason?, model?, ms? } */
function translate(lang, texts, priority = 0, tag) {   // tag: lets progress messages name the request (an item id)
  if (translationPaused && priority < 2) return Promise.resolve({ out: null, reason: 'paused' });   // headlines wait; articles are the user's own request
  const id = ++translateSeq;
  return new Promise(resolve => {
    pendingTranslate.set(id, resolve);
    ensureTranslator().postMessage({ cmd: 'translate', id, lang, texts, priority, tag });
  });
}

function startFeeds() {
  if (!worker) {
    worker = utilityProcess.fork(path.join(__dirname, 'feed-worker.js'), [], { serviceName: 'Polyopticon Feeds' });
    worker.on('message', onWorkerMessage);
    worker.on('exit', code => {
      log.warn(`Feed worker exited (code ${code})`);
      worker = null;
      for (const resolve of pendingRefreshes.values()) resolve();
      pendingRefreshes.clear();
    });
    worker.postMessage({ cmd: 'init', dbPath: DB_PATH, settings: workerSettings(), credentials: secrets.get() });
  }
  log.snapshot('Application start');
  worker.postMessage({ cmd: 'sources', sources: db.listSources() });
}

function onWorkerMessage(msg) {
  switch (msg.type) {
    case 'items':  send('feed:items', msg.items); break;
    case 'status': send('feed:status', msg.sourceId, msg.label, msg.isError); break;
    case 'log': {
      const args = msg.method === 'error' && msg.args[1] ? [msg.args[0], msg.args[1]] : msg.args;
      log[msg.method]?.(...args);
      break;
    }
    case 'items-updated': send('feed:updated', msg.items); break;
    case 'translate':
      translate(msg.lang, msg.texts, msg.priority).then(r => worker?.postMessage({ cmd: 'translated', reqId: msg.reqId, out: r.out }));
      break;
    case 'refreshed':
      pendingRefreshes.get(msg.id)?.();
      pendingRefreshes.delete(msg.id);
      break;

    // Telegram login conversation: worker <-> renderer
    case 'tg-ask':   send('telegram:ask', msg.what, msg.hint); break;
    case 'tg-error': send('telegram:error', msg.message, msg.fatal); break;
    case 'tg-done': {
      const acc = secrets.get();
      saveAccounts({ ...acc, telegram: { ...acc.telegram, session: msg.session, user: msg.user } });
      log.info(`Telegram: logged in as ${msg.user}`);
      send('telegram:done', msg.user);
      break;
    }
    case 'tg-logged-out': send('telegram:done', null); break;
  }
}

function refreshFeeds() {
  if (!worker) return Promise.resolve();
  const id = ++refreshSeq;
  return new Promise(resolve => {
    pendingRefreshes.set(id, resolve);
    worker.postMessage({ cmd: 'refresh', id });
  });
}

function saveAccounts(next) {
  secrets.save(next);
  worker?.postMessage({ cmd: 'credentials', credentials: next });
  send('accounts:changed', secrets.summary());
}

// Settings

function applySettings(next) {
  const prev = settings;
  settings = { ...prev, ...next };
  store.saveSettings(settings);

  if (prev.RefreshIntervalSeconds !== settings.RefreshIntervalSeconds) {
    worker?.postMessage({ cmd: 'settings', settings: workerSettings() });
    log.set('settings.refresh_interval_s', settings.RefreshIntervalSeconds);
  }
  if (prev.DebugLogging !== settings.DebugLogging) {
    log.setDebug(settings.DebugLogging);
    log.info(`Debug logging ${settings.DebugLogging ? 'enabled' : 'disabled'}`);
  }
  if (prev.LogRetentionCount !== settings.LogRetentionCount) log.trimToRetention(settings.LogRetentionCount);
  if (prev.IsDarkTheme !== settings.IsDarkTheme) nativeTheme.themeSource = settings.IsDarkTheme ? 'dark' : 'light';
  if (prev.SnapshotRetentionDays !== settings.SnapshotRetentionDays) snapshots.expire(settings.SnapshotRetentionDays);
  if (prev.TranslateEnabled !== settings.TranslateEnabled) translationPaused = false;
  if (prev.TranslateEnabled !== settings.TranslateEnabled) worker?.postMessage({ cmd: 'settings', settings: workerSettings() });
  if (prev.TranslateLargeModel !== settings.TranslateLargeModel)
    translator?.postMessage({ cmd: 'options', options: { allowLarge: settings.TranslateLargeModel } });
}

// IPC

function dirSizeDeep(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      n += e.isDirectory() ? dirSizeDeep(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  } catch { /* missing */ }
  return n;
}

function dirSize(dir) {
  try { return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0); } catch { return 0; }
}

function registerIpc() {
  ipcMain.handle('app:init', () => {
    const since = settings.MaxArticleAgeHours > 0 ? Date.now() - settings.MaxArticleAgeHours * 3600e3 : 0;
    return {
      settings,
      sources: db.listSources(),
      types: TYPES,
      accounts: secrets.summary(),
      tags: store.loadTags(),
      pinned: store.loadPinned(),
      ui,
      recent: db.recentItems(since, settings.MaxFeedItems),
      bias: db.listBias(),
      logPath: log.path,
      logos: logoFiles(),
      picturesDir: screenshot.folderFor(''),
    };
  });

  // Renderer listeners are attached — begin polling.
  ipcMain.on('app:ready', () => startFeeds());

  ipcMain.handle('feeds:refresh', () => refreshFeeds());
  ipcMain.on('settings:save', (_e, next) => applySettings(next));
  ipcMain.on('tags:save', (_e, tags) => store.saveTags(tags));
  ipcMain.on('shortcuts:pages', (_e, combos) => { pageShortcuts = new Set(combos); });
  ipcMain.on('window:toggle-fullscreen', () => win?.setFullScreen(!win.isFullScreen()));
  ipcMain.on('tabs:pinned', (_e, list) => store.savePinned(list));
  ipcMain.on('tabs:pinned-sync', (e, list) => { store.savePinned(list); e.returnValue = true; });   // as the window closes
  ipcMain.on('ui:save', (_e, patch) => { if (patch && typeof patch === 'object') updateUi(patch); });
  ipcMain.on('shell:open', (_e, url) => openExternal(url));
  ipcMain.on('clipboard:write', (_e, value) => { if (typeof value === 'string') clipboard.writeText(value); });
  ipcMain.on('state:set', (_e, key, value) => log.set(key, value));
  ipcMain.on('log', (_e, level, msg) => {
    const fn = { debug: log.debug, info: log.info, warn: log.warn, error: log.error }[level] ?? log.info;
    fn(String(msg));
  });

  // Sources
  ipcMain.handle('sources:save', (_e, src) => {
    try {
      const clean = validateSource(src);
      const dupe = db.listSources().find(s => s.name.toLowerCase() === clean.name.toLowerCase() && s.id !== src.id);
      if (dupe) throw new Error(`A source named "${clean.name}" already exists`);
      const before = src.id ? db.getSource(src.id) : null;
      const saved = src.id ? db.updateSource(src.id, clean) : db.addSource(clean);
      if (before && before.config?.url !== saved.config?.url) db.clearBias(saved.id);       // another feed: another outlet
      scheduleBiasCheck(60_000);                                                           // after its first poll
      log.info(`Source ${src.id ? 'updated' : 'added'}: [${saved.type}] ${saved.name}`);
      sourcesChanged();
      return { ok: true, source: saved };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('sources:toggle', (_e, id, enabled) => {
    const s = db.getSource(id);
    if (s) { db.updateSource(id, { ...s, enabled }); sourcesChanged(); }
  });
  ipcMain.handle('sources:delete', (_e, id) => {
    const s = db.getSource(id);
    if (!s) return;
    db.deleteSource(id);
    log.info(`Source deleted: [${s.type}] ${s.name}`);
    sourcesChanged();
  });

  // Political lean
  ipcMain.handle('bias:recheck', () => { biasChecker?.recheckAll(); return true; });   // runs in the background; progress arrives as events

  // History & snapshots
  ipcMain.handle('history:list', (_e, opts) => db.history(opts));
  ipcMain.handle('items:get', (_e, ids) => (Array.isArray(ids) ? ids : []).map(id => db.getItem(id)).filter(Boolean));
  ipcMain.on('open:record', (_e, itemId, via) => {
    db.recordOpen(itemId, via);
    if (via === 'browser') {
      const item = db.getItem(itemId);
      if (item?.url) snapshots.queueBackground(itemId, item.url);
    }
  });
  ipcMain.handle('snapshot:capture', (_e, itemId, webContentsId) => {
    const wc = webContents.fromId(webContentsId);
    if (wc && fourchan.isChanContents(wc)) return null;          // 4chan pages are never saved
    return snapshots.captureTab(itemId, webContentsId);
  });
  ipcMain.handle('snapshot:get', (_e, itemId) => snapshots.describe(itemId));
  ipcMain.handle('snapshot:translate', async (_e, itemId) => {
    const snap = db.getSnapshot(itemId);
    if (!snap?.text) return { ok: false, error: 'No saved text for this article' };
    if (snap.translated_text) return { ok: true };
    if (!snap.lang || snap.lang === 'en') return { ok: false, error: 'This article is already in English' };
    translationPaused = false;                                   // the user asked for this one
    const r = await translate(snap.lang, [snap.text], 2, itemId);
    if (!r.out) {
      if (r.reason === 'cancelled') return { ok: false, cancelled: true, error: 'Translation stopped' };
      return { ok: false, error: r.reason === 'unsupported' ? 'No translation model for this language' : r.reason };
    }
    db.saveSnapshotTranslation(itemId, r.out[0]);
    log.info(`Translated saved article ${itemId} (${snap.lang}, ${r.ms} ms)`);
    return { ok: true };
  });
  ipcMain.handle('translate:stop', () => stopTranslation());

  // Screenshots: a whole page shown in the article area (a story in any view, 4chan, Telegram).
  ipcMain.handle('screenshot:take', (_e, webContentsId, title) => {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== win?.webContents) return { ok: false, error: 'No page to capture' };
    return screenshot.take(wc, { title: typeof title === 'string' ? title : '', folder: settings.ScreenshotFolder });
  });
  ipcMain.handle('screenshot:choose-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Save screenshots to', defaultPath: screenshot.folderFor(settings.ScreenshotFolder),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.on('screenshot:show', (_e, file) => {
    if (typeof file === 'string' && path.isAbsolute(file) && /\.png$/i.test(file)) shell.showItemInFolder(file);
  });

  // IRC chats: anonymous, read-only connections made here; the chat column shows what they hear.
  ipcMain.handle('irc:connect', (_e, id, spec) => irc.connect(String(id), spec, ev => send('irc:event', ev)));
  ipcMain.on('irc:disconnect', (_e, id) => irc.disconnect(String(id)));
  ipcMain.handle('translate:stats', () => ({ modelsBytes: dirSizeDeep(MODELS_DIR), dir: MODELS_DIR }));

  // Accounts
  ipcMain.handle('accounts:save', (_e, patch) => {
    const acc = { ...secrets.get() };
    for (const k of ['guardianKey', 'nytKey', 'newsapiKey'])
      if (k in patch) { if (patch[k]) acc[k] = String(patch[k]).trim(); else delete acc[k]; }
    if ('bluesky' in patch)
      acc.bluesky = patch.bluesky?.handle && patch.bluesky?.appPassword
        ? { handle: patch.bluesky.handle.trim().replace(/^@/, ''), appPassword: patch.bluesky.appPassword.trim() }
        : undefined;
    saveAccounts(acc);
    return secrets.summary();
  });
  ipcMain.handle('telegram:login', (_e, { apiId, apiHash, phone }) => {
    const acc = secrets.get();
    apiHash ||= acc.telegram?.apiHash;                      // blank field = keep the saved hash
    if (!/^\d+$/.test(String(apiId)) || !apiHash || !phone) return { ok: false, error: 'API ID, API hash and phone number are all required' };
    if (!worker) return { ok: false, error: 'Feed worker is not running' };
    saveAccounts({ ...acc, telegram: { apiId: String(apiId), apiHash: String(apiHash).trim() } });
    worker.postMessage({ cmd: 'tg-login', apiId: String(apiId), apiHash: String(apiHash).trim(), phone: String(phone).trim() });
    return { ok: true };
  });
  ipcMain.on('telegram:answer', (_e, what, value) => worker?.postMessage({ cmd: 'tg-answer', what, value: String(value) }));
  ipcMain.handle('telegram:logout', () => {
    worker?.postMessage({ cmd: 'tg-logout' });
    const acc = secrets.get();
    saveAccounts({ ...acc, telegram: { apiId: acc.telegram?.apiId, apiHash: acc.telegram?.apiHash } });
    log.info('Telegram: logged out');
  });

  // Scratchpad (encrypted on disk; see scratchpad.js). The sync variant runs as the window closes.
  ipcMain.handle('scratch:load', () => scratchpad.get());
  ipcMain.handle('scratch:save', (_e, note) => scratchpad.save(note));
  ipcMain.on('scratch:save-sync', (e, note) => { e.returnValue = scratchpad.save(note); });

  // Storage
  ipcMain.handle('storage:stats', () => ({
    ...db.stats(),
    dbBytes: ['', '-wal'].reduce((n, sfx) => { try { return n + fs.statSync(DB_PATH + sfx).size; } catch { return n; } }, 0),
    pagesOnDisk: dirSize(snapshots.dir),
    dataDir: DATA_DIR,
  }));
  ipcMain.on('storage:open', () => shell.openPath(DATA_DIR));
  ipcMain.handle('storage:clear-articles', () => snapshots.clearAll());
  ipcMain.handle('storage:clear-models', () => clearModels());
}

// UI state (ui.json)
// Layout and view state the renderer asks to keep, plus the window's bounds.
// Writes are batched; flushUi() runs on close so nothing is lost.

let ui = {};
let uiTimer = null;

function updateUi(patch) {
  Object.assign(ui, patch);
  clearTimeout(uiTimer);
  uiTimer = setTimeout(flushUi, 500);
}

function flushUi() {
  clearTimeout(uiTimer);
  uiTimer = null;
  store.saveUi(ui);
}

/** Saved window bounds, if they still fit on a connected display. */
function savedBounds() {
  const b = ui.window;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const overlapW = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const overlapH = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  if (overlapW < 200 || overlapH < 100) return null;          // monitor was unplugged or rearranged
  return { x: b.x, y: b.y, width: Math.max(900, b.width), height: Math.max(500, b.height) };
}

function trackWindow() {
  const save = () => {
    if (!win || win.isMinimized()) return;
    updateUi({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, save);
  win.on('close', () => { save(); flushUi(); });
}

// Window

function createWindow() {
  const bounds = OFFSCREEN ? null : savedBounds();
  win = new BrowserWindow({
    title: 'Polyopticon',
    width: 1600, height: 920, minWidth: 900, minHeight: 500,
    ...(OFFSCREEN ? { x: -30000, y: -30000, skipTaskbar: true } : bounds ?? { center: true }),
    show: false,
    backgroundColor: settings.IsDarkTheme ? '#0D0D0D' : '#F0F0F0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (OFFSCREEN) return win.showInactive();
    if (bounds && ui.window?.maximized) win.maximize();
    win.show();
  });
  trackWindow();
  perfwatch.start(win);                                     // CPU hogs and hangs -> session log
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // The shell page itself never navigates or spawns windows.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });

  // Lock down <webview>s: no preload, no node. Article views (web pages, the
  // reader view, saved pages inside the snapshot folder) always get the article
  // session; chat views (chat.js) get the chat session, for chat sites only.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration  = false;
    prefs.contextIsolation = true;
    prefs.sandbox          = true;
    if (params.partition === chat.CHAT_PARTITION) {
      prefs.partition = chat.CHAT_PARTITION;
      if (!chat.isChatUrl(params.src)) e.preventDefault();
      return;
    }
    if (params.partition === fourchan.CHAN_PARTITION) {
      prefs.partition = fourchan.CHAN_PARTITION;
      if (!isWebUrl(params.src)) e.preventDefault();
      return;
    }
    if (params.partition === DIRECT_PARTITION) {
      prefs.partition = DIRECT_PARTITION;
      if (!isWebUrl(params.src)) e.preventDefault();
      return;
    }
    prefs.partition = ARTICLE_PARTITION;                 // ad blocking + reader scheme live here
    if (!isAllowedViewUrl(params.src)) e.preventDefault();
  });

  // Full screen (toolbar button / F11): the renderer paints the button from these.
  win.on('enter-full-screen', () => send('window:fullscreen', true));
  win.on('leave-full-screen', () => send('window:fullscreen', false));

  win.on('closed', () => { win = null; });
}

/** The logo variants: Polyopticon.png in the renderer's assets folder. */
function logoFiles() {
  try { return fs.readdirSync(path.join(__dirname, '..', 'renderer', 'assets')).filter(f => /^Polyopticon\.png$/i.test(f)).sort(); }
  catch (e) { log.warn(`Logo variants unreadable: ${e.message}`); return []; }
}

function isAllowedViewUrl(u) {
  if (isWebUrl(u) || u?.startsWith(`${READER_SCHEME}://`)) return true;
  if (u?.startsWith('file:')) {
    try { return snapshots.isInside(require('url').fileURLToPath(u)); } catch { return false; }
  }
  return false;
}

// Links that articles try to open in new windows go to the system browser.
// App shortcuts pressed inside an article or chat page never reach the app window, so
// they're caught here and passed on. The renderer sends the list (src/renderer/shortcuts.js).
let pageShortcuts = new Set();
// Same naming as comboName in src/renderer/shortcuts.js — keep them alike.
function comboName(i) {
  if (i.meta || !i.key || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(i.key)) return null;
  const symbol = i.key.length === 1 && !/[\p{L}\p{N}]/u.test(i.key);
  const parts = [i.control && 'ctrl', i.alt && 'alt', i.shift && !symbol && 'shift', i.key.toLowerCase()].filter(Boolean);
  return parts.length > 1 || /^F\d{1,2}$/.test(i.key) ? parts.join('+') : null;   // function keys work on their own
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('before-input-event', (e, input) => {
    const combo = input.type === 'keyDown' ? comboName(input) : null;
    if (!pageShortcuts.has(combo)) return;
    e.preventDefault();
    send('app:shortcut', combo, contents.id);   // the renderer finds the page's area (article, chat, stream) by it
  });
  // Right-click in an article or chat page: a Copy / Paste menu (the pages have none of their own).
  contents.on('context-menu', (_e, params) => {
    const f = params.editFlags;
    const items = [];
    if (params.linkURL) items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    if (params.isEditable) items.push({ role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (params.isEditable || params.selectionText) items.push({ type: 'separator' }, { role: 'selectAll' });
    else if (!params.linkURL) items.push({ role: 'selectAll' });
    Menu.buildFromTemplate(items).popup();
  });
  // Ctrl + mouse wheel over a page: the renderer steps the one shared zoom (the Zoom setting).
  // One wheel input can be reported twice, a fraction of a millisecond apart; repeats inside 20 ms are dropped.
  let lastZoomAt = 0;
  if (!chat.isChatContents(contents)) contents.on('zoom-changed', (_ev, direction) => {
    const now = performance.now();
    if (now - lastZoomAt < 20) return;
    lastZoomAt = now;
    send('app:zoom', direction);
  });
  if (chat.isChatContents(contents)) chat.lockDown(contents, openExternal);
  else if (fourchan.isChanContents(contents)) fourchan.lockDown(contents, isWebUrl, (url, background) => send('chan:open', url, background));
  else if (contents.session === directSession) {
    // A direct video stays on its link: anything it tries to open goes to the system browser.
    contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    contents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url); });
  }
  else contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });

  // Pages fire many failing sub-frame loads (ad syncs etc.). Handling the events
  // here keeps Electron from printing a warning for every one of them.
  const onFail = (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) log.warn(`Article load failed: ${desc} (${code}) ${url}`);
    else log.debug(`Sub-frame load failed: ${desc} (${code}) ${url}`);
  };
  contents.on('did-fail-load', onFail);
  contents.on('did-fail-provisional-load', onFail);

  // A saved page must not navigate to other local files.
  contents.on('will-navigate', (e, url) => { if (url.startsWith('file:') && !isAllowedViewUrl(url)) e.preventDefault(); });
});

// Article pages behind HTTP auth (e.g. Canadian Press syndication links) reuse the
// login from a source whose feed URL carries one for the same site. Each page gets
// one attempt; a rejected login shows the site's own error instead of looping.
const authTried = new Set();
app.on('login', (event, contents, details, authInfo, callback) => {
  if (authInfo.isProxy || !db) return;
  const page = new URL(details.url);
  const login = db.listSources().map(s => {
    try { return new URL(s.config?.url); } catch { return null; }
  }).find(u => u?.username && u.protocol === page.protocol && u.host === page.host);
  if (!login) return;

  event.preventDefault();
  const key = `${contents?.id}|${details.url}`;
  if (authTried.has(key)) {
    authTried.delete(key);
    log.warn(`Login rejected by ${page.host}`);
    return callback();
  }
  authTried.add(key);
  setTimeout(() => authTried.delete(key), 30_000).unref?.();
  callback(decodeURIComponent(login.username), decodeURIComponent(login.password));
});

app.whenReady().then(() => {
  store.init(DATA_DIR);
  ui = store.loadUi();
  settings = store.loadSettings();
  log.init(DATA_DIR, settings.LogRetentionCount);
  for (const m of migrated) log.info(`Renamed from the old name: ${m}`);
  log.setDebug(settings.DebugLogging);
  nativeTheme.themeSource = settings.IsDarkTheme ? 'dark' : 'light';

  db = database.open(DB_PATH);
  seedSources();
  setupBias();
  secrets.load(DATA_DIR);
  scratchpad.load(DATA_DIR);

  const articles = session.fromPartition(ARTICLE_PARTITION);
  chat.init();
  fourchan.init();
  directSession = session.fromPartition(DIRECT_PARTITION);
  directSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  const blockStats = blocker.install(articles);
  blocker.loadLists(path.join(DATA_DIR, 'adblock-lists.bin'));        // EasyList etc., in the background
  setInterval(() => { if (blockStats.blocked) log.debug(`Ad/tracker requests blocked so far: ${blockStats.blocked}`); }, 60_000).unref();

  snapshots.init({ db, dir: path.join(DATA_DIR, 'snapshots'), partition: ARTICLE_PARTITION, notify: info => send('snapshot:saved', info) });
  snapshots.expire(settings.SnapshotRetentionDays);
  // Older saves were extracted with Readability alone; redo them from the saved page files.
  setTimeout(() => snapshots.reextractOld().catch(e => log.warn(`Re-extraction failed: ${e.message}`)), 15_000).unref?.();
  setInterval(() => snapshots.expire(settings.SnapshotRetentionDays), 6 * 3600e3).unref();

  // Site icons for feed rows (main window, default session).
  favicons.init(path.join(DATA_DIR, 'icons'));
  protocol.handle(ICON_SCHEME, req => favicons.handle(req));

  articles.protocol.handle(READER_SCHEME, req => {
    const u = new URL(req.url);
    const id = Number(u.pathname.split('/').filter(Boolean)[0]);   // polyopticon-reader://item/<id>[?lang=en]
    const html = id ? snapshots.readerHtml(id, { translated: u.searchParams.get('lang') === 'en' }) : null;
    return new Response(html ?? '<p style="font-family:sans-serif">No saved text for this article.</p>', {
      status: html ? 200 : 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Saved article HTML is untrusted: no scripts, no frames, no forms.
        'content-security-policy': "default-src 'none'; img-src * data: blob:; media-src *; style-src 'unsafe-inline'; font-src *",
      },
    });
  });

  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
});

app.on('render-process-gone', (_e, contents, details) =>
  log.warn(`Renderer gone (${contents.getType()}): ${details.reason}`));

app.on('window-all-closed', () => {
  worker?.postMessage({ cmd: 'stop' });
  translator?.kill();
  irc.closeAll();
  db?.close();
  log.shutdown();
  app.quit();
});
