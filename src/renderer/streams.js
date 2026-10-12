// Live streams for the split under the chat: Twitch, Kick and YouTube, plus Direct — a link
// to a video file, played in Chromium's own video player. Pure helpers; the player itself
// is in chat.js.

const TWITCH = /^[a-z0-9_]{2,25}$/;
const KICK = /^[a-z0-9_-]{2,25}$/;
const YT_HANDLE = /^[A-Za-z0-9._-]{3,30}$/;
const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;

export const SITES = [
  { id: 'twitch',  label: 'Twitch',  hint: 'Twitch channel: name or link' },
  { id: 'kick',    label: 'Kick',    hint: 'Kick channel: name or link' },
  { id: 'youtube', label: 'YouTube', hint: 'YouTube channel: @handle or link' },
  { id: 'direct',  label: 'Direct',  hint: 'Video link: https://…/video.mp4' },
];

// The partition direct links play in (main/main.js gives it a memory-only session of its own).
export const DIRECT_PARTITION = 'direct-video';

const VIDEO_FILE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|opus|wav|flac)$/i;

/** A direct link as a full http(s) URL; null if it isn't one. */
function directUrl(text) {
  let t = String(text).trim();
  if (!/^https?:\/\//i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch { return null; }
}

const bare = text => String(text).trim().replace(/^https?:\/\//i, '').replace(/^(www\.|m\.|player\.)/i, '');

/** Which site a pasted link belongs to (null for a bare name). */
export function siteOfLink(text) {
  const t = bare(text).toLowerCase();
  if (t.startsWith('twitch.tv/')) return 'twitch';
  if (t.startsWith('kick.com/')) return 'kick';
  if (t.startsWith('youtube.com/') || t.startsWith('youtu.be/')) return 'youtube';
  try { if (VIDEO_FILE.test(new URL(directUrl(text)).pathname)) return 'direct'; } catch { /* not a link */ }
  return null;
}

/** "twitch.tv/XQC", "@xqc" → "xqc"; "kick.com/xqc", "player.kick.com/xqc"; "youtube.com/@name/live", "@name", "UC…" → the channel; null if it can't be one. */
export function parseStream(site, text) {
  if (site === 'direct') return directUrl(text);
  let c = bare(text);
  if (site === 'twitch') {
    c = c.toLowerCase().replace(/^twitch\.tv\//, '').replace(/^popout\//, '').replace(/^[@#]/, '').replace(/[/?#].*$/, '');
    return TWITCH.test(c) ? c : null;
  }
  if (site === 'kick') {
    c = c.toLowerCase().replace(/^kick\.com\//, '').replace(/^@/, '').replace(/[/?#].*$/, '');
    return KICK.test(c) ? c : null;
  }
  if (site === 'youtube') {
    c = c.replace(/^(youtube\.com|youtu\.be)\//i, '').replace(/^channel\//i, '').replace(/[/?#].*$/, '').replace(/^@/, '');
    if (YT_CHANNEL.test(c)) return c;
    return YT_HANDLE.test(c) ? c : null;
  }
  return null;
}

/** The page that plays this stream. */
export function streamUrl(site, name) {
  if (site === 'direct') return name;              // the file itself: Chromium shows it in its own player
  const n = encodeURIComponent(name);
  if (site === 'kick') return `https://player.kick.com/${n}`;
  if (site === 'youtube') return YT_CHANNEL.test(name) ? `https://www.youtube.com/channel/${n}/live` : `https://www.youtube.com/@${n}/live`;
  return `https://player.twitch.tv/?channel=${n}&parent=player.twitch.tv&autoplay=true&muted=false`;
}

/** "clip.mp4" for a direct link (else its host). */
function fileName(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '') || u.hostname;
  } catch { return url; }
}

export const streamLabel = (site, name) => `${SITES.find(s => s.id === site)?.label ?? site}: ${
  site === 'direct' ? fileName(name) : YT_CHANNEL.test(name) ? name : site === 'youtube' ? '@' + name : name}`;

/** The player area filling the pane: YouTube's watch page without its header, sidebar, comments and so on. */
export const YOUTUBE_CSS = `
  html, body { overflow: hidden !important; background: #000 !important; }
  #masthead-container, ytd-masthead, #secondary, #below, #related, #chat, ytd-live-chat-frame, #comments,
  tp-yt-app-drawer, #guide, ytd-mini-guide-renderer, ytd-consent-bump-v2-lightbox { display: none !important; }
  ytd-app { --ytd-masthead-height: 0px !important; }
  #page-manager { margin: 0 !important; }
  ytd-watch-flexy { --ytd-watch-flexy-masthead-height: 0px !important; }
  ytd-watch-flexy #columns, ytd-watch-flexy #primary, ytd-watch-flexy #primary-inner, ytd-watch-flexy #player,
  ytd-watch-flexy #player-container-outer, ytd-watch-flexy #player-container-inner, ytd-watch-flexy #player-container,
  ytd-watch-flexy #movie_player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }
  .html5-video-container, video.html5-main-video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; object-fit: contain; }
`;
