'use strict';

// Live chats (Twitch and Kick channels, destiny.gg) shown in the chat column, read-only
// as a guest. Each is the site's own chat page in a <webview> on its own
// session, kept apart from the article session (and its ad blocking).
//
// Twitch's /embed/ chat only works inside a registered website (`parent=`), so
// the popout chat page is used instead; destiny.gg and Kick (chat.kick.cx/embed/<channel>) have
// standalone embed pages.

const { session } = require('electron');
const { BROWSER_UA } = require('./adapters/util');

const CHAT_PARTITION = 'persist:chat';
const CHAT_HOSTS = ['twitch.tv', 'destiny.gg', 'kick.cx', 'kick.com', 'youtube.com'];   // kick.cx is Kick's chat embed; kick.com and youtube.com are stream players (chat.js in the renderer)

/** May a chat <webview> show this URL? */
function isChatUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CHAT_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
}

let chatSession = null;

function init() {
  chatSession = session.fromPartition(CHAT_PARTITION);
  // Some sites show "unsupported browser" pages to Electron's user agent.
  chatSession.setUserAgent(BROWSER_UA);
  // Chat pages may ask for notifications etc.; nothing beyond clipboard writes is granted.
  chatSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
}

const isChatContents = contents => !!chatSession && contents.session === chatSession;

/** Keep a chat on its chat site: links elsewhere (and all pop-ups) open in the system browser. */
function lockDown(contents, openExternal) {
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (e, url) => {
    if (isChatUrl(url)) return;
    e.preventDefault();
    openExternal(url);
  });
}

module.exports = { CHAT_PARTITION, init, isChatUrl, isChatContents, lockDown };
