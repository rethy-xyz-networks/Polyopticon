'use strict';

// Popped-out tabs: a tab from the article, chat or stream strips floating in a window of its own
// (right-click a tab -> Pop out). The window shows the same page on the same session, so logins
// carry over, in src/renderer/popout.html: a slim bar and one <webview> (or an IRC room's
// message list). The renderer of the main window decides what is popped out and remembers it
// (src/renderer/popouts.js); this module only owns the windows:
//   - one window per key; asking for an open one focuses it
//   - closing a window (its ✕, Ctrl+W, "Return to main window") tells the main window, which puts
//     the tab back in its strip
//   - when the app quits, the windows close without that message, so they come back at the next start
//   - each window's place and size is remembered per key (ui.json: popouts)

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const wins = new Map();            // key -> { win, spec }
let opts = null;                   // { preload, page, icon, offscreen, guard, getUi, updateUi, notify, settings }
let quitting = false;

const bySender = sender => [...wins.values()].find(w => !w.win.isDestroyed() && w.win.webContents === sender) ?? null;

/** A saved place, if it still fits on a connected display. */
function savedBounds(key) {
  const b = opts.getUi().popouts?.[key];
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const overlapW = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const overlapH = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  if (overlapW < 200 || overlapH < 100) return null;
  return { x: b.x, y: b.y, width: Math.max(320, b.width), height: Math.max(240, b.height) };
}

/** Only what the pop-out page needs, in known shapes (the spec comes from the renderer). */
function cleanSpec(s) {
  if (!s || typeof s.key !== 'string' || !s.key || s.key.length > 2000) return null;
  const out = { key: s.key, title: String(s.title || 'Polyopticon').slice(0, 300), area: ['story', 'chat', 'stream'].includes(s.area) ? s.area : 'story' };
  if (s.kind === 'irc') {
    const c = s.chat;
    if (!c || typeof c.spec !== 'string') return null;
    return { ...out, kind: 'irc', chat: { key: `pop:${String(c.key)}`, label: String(c.label || ''), spec: c.spec, host: String(c.host || ''), room: String(c.room || '') } };
  }
  if (typeof s.url !== 'string' || typeof s.partition !== 'string') return null;
  return { ...out, kind: 'web', url: s.url, partition: s.partition, site: String(s.site || ''),
           volume: Number.isFinite(s.volume) ? Math.max(0, Math.min(1, s.volume)) : 1, muted: !!s.muted };
}

function open(raw) {
  const spec = cleanSpec(raw);
  if (!spec) return false;
  const had = wins.get(spec.key);
  if (had && !had.win.isDestroyed()) { had.win.show(); had.win.focus(); return true; }

  const bounds = opts.offscreen ? { x: -30000, y: -30000, width: 900, height: 700 }
    : savedBounds(spec.key) ?? { width: spec.area === 'chat' ? 420 : 960, height: spec.area === 'stream' ? 580 : 720 };
  const win = new BrowserWindow({
    title: spec.title,
    minWidth: 320, minHeight: 240,
    ...bounds,
    show: false,
    skipTaskbar: !!opts.offscreen,
    icon: opts.icon,
    backgroundColor: opts.settings().IsDarkTheme ? '#0D0D0D' : '#F0F0F0',
    webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, spellcheck: false },
  });
  wins.set(spec.key, { win, spec });
  win.setMenu(null);
  win.once('ready-to-show', () => (opts.offscreen ? win.showInactive() : win.show()));
  // The pop-out page itself never navigates or spawns windows; its <webview> is locked down like the main window's.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { opts.openExternal(url); return { action: 'deny' }; });
  opts.guard(win.webContents);

  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || opts.offscreen) return;
    opts.updateUi({ popouts: { ...opts.getUi().popouts, [spec.key]: win.getNormalBounds() } });
  };
  for (const ev of ['resize', 'move']) win.on(ev, () => { clearTimeout(timer); timer = setTimeout(save, 400); });
  win.on('close', () => { clearTimeout(timer); save(); });
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));
  win.on('closed', () => {
    if (wins.get(spec.key)?.win !== win) return;            // closed by close(): nothing to report
    wins.delete(spec.key);
    if (!quitting) opts.notify(spec.key);                   // -> the main window puts the tab back
  });
  win.loadFile(opts.page);
  return true;
}

/** Close a window without the "put the tab back" message (its tab was closed or docked from the main window). */
function close(key) {
  const w = wins.get(key);
  if (!w) return;
  wins.delete(key);
  if (!w.win.isDestroyed()) w.win.close();
  // A closed tab's place needn't be kept.
  const { [key]: _gone, ...rest } = opts.getUi().popouts ?? {};
  opts.updateUi({ popouts: rest });
}

/** The app is quitting (or its main window closed): the windows go, but stay popped out for the next start. */
function closeAll() {
  quitting = true;
  for (const { win } of wins.values()) if (!win.isDestroyed()) win.close();
}

/** Tell every pop-out about a changed setting it follows (the theme). */
function broadcast(channel, ...args) {
  for (const { win } of wins.values()) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
}

const isPopout = contents => !!bySender(contents);

function init(o) {
  opts = o;
  ipcMain.handle('popout:open', (_e, spec) => open(spec));
  ipcMain.on('popout:close', (_e, key) => close(String(key)));
  ipcMain.on('popout:focus', (_e, key) => { const w = wins.get(String(key)); if (w && !w.win.isDestroyed()) { w.win.show(); w.win.focus(); } });
  // From a pop-out window itself:
  ipcMain.handle('popout:spec', e => {
    const w = bySender(e.sender);
    const s = opts.settings();
    return w ? { spec: w.spec, dark: !!s.IsDarkTheme, zoom: Number(s.WebViewZoom) || 1 } : null;
  });
  ipcMain.on('popout:dock', e => bySender(e.sender)?.win.close());
  ipcMain.on('popout:title', (e, title) => { const w = bySender(e.sender); if (w && typeof title === 'string') w.win.setTitle(title.slice(0, 300)); });
}

module.exports = { init, open, close, closeAll, broadcast, isPopout, setQuitting: () => { quitting = true; } };
