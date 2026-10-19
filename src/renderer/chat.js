// Live chat column: one tab per configured chat (destiny.gg, Twitch channels, IRC rooms).
// destiny.gg and Twitch are the site's own page, read-only as a guest, in a <webview> on
// its own 'persist:chat' session (see main/chat.js); an IRC room is a plain message list
// fed by an anonymous connection (irc.js, main/irc.js). Chats stay connected while
// the column is hidden, so switching back keeps the backlog.

import { api, $, h, showMenu } from './dom.js';
import { icon, setIcon } from './icons.js';
import { state } from './state.js';
import { ui, saveUi } from './ui.js';
import { setSetting } from './settings.js';
import { makeReorderable } from './reorder.js';
import { tabEl, cycleIndex, moveIndex } from './tabstrip.js';
import { bindTabScroll } from './tabscroll.js';
import { SITES, parseStream, siteOfLink, streamUrl, streamLabel, YOUTUBE_CSS, DIRECT_PARTITION } from './streams.js';
import { createIrcView, bindIrcEvents, parseIrcInput, parseIrcSpec } from './irc.js';
import { attachHistory, remember } from './fieldhistory.js';

const PARTITION = 'persist:chat';
const DGG = {
  key: 'dgg', label: 'destiny.gg', kind: 'dgg',
  url: 'https://www.destiny.gg/embed/chat',
};

const views = new Map();          // chat key -> { wv, chat }
let open = false;
let onOpenSettings = () => {};

/** "twitch.tv/XQC", "@xqc", "#xqc" -> "xqc"; null if it can't be a channel name. */
function parseChannel(text) {
  const c = String(text).trim().toLowerCase()
    .replace(/^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//, '').replace(/^(popout\/)?/, '').replace(/^[@#]/, '').replace(/[/?].*$/, '');
  return /^[a-z0-9_]{2,25}$/.test(c) ? c : null;
}

/** "kick.com/XQC", "chat.kick.cx/embed/xqc", "@xqc" -> "xqc"; null if it can't be a Kick channel name. */
function parseKickChannel(text) {
  const c = String(text).trim().toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '').replace(/^chat\.kick\.cx\/embed\//, '').replace(/^(player\.)?kick\.com\//, '')
    .replace(/^[@#]/, '').replace(/[/?#].*$/, '');
  return /^[a-z0-9_-]{2,25}$/.test(c) ? c : null;
}

/** Kick channel names from the setting: "xqc, kick.com/destiny" -> ['xqc', 'destiny']. */
function kickChannels() {
  return [...new Set(String(state.settings.ChatKickChannels || '').split(/[\s,;]+/).map(parseKickChannel).filter(Boolean))];
}

/** Channel names from the setting: "destiny, twitch.tv/xqc" -> ['destiny', 'xqc']. */
function twitchChannels() {
  return [...new Set(String(state.settings.ChatTwitchChannels || '').split(/[\s,;]+/).map(parseChannel).filter(Boolean))];
}

/** IRC rooms from the setting: "ircs://irc.libera.chat:6697/#linux, …" -> [{ spec, host, room }]. */
function ircRooms() {
  const seen = new Set();
  return String(state.settings.ChatIrc || '').split(/[\s,;]+/).map(parseIrcSpec)
    .filter(r => r && !seen.has(r.spec) && seen.add(r.spec));
}

function chats() {
  const list = state.settings.ChatDestiny ? [DGG] : [];
  for (const ch of twitchChannels()) list.push({
    key: `tw:${ch}`, label: ch, kind: 'twitch',
    url: `https://www.twitch.tv/popout/${ch}/chat?popout=`,
  });
  for (const ch of kickChannels()) list.push({
    key: `kick:${ch}`, label: ch, kind: 'kick',
    url: `https://chat.kick.cx/embed/${encodeURIComponent(ch)}`,
  });
  for (const r of ircRooms()) list.push({ key: `irc:${r.spec}`, label: r.room, kind: 'irc', spec: r.spec, host: r.host, room: r.room });
  return arranged(list);
}

// Tab order and pinning
// Like the article tabs: drag to reorder, pinned tabs stay at the left (no ✕, middle-click
// ignored), right-click for pin / close others / close to the right. The order (ui.chatOrder)
// and the pinned keys (ui.chatPinned) are remembered; which chats exist is the settings' job.

/** The chats in their remembered order, pinned ones first; marks each with `pinned`. */
function arranged(list) {
  const pinned = new Set(ui.chatPinned ?? []);
  const rank = new Map((ui.chatOrder ?? []).map((k, i) => [k, i]));
  for (const c of list) c.pinned = pinned.has(c.key);
  return list.sort((a, b) => (b.pinned - a.pinned) || ((rank.get(a.key) ?? 1e6) - (rank.get(b.key) ?? 1e6)));   // stable: new chats keep their natural order, last
}

function setPinned(c, on) {
  if (c.pinned === on) return;
  const keys = chats().map(t => t.key).filter(k => k !== c.key);
  const pinnedKeys = (ui.chatPinned ?? []).filter(k => k !== c.key);
  // Pinning joins the end of the pinned group; unpinning goes first after the group.
  const at = chats().filter(t => t.pinned && t.key !== c.key).length;
  keys.splice(at, 0, c.key);
  if (on) pinnedKeys.push(c.key);
  saveUi({ chatPinned: pinnedKeys, chatOrder: keys });
  renderChat();
}

function removeChats(list) {
  if (list.some(c => c.kind === 'dgg')) setSetting('ChatDestiny', false);
  const gone = new Set(list.map(c => c.key));
  const tw = list.filter(c => c.kind === 'twitch');
  if (tw.length) setSetting('ChatTwitchChannels', twitchChannels().filter(ch => !gone.has(`tw:${ch}`)).join(', '));
  const kick = list.filter(c => c.kind === 'kick');
  if (kick.length) setSetting('ChatKickChannels', kickChannels().filter(ch => !gone.has(`kick:${ch}`)).join(', '));
  const irc = list.filter(c => c.kind === 'irc');
  if (irc.length) setSetting('ChatIrc', ircRooms().filter(r => !gone.has(`irc:${r.spec}`)).map(r => r.spec).join(', '));
  if (ui.chatPinned?.some(k => gone.has(k))) saveUi({ chatPinned: ui.chatPinned.filter(k => !gone.has(k)) });
}

function chatMenu(c, x, y) {
  const list = chats();
  const idx = list.findIndex(t => t.key === c.key);
  const others = list.filter(t => t.key !== c.key && !t.pinned);
  const right = list.slice(idx + 1).filter(t => !t.pinned);
  showMenu(x, y, [
    { label: c.pinned ? 'Unpin tab' : 'Pin tab', onClick: () => setPinned(c, !c.pinned) },
    'sep',
    { label: 'Close tab', onClick: () => removeChats([c]) },
    { label: 'Close other tabs', disabled: !others.length, onClick: () => removeChats(others) },
    { label: 'Close tabs to the right', disabled: !right.length, onClick: () => removeChats(right) },
  ]);
}

let reorder = null;

// Open / close

export function initChat({ openSettings }) {
  onOpenSettings = openSettings;
  $('btn-chat').addEventListener('click', toggleChat);
  // Many tabs: the wheel scrolls the strip sideways.
  bindTabScroll($('chat-tabs'), { always: true });
  $('chat-reload').addEventListener('click', reloadChat);
  bindIrcEvents();
  reorder = makeReorderable($('chat-tabs'), {
    selector: '.tab', ignore: '.close',
    onRebuilt: () => renderChat(),
    onDrop: keys => { saveUi({ chatOrder: keys }); renderChat(); },
  });
  $('chat-settings').addEventListener('click', e => { e.preventDefault(); onOpenSettings(); });

  // Adding chats from the panel itself. The plus shows a row of chat types; a type that needs
  // details (Twitch: a channel, IRC: a server and a room) shows its fields in a second row,
  // while destiny.gg needs none and simply switches on or off.
  $('chat-add-btn').addEventListener('click', () => {
    addBarOpen = !addBarOpen;
    if (!addBarOpen) addType = null;
    paintAddBar();
  });
  const pickType = (type, focusId) => {
    addType = addType === type ? null : type;
    paintAddBar();
    if (addType) $(focusId).focus();
  };
  $('chat-type-twitch').addEventListener('click', () => pickType('twitch', 'chat-add-input'));
  $('chat-type-kick').addEventListener('click', () => pickType('kick', 'chat-add-kick-input'));
  $('chat-type-irc').addEventListener('click', () => pickType('irc', 'chat-irc-server'));
  $('chat-type-dgg').addEventListener('click', () => {
    const on = !state.settings.ChatDestiny;
    if (on) showChat(DGG.key);
    setSetting('ChatDestiny', on);
  });

  $('chat-add-twitch').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('chat-add-input');
    const ch = parseChannel(input.value);
    input.classList.toggle('invalid', !ch);
    if (!ch) { input.title = 'Twitch channel names are 2–25 letters, numbers or underscores'; return; }
    remember('chat:twitch', ch);
    input.value = '';
    input.title = '';
    addBarOpen = false; addType = null;
    showChat(`tw:${ch}`);
    if (!twitchChannels().includes(ch)) setSetting('ChatTwitchChannels', [...twitchChannels(), ch].join(', '));
    else renderChat();
  });
  $('chat-add-input').addEventListener('input', e => e.target.classList.remove('invalid'));

  $('chat-add-kick').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('chat-add-kick-input');
    const ch = parseKickChannel(input.value);
    input.classList.toggle('invalid', !ch);
    if (!ch) { input.title = 'Kick channel names are 2–25 letters, numbers, - or _'; return; }
    remember('chat:kick', ch);
    input.value = '';
    input.title = '';
    addBarOpen = false; addType = null;
    showChat(`kick:${ch}`);
    if (!kickChannels().includes(ch)) setSetting('ChatKickChannels', [...kickChannels(), ch].join(', '));
    else renderChat();
  });
  $('chat-add-kick-input').addEventListener('input', e => e.target.classList.remove('invalid'));

  $('chat-add-irc').addEventListener('submit', e => {
    e.preventDefault();
    const server = $('chat-irc-server'), room = $('chat-irc-room');
    const spec = parseIrcInput(server.value, room.value);
    const serverOk = !!parseIrcInput(server.value, '#x');
    server.classList.toggle('invalid', !serverOk);
    room.classList.toggle('invalid', serverOk && !spec);
    if (!spec) return;
    remember('chat:irc-server', server.value);
    remember('chat:irc-room', room.value);
    server.value = room.value = '';
    addBarOpen = false; addType = null;
    showChat(`irc:${spec}`);
    if (!ircRooms().some(r => r.spec === spec)) setSetting('ChatIrc', [...ircRooms().map(r => r.spec), spec].join(', '));
    else renderChat();
  });
  for (const id of ['chat-irc-server', 'chat-irc-room']) $(id).addEventListener('input', e => e.target.classList.remove('invalid'));
  // Channels and rooms opened before, offered under each field.
  attachHistory($('chat-add-input'), { keyOf: () => 'chat:twitch' });
  attachHistory($('chat-add-kick-input'), { keyOf: () => 'chat:kick' });
  attachHistory($('chat-irc-server'), { keyOf: () => 'chat:irc-server', onPick: () => $('chat-irc-room').focus() });
  attachHistory($('chat-irc-room'), { keyOf: () => 'chat:irc-room' });
  initVideo();
  if (ui.chatOpen) openChat();
}

let addBarOpen = false;
let addType = null;                // which type's fields are showing: 'twitch' | 'irc' | null

// Streams below the chat
// The split button shows a player area under the chats (ui.videoOpen) for Twitch, Kick and
// YouTube channels. Like the chats they are tabs: ➕ adds one (a row of sites, then that
// site's field), drag to reorder, pin, right-click for close others / to the right, ✕ or
// middle-click to close. Every stream keeps playing in the background while you switch
// between tabs — only the tab shown has sound. The list is ui.streams = [{ site, name,
// pinned? }] and the tab shown is ui.streamTab. The players only exist while the area is
// visible, so a hidden column never keeps playing sound.

const streamViews = new Map();     // stream key -> { wv, ready, muted }
let addingStream = false;
let streamSite = null;             // which site's field is showing under the plus
let streamReorder = null;
let currentStream = null;

/** A stream's own volume (0–1) and mute. Streams saved before volumes were per stream start from the one global setting. */
const clamp01 = n => Math.max(0, Math.min(1, n));
const volumeOf = s => (Number.isFinite(s.volume) ? clamp01(s.volume) : Number.isFinite(ui.videoVolume) ? clamp01(ui.videoVolume) : 1);
const mutedOf = s => (s.muted ?? !!ui.videoMuted);
const silent = s => mutedOf(s) || volumeOf(s) === 0;
const currentStreamObj = () => streams().find(s => streamKey(s) === currentStream) ?? null;
const streamKey = s => `${s.site}:${s.name}`;
const validStream = v => v && SITES.some(s => s.id === v.site) && typeof v.name === 'string' && parseStream(v.site, v.name) === v.name;

/** The streams in their saved order, pinned first. Reads the older single ui.video / ui.videoChannel too. */
function streams() {
  const saved = Array.isArray(ui.streams) ? ui.streams
    : [ui.video ?? (ui.videoChannel ? { site: 'twitch', name: ui.videoChannel } : null)].filter(Boolean);
  const seen = new Set();
  const list = saved.filter(v => validStream(v) && !seen.has(streamKey(v)) && seen.add(streamKey(v)))
    .map(v => ({ site: v.site, name: v.name, pinned: !!v.pinned, volume: v.volume, muted: v.muted }));
  return list.sort((a, b) => b.pinned - a.pinned);              // stable
}

/** Save the list (pinned first) and drop the older single-stream settings. */
function saveStreams(list, patch = {}) {
  saveUi({
    streams: list.map(({ site, name, pinned, volume, muted }) => ({
      site, name, ...(pinned && { pinned }), ...(Number.isFinite(volume) && { volume }), ...(typeof muted === 'boolean' && { muted }),
    })),
    video: undefined, videoChannel: undefined, videoVolume: undefined, videoMuted: undefined, ...patch,
  });
}

/** Change one stream's volume or mute (and nothing else). */
function updateStream(key, patch) {
  // Writing the list pins down every stream's current volume, so the old global setting can go.
  saveStreams(streams().map(s => ({ ...s, volume: volumeOf(s), muted: mutedOf(s), ...(streamKey(s) === key ? patch : {}) })));
  paintVolume();
  applyVolumes();
  paintVideo();
}

/** The Video Player View (stream button, Ctrl+V): with the chat hidden, opens it with the streams split on; otherwise toggles the split. */
export function toggleVideo() {
  const wasOpen = open;
  saveUi({ videoOpen: wasOpen ? !ui.videoOpen : true });
  if (!wasOpen) openChat(); else paintVideo();
  if (ui.videoOpen && !streams().length) openStreamAdd();
}

function initVideo() {
  $('chat-video-btn').addEventListener('click', toggleVideo);
  $('video-add-btn').addEventListener('click', () => { if (addingStream) { addingStream = false; streamSite = null; paintStreamAdd(); } else openStreamAdd(); });
  // The volume bar and mute button belong to the stream whose tab is shown; every stream keeps its own.
  $('video-volume').addEventListener('input', e => {
    if (currentStream) updateStream(currentStream, { volume: e.target.value / 100, muted: false });
  });
  $('video-mute').addEventListener('click', () => {
    const s = currentStreamObj();
    if (s) toggleMute(s);
  });
  paintVolume();
  // Players rebuild their <video> now and then (ads, reconnects); keep the chosen volume on them.
  setInterval(applyVolumes, 3000);
  $('video-reload').addEventListener('click', () => streamViews.get(currentStream)?.wv.reload());
  bindTabScroll($('video-tabs'), { always: true });
  streamReorder = makeReorderable($('video-tabs'), {
    selector: '.tab', ignore: '.close, .snd',
    onRebuilt: () => paintVideo(),
    onDrop: keys => {
      const byKey = new Map(streams().map(s => [streamKey(s), s]));
      saveStreams(keys.map(k => byKey.get(k)).filter(Boolean));
      paintVideo();
    },
  });
  for (const b of document.querySelectorAll('#video-add [data-site]')) b.addEventListener('click', () => {
    streamSite = streamSite === b.dataset.site ? null : b.dataset.site;
    paintStreamAdd();
    if (streamSite) $('video-channel').focus();
  });
  $('video-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('video-channel');
    // A pasted link says which site it is for.
    const kind = siteOfLink(input.value) ?? streamSite;
    const name = parseStream(kind, input.value);
    input.classList.toggle('invalid', !name);
    if (!name) {
      input.title = kind === 'youtube' ? 'A YouTube @handle, channel ID or link'
                  : kind === 'direct' ? 'A link to a video file, e.g. https://example.com/clip.mp4'
                  : 'A channel name (letters, numbers, - and _) or link';
      return;
    }
    remember(`video:${kind}`, name);
    input.title = '';
    input.value = '';
    input.blur();
    addingStream = false; streamSite = null;
    const list = streams();
    const stream = { site: kind, name };
    if (!list.some(s => streamKey(s) === streamKey(stream))) list.push(stream);   // already open: just switch to it
    saveStreams(list, { streamTab: streamKey(stream) });
    paintVideo();
  });
  $('video-channel').addEventListener('input', e => e.target.classList.remove('invalid'));
  // Channels watched before on the chosen site; for Twitch, also the Twitch chats you follow here.
  attachHistory($('video-channel'), {
    keyOf: () => `video:${streamSite}`,
    suggestions: () => (streamSite === 'twitch' ? twitchChannels() : []),
  });
  bindVideoSplitter();
  if (Number.isFinite(ui.videoHeight)) $('chat-pane').style.setProperty('--h-video', `${ui.videoHeight}px`);
}

function openStreamAdd() {
  addingStream = true;
  streamSite = null;
  paintStreamAdd();
}

function paintStreamAdd() {
  $('video-add').hidden = !addingStream;
  $('video-add-btn').classList.toggle('on', addingStream);
  for (const b of document.querySelectorAll('#video-add [data-site]')) b.classList.toggle('on', b.dataset.site === streamSite);
  $('video-form').hidden = !streamSite;
  const site = SITES.find(x => x.id === streamSite);
  if (site) $('video-channel').placeholder = site.hint;
}

/** Silent either way (muted or at 0): the button turns the sound back on. */
function toggleMute(s) {
  const off = mutedOf(s) || volumeOf(s) === 0;
  updateStream(streamKey(s), off ? { muted: false, ...(volumeOf(s) === 0 ? { volume: 0.5 } : {}) } : { muted: true });
}

function setStreamPinned(s, on) {
  if (s.pinned === on) return;
  const rest = streams().filter(t => streamKey(t) !== streamKey(s));
  const at = rest.filter(t => t.pinned).length;           // pinning joins the end of the pinned group; unpinning goes first after it
  rest.splice(at, 0, { ...s, pinned: on });
  saveStreams(rest);
  paintVideo();
}

function removeStreams(gone) {
  const keys = new Set(gone.map(streamKey));
  saveStreams(streams().filter(s => !keys.has(streamKey(s))));
  paintVideo();
}

function streamMenu(s, x, y) {
  const list = streams();
  const idx = list.findIndex(t => streamKey(t) === streamKey(s));
  const others = list.filter(t => streamKey(t) !== streamKey(s) && !t.pinned);
  const right = list.slice(idx + 1).filter(t => !t.pinned);
  showMenu(x, y, [
    { label: s.pinned ? 'Unpin tab' : 'Pin tab', onClick: () => setStreamPinned(s, !s.pinned) },
    'sep',
    { label: 'Close tab', onClick: () => removeStreams([s]) },
    { label: 'Close other tabs', disabled: !others.length, onClick: () => removeStreams(others) },
    { label: 'Close tabs to the right', disabled: !right.length, onClick: () => removeStreams(right) },
  ]);
}

function paintVideo() {
  const show = open && !!ui.videoOpen;
  $('chat-video-btn').classList.toggle('on', show);
  $('video-pane').hidden = $('video-splitter').hidden = !show;
  const list = streams();
  const keys = new Set(list.map(streamKey));
  addingStream = addingStream && show;
  paintStreamAdd();

  currentStream = keys.has(ui.streamTab) ? ui.streamTab : list[0] ? streamKey(list[0]) : null;
  $('video-empty').hidden = list.length > 0;
  $('video-reload').disabled = !list.length;
  paintVolume();
  if (!streamReorder?.dragging) $('video-tabs').replaceChildren(...list.map(s => {
    const key = streamKey(s);
    const label = streamLabel(s.site, s.name);
    const where = s.site === 'direct' ? s.name : label;           // a direct link's tab shows the file name; the tooltip the whole link
    return tabEl({
      id: key, kind: s.site, label, title: where,
      active: key === currentStream, pinned: s.pinned,
      lead: [h('span', { class: 'dot' })],
      trail: [h('span', { class: `snd${silent(s) ? ' off' : ''}${mutedOf(s) ? ' on' : ''}`, title: silent(s) ? 'Silent: click for sound' : 'Click to mute this stream',
        onclick: e => { e.stopPropagation(); toggleMute(s); } }, icon(silent(s) ? 'muted' : 'volume-2'))],
      closeTitle: `Close ${label}`,
      onSelect: () => { saveUi({ streamTab: key }); paintVideo(); },
      onClose: () => removeStreams([s]),
      onMenu: (x, y) => streamMenu(s, x, y),
    });
  }));

  // Hidden area, or a stream that was closed: its player goes away (which stops playback).
  for (const [key, v] of streamViews) if (!show || !keys.has(key)) { v.wv.remove(); streamViews.delete(key); }
  if (!show) return;
  document.querySelector('#video-tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Every stream gets a player and they all play at once, each at its own volume. The one shown is
  // on top; the others stay behind it (never hidden, which would let the sites pause them).
  for (const s of list) {
    const key = streamKey(s);
    if (!streamViews.has(key)) createStreamView(s, key);
    const v = streamViews.get(key);
    v.wv.classList.toggle('inactive', key !== currentStream);
    muteStream(v, mutedOf(s));
  }
}

function muteStream(v, muted) {
  v.muted = muted;
  if (!v.ready) return;                          // applied at dom-ready
  try { v.wv.setAudioMuted(muted); } catch { /* view detached */ }
}

/** The mute button and the slider show the volume of the stream whose tab is shown. */
function paintVolume() {
  const s = currentStreamObj();
  const vol = s ? volumeOf(s) : 1, muted = !!s && mutedOf(s), off = muted || vol === 0;
  $('video-volume').disabled = $('video-mute').disabled = !s;
  $('video-volume').value = Math.round(vol * 100);
  setIcon($('video-mute'), off ? 'muted' : vol < 0.34 ? 'volume-0' : vol < 0.67 ? 'volume-1' : 'volume-2');
  $('video-mute').classList.toggle('on', muted);
  $('video-volume').title = s ? `${streamLabel(s.site, s.name)}: volume ${Math.round(vol * 100)}%` : 'Volume';
}

/** Set the volume on the players' own <video> elements (webviews have no volume setting of their own). */
function applyVolumes() {
  const byKey = new Map(streams().map(s => [streamKey(s), s]));
  for (const [key, v] of streamViews) {
    const s = byKey.get(key);
    if (!v.ready || !s) continue;
    try { v.wv.executeJavaScript(`document.querySelectorAll('video').forEach(m => { m.volume = ${volumeOf(s)}; })`).catch(() => {}); } catch { /* view detached */ }
  }
}

function createStreamView(s, key) {
  const wv = document.createElement('webview');
  // A direct link can be on any site, so it gets a session of its own rather than the chat sites' one.
  wv.setAttribute('partition', s.site === 'direct' ? DIRECT_PARTITION : PARTITION);
  wv.setAttribute('src', streamUrl(s.site, s.name));
  const v = { wv, ready: false, muted: mutedOf(s) };
  wv.addEventListener('dom-ready', () => { v.ready = true; muteStream(v, v.muted); applyVolumes(); });
  wv.addEventListener('did-navigate-in-page', applyVolumes);
  wv.addEventListener('did-fail-load', e => {
    if (e.isMainFrame && e.errorCode !== -3) api.log('warn', `Stream: ${s.site} ${s.name} failed to load: ${e.errorDescription} (${e.errorCode})`);
  });
  if (s.site === 'youtube') {
    // YouTube has no bare player for a channel's live stream: it's the watch page, trimmed to the video.
    const trim = () => wv.insertCSS(YOUTUBE_CSS).catch(() => {});
    wv.addEventListener('dom-ready', trim);
    wv.addEventListener('did-navigate-in-page', trim);
  }
  streamViews.set(key, v);
  $('video-view').append(wv);
  api.log('info', `Stream: watching ${s.site} ${s.name}`);
}

/** Drag the bar between chat and stream; the stream's height is remembered. */
function bindVideoSplitter() {
  const sp = $('video-splitter');
  sp.addEventListener('pointerdown', e => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('dragging');
    document.body.classList.add('resizing-rows');
    const pane = $('chat-pane');
    const move = ev => {
      const r = pane.getBoundingClientRect();
      const h = Math.round(Math.max(120, Math.min(r.height - 160, r.bottom - ev.clientY)));
      pane.style.setProperty('--h-video', `${h}px`);
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing-rows');
      saveUi({ videoHeight: Math.round($('video-pane').getBoundingClientRect().height) });
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up, { once: true });
  });

  // The corner where the two bars cross resizes both at once: width and stream height.
  const grip = sp.querySelector('.corner-grip');
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-corner');
    const root = document.documentElement, pane = $('chat-pane');
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    const maxW = startW + document.querySelector('.pane.story').getBoundingClientRect().width - 260;
    const move = ev => {
      const w = Math.round(Math.max(240, Math.min(maxW, startW + startX - ev.clientX)));
      root.style.setProperty('--w-chat', `${w}px`);
      const r = pane.getBoundingClientRect();
      const h = Math.round(Math.max(120, Math.min(r.height - 160, r.bottom - ev.clientY)));
      pane.style.setProperty('--h-video', `${h}px`);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing-corner');
      saveUi({
        videoHeight: Math.round($('video-pane').getBoundingClientRect().height),
        panes: { ...ui.panes, '--w-chat': parseInt(getComputedStyle(root).getPropertyValue('--w-chat'), 10) },
      });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
  });
}

/** Make a chat the active tab (and open the column). */
function showChat(key) {
  saveUi({ chatTab: key });
  if (!open) openChat();
}

/** Close a tab: a Twitch channel or IRC room leaves the list; destiny.gg is switched off. */
function removeChat(c) { removeChats([c]); }

function reloadChat() {
  const v = activeView();
  if (!v) return;
  if (v.reload) return v.reload();
  v.ready = false;
  v.wv.loadURL(v.chat.url);
}

// Keyboard
// The tab shortcuts (Ctrl+PgUp/PgDown, Alt+1…9, Ctrl+W, Ctrl+R) act on the chat or stream
// tabs while that area has focus; app.js decides which area that is.

export const chatOpen = () => open;

/** The chat tabs ('chat') or the stream tabs ('stream'), in a common shape. */
function strip(area) {
  if (area === 'stream') {
    const list = streams();
    return { list, keys: list.map(streamKey), current: currentStream,
             select: key => { saveUi({ streamTab: key }); paintVideo(); },
             close: s => removeStreams([s]), pin: setStreamPinned,
             reorder: order => { const by = new Map(list.map(s => [streamKey(s), s])); saveStreams(order.map(k => by.get(k))); paintVideo(); },
             reload: () => streamViews.get(currentStream)?.wv.reload() };
  }
  const list = chats();
  return { list, keys: list.map(c => c.key), current,
           select: key => { saveUi({ chatTab: key }); renderChat(); },
           close: removeChat, pin: setPinned, reload: reloadChat,
           reorder: order => { saveUi({ chatOrder: order }); renderChat(); } };
}

/** Ctrl+PgDown / Ctrl+PgUp: the next or previous tab, pinned ones included, wrapping around. */
export function cycleChatTab(area, step) {
  const { keys, current: cur, select } = strip(area);
  const k = cycleIndex(keys.length, keys.indexOf(cur), step);
  if (k >= 0) select(keys[k]);
}

/** Ctrl+Shift+PgDown / PgUp: move the shown tab one place right or left, within its pinned or unpinned group. */
export function moveChatTab(area, step) {
  const { list, keys, current: cur, reorder } = strip(area);
  const i = keys.indexOf(cur);
  const j = moveIndex(list, i, step);
  if (j < 0) return;
  const order = [...keys];
  [order[i], order[j]] = [order[j], order[i]];
  reorder(order);
  document.querySelector(`${area === 'stream' ? '#video-tabs' : '#chat-tabs'} .tab.active`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Alt+1…9: the Nth tab after the pinned ones. */
export function selectChatTab(area, n) {
  const { list, keys, select } = strip(area);
  const i = list.map((t, j) => j).filter(j => !list[j].pinned)[n - 1];
  if (i !== undefined) select(keys[i]);
}

/** Ctrl+W: close the shown tab (pinned tabs stay open). */
export function closeChatTab(area) {
  const { list, keys, current: cur, close } = strip(area);
  const t = list[keys.indexOf(cur)];
  if (t && !t.pinned) close(t);
}

export const reloadChatTab = area => strip(area).reload();

/** The chat or stream tabs for tab search (Ctrl+Shift+A): the current one, then the strip's order. */
export function chatTabList(area) {
  const { list, keys, current: cur, select, close } = strip(area);
  const entries = list.map((t, i) => {
    const label = area === 'stream' ? (t.site === 'direct' ? t.name : streamLabel(t.site, t.name)) : t.label;
    const detail = area === 'stream' ? (t.site === 'direct' ? 'Video link' : SITES.find(s => s.id === t.site)?.label ?? t.site)
      : t.kind === 'twitch' ? `twitch.tv/${t.label}` : t.kind === 'kick' ? `kick.com/${t.label}` : t.kind === 'irc' ? `${t.room} on ${t.host}` : 'destiny.gg chat';
    return { key: keys[i], label, detail, pinned: t.pinned, active: keys[i] === cur, item: t };
  });
  entries.sort((a, b) => b.active - a.active);       // stable
  return {
    entries: entries.map(({ item, ...e }) => e),
    select,
    close: key => { const e = entries.find(x => x.key === key); if (e && !e.pinned) close(e.item); },
  };
}

/** Ctrl+P: pin the shown tab, or unpin it if it already is. */
export function pinChatTab(area) {
  const { list, keys, current: cur, pin } = strip(area);
  const t = list[keys.indexOf(cur)];
  if (t) pin(t, !t.pinned);
}

function paintAddBar() {
  const none = chats().length === 0;
  $('chat-add').hidden = !(addBarOpen || none);
  $('chat-add-btn').classList.toggle('on', addBarOpen);
  $('chat-type-twitch').classList.toggle('on', addType === 'twitch');
  $('chat-type-kick').classList.toggle('on', addType === 'kick');
  $('chat-type-irc').classList.toggle('on', addType === 'irc');
  $('chat-type-dgg').classList.toggle('on', !!state.settings.ChatDestiny);
  $('chat-type-dgg').textContent = state.settings.ChatDestiny ? 'destiny.gg ✓' : 'destiny.gg';
  $('chat-add-twitch').hidden = addType !== 'twitch';
  $('chat-add-kick').hidden = addType !== 'kick';
  $('chat-add-irc').hidden = addType !== 'irc';
}

export function toggleChat() { if (open) closeChat(); else openChat(); }

function openChat() {
  open = true;
  saveUi({ chatOpen: true });
  $('panes').classList.add('chat-open');
  $('btn-chat').classList.add('on');
  renderChat();
  paintVideo();
}

function closeChat() {
  open = false;
  saveUi({ chatOpen: false });
  $('panes').classList.remove('chat-open');
  $('btn-chat').classList.remove('on');
  paintVideo();                                // the stream stops while the column is hidden
}

// Rendering

// The tab shown: the chosen one (ui.chatTab, kept even while its chat is being
// added), else the first.
let current = null;
const activeView = () => views.get(current) ?? null;

/** Re-sync tabs and views with the settings (also called when they change). */
export function renderChat() {
  paintVideo();                              // channel suggestions follow the chat list
  const list = chats();
  const keys = new Set(list.map(c => c.key));

  // Chats removed in settings: drop their pages.
  for (const [key, v] of views) if (!keys.has(key)) { if (v.destroy) v.destroy(); else v.wv.remove(); views.delete(key); }

  current = keys.has(ui.chatTab) ? ui.chatTab : list[0]?.key ?? null;
  if (!reorder?.dragging) $('chat-tabs').replaceChildren(...list.map(c => {
    const where = c.kind === 'twitch' ? `twitch.tv/${c.label}` : c.kind === 'kick' ? `kick.com/${c.label}` : c.kind === 'irc' ? `${c.room} on ${c.host}` : 'destiny.gg chat';
    return tabEl({
      id: c.key, kind: c.kind, label: c.label, title: where,
      active: c.key === current, pinned: c.pinned,
      lead: [h('span', { class: 'dot' })],
      closeTitle: c.kind === 'dgg' ? 'Hide destiny.gg chat' : c.kind === 'irc' ? `Leave ${c.label}` : `Remove ${c.label}`,
      onSelect: () => { saveUi({ chatTab: c.key }); renderChat(); },
      onClose: () => removeChat(c),
      onMenu: (x, y) => chatMenu(c, x, y),
    });
  }));

  $('chat-empty').hidden = list.length > 0;
  paintAddBar();
  $('chat-reload').disabled = !list.length;                  // stays in place, right of ➕, so the buttons don't shift
  if (!open || !current) return;

  // Every chat gets its page as soon as the column is open (so at startup), not when its tab is first picked.
  document.querySelector('#chat-tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  for (const chat of list) if (!views.has(chat.key)) createView(chat);
  for (const [key, v] of views) v.wv.classList.toggle('inactive', key !== current);
}

function createView(chat) {
  if (chat.kind === 'irc') {
    const iv = createIrcView(chat);
    views.set(chat.key, { wv: iv.el, chat, ready: true, reload: iv.reload, destroy: iv.destroy });
    $('chat-views').append(iv.el);
    return;
  }
  const wv = document.createElement('webview');
  wv.setAttribute('partition', PARTITION);
  wv.setAttribute('src', chat.url);
  const v = { wv, chat, ready: false };
  wv.addEventListener('dom-ready', () => { v.ready = true; if (chat.kind === 'twitch') applyTwitchTheme(v); });
  wv.addEventListener('did-fail-load', e => {
    if (e.isMainFrame && e.errorCode !== -3) api.log('warn', `Chat: ${chat.label} failed to load: ${e.errorDescription} (${e.errorCode})`);
  });
  views.set(chat.key, v);
  $('chat-views').append(wv);
}

/** Twitch keeps its light/dark choice in localStorage; match the app's theme. */
// A page that hasn't loaded yet gets it from its own dom-ready handler —
// executeJavaScript throws (synchronously) before that.
function applyTwitchTheme(v) {
  if (!v.ready) return;
  const want = state.settings.IsDarkTheme ? '1' : '0';
  try {
    v.wv.executeJavaScript(`(() => {
      if (!location.pathname.includes('/chat')) return;
      if (localStorage.getItem('twilight.theme') !== '${want}') { localStorage.setItem('twilight.theme', '${want}'); location.reload(); }
    })()`).catch(() => { /* page navigated away */ });
  } catch { /* view detached */ }
}

/** Theme switched: Twitch chats follow it. */
export function applyChatTheme() {
  for (const v of views.values()) if (v.chat.kind === 'twitch') applyTwitchTheme(v);
}
