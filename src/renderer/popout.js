// The page inside a popped-out tab's window (main/popout.js): the tab's web page in a <webview> on
// the same session as in the main window (so logins carry over), or an IRC room's message list.
// A slim bar has Back / Forward / Reload, the title, full screen and "Return to main window";
// closing the window returns the tab too. The tab shortcuts that make sense here work, also from
// inside the page (main forwards them): Ctrl+R, Alt+Left / Right, Ctrl+W (return), F11, zoom.

import { api, $ } from './dom.js';
import { applyIcons } from './icons.js';
import { comboName } from './shortcuts.js';
import { YOUTUBE_CSS } from './streams.js';
import { createIrcView, bindIrcEvents } from './irc.js';

applyIcons();

const { spec, dark, zoom: startZoom } = await api.popoutSpec();
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
api.onPopoutTheme(isDark => { document.documentElement.dataset.theme = isDark ? 'dark' : 'light'; });

function setTitle(title) {
  $('pop-title').textContent = title;
  $('pop-title').title = title;
  document.title = title;
  api.popoutTitle(`${title} · Polyopticon`);
}
setTitle(spec.title);

let wv = null;                     // the page (kind 'web')
let ready = false;
let zoom = startZoom;
let reload = () => {};

if (spec.kind === 'irc') {
  bindIrcEvents();
  const view = createIrcView(spec.chat);
  $('pop-stage').append(view.el);
  reload = () => view.reload();
  $('pop-nav').hidden = true;
  $('pop-reload').title = 'Reconnect (Ctrl+R)';
} else {
  wv = document.createElement('webview');
  wv.setAttribute('partition', spec.partition);
  wv.setAttribute('src', spec.url);
  const paintNav = () => {
    if (!ready) return;
    $('pop-back').disabled = !wv.canGoBack();
    $('pop-forward').disabled = !wv.canGoForward();
  };
  const setVolume = () => {
    if (spec.area !== 'stream' || !ready) return;
    wv.executeJavaScript(`document.querySelectorAll('video').forEach(m => { m.volume = ${spec.volume}; })`).catch(() => {});
  };
  const trim = () => { if (spec.site === 'youtube') wv.insertCSS(YOUTUBE_CSS).catch(() => {}); };   // the watch page, trimmed to the video (streams.js)
  wv.addEventListener('dom-ready', () => {
    ready = true;
    if (spec.area !== 'chat') wv.setZoomFactor(zoom);          // chats keep their own size, as in the main window
    if (spec.area === 'stream') { wv.setAudioMuted(spec.muted); setVolume(); }
    trim();
    paintNav();
  });
  wv.addEventListener('did-navigate', paintNav);
  wv.addEventListener('did-navigate-in-page', () => { paintNav(); setVolume(); trim(); });
  // Articles and 4chan / Telegram pages show the page's own title; chats and streams keep the tab's name.
  if (spec.area === 'story') wv.addEventListener('page-title-updated', e => { if (e.title && !/^(https?|file|polyopticon-reader):/i.test(e.title)) setTitle(e.title); });
  wv.addEventListener('did-fail-load', e => {
    if (e.isMainFrame && e.errorCode !== -3) api.log('warn', `Pop-out: ${spec.title} failed to load: ${e.errorDescription} (${e.errorCode})`);
  });
  $('pop-stage').append(wv);
  reload = () => wv.reload();
  $('pop-nav').hidden = spec.area !== 'story';                 // chats and streams stay on their page
}

const go = dir => { if (!wv || !ready) return; if (dir < 0 && wv.canGoBack()) wv.goBack(); else if (dir > 0 && wv.canGoForward()) wv.goForward(); };
function zoomTo(z) {
  if (!wv || !ready || spec.area === 'chat') return;
  zoom = Math.min(2, Math.max(0.5, Math.round(z * 100) / 100));
  wv.setZoomFactor(zoom);
}

$('pop-back').addEventListener('click', () => go(-1));
$('pop-forward').addEventListener('click', () => go(1));
$('pop-reload').addEventListener('click', () => reload());
$('pop-dock').addEventListener('click', () => api.popoutDock());
$('pop-fullscreen').addEventListener('click', () => api.toggleFullScreen());
api.onFullScreen(on => {
  $('pop-fullscreen').classList.toggle('on', on);
  $('pop-fullscreen').title = on ? 'Leave full screen (F11)' : 'Full screen (F11)';
  document.body.classList.toggle('pop-fs', on);                // the bar goes away; F11 or Esc brings it back
});

// The shortcuts of the main window that apply to one page (same keys: shortcuts.js).
const KEYS = {
  'ctrl+r': () => reload(),
  'alt+arrowleft': () => go(-1),
  'alt+arrowright': () => go(1),
  'ctrl+w': () => api.popoutDock(),
  'f11': () => api.toggleFullScreen(),
  'ctrl+=': () => zoomTo(zoom + 0.1),
  'ctrl++': () => zoomTo(zoom + 0.1),
  'ctrl+-': () => zoomTo(zoom - 0.1),
  'ctrl+0': () => zoomTo(1),
};
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('pop-fs')) return api.toggleFullScreen();
  const run = KEYS[comboName(e)];
  if (run) { e.preventDefault(); run(); }
});
api.onShortcut(combo => KEYS[combo]?.());                      // pressed inside the page
api.onZoom(dir => zoomTo(zoom + (dir === 'in' ? 0.1 : -0.1)));   // Ctrl + wheel over the page
