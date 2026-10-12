'use strict';

// 4chan tabs (/pol/ and threads opened from it) in the story pane. They run on
// their own in-memory session: nothing from them is saved — no offline copies,
// no cookies or cache on disk. Middle-clicked links (and pop-ups) become new
// 4chan tabs in the app instead of opening in the system browser.

const { session } = require('electron');
const blocker = require('./blocker');
const { BROWSER_UA } = require('./adapters/util');

const CHAN_PARTITION = 'chan';                      // no "persist:" → memory only

let chanSession = null;

function init() {
  chanSession = session.fromPartition(CHAN_PARTITION);
  chanSession.setUserAgent(BROWSER_UA);
  chanSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  blocker.install(chanSession);
}

const isChanContents = contents => !!chanSession && contents.session === chanSession;

const ISOLATED_WORLD = 1001;
// The link under a point given in page pixels, if any.
const linkAt = (x, y) => `document.elementFromPoint(${x}, ${y})?.closest('a[href]')?.href ?? null`;

/**
 * Links opened as new windows/tabs (target=_blank, Ctrl+click) and middle-clicked
 * links go to `openTab`. Electron doesn't turn a middle-click in a <webview> into a
 * window request, so the link under the pointer is looked up on release.
 */
function lockDown(contents, isWebUrl, openTab) {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isWebUrl(url)) openTab(url, disposition === 'background-tab');
    return { action: 'deny' };
  });
  contents.on('before-mouse-event', (_e, m) => {
    if (m.type !== 'mouseUp' || m.button !== 'middle') return;
    const zoom = contents.getZoomFactor();
    contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: linkAt(m.x / zoom, m.y / zoom) }])
      .then(url => { if (isWebUrl(url)) openTab(url, true); })
      .catch(() => {});
  });
}

module.exports = { CHAN_PARTITION, init, isChanContents, lockDown };
