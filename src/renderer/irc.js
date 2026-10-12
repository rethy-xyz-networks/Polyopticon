// An IRC room in the chat column: a plain message list fed by the main process
// (main/irc.js makes the anonymous, read-only connection). One view per room;
// the backlog stays while the column is hidden.

import { api, h } from './dom.js';

const MAX_LINES = 500;
const views = new Map();           // chat key → view

/** What the user typed → canonical "ircs://host:port/#room" (null if it can't be one). */
export function parseIrcInput(server, room) {
  const m = /^(?:(ircs?):\/\/)?([a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(String(server).trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  const secure = m[1] ? m[1].toLowerCase() === 'ircs' : port !== 6667;      // 6667 is the classic plain-text port
  let channel = String(room).trim();
  if (!channel) return null;
  if (!/^[#&+!]/.test(channel)) channel = `#${channel}`;
  if (!/^[#&+!][^\s,\x00-\x1f\x07]{1,49}$/.test(channel)) return null;
  return `${secure ? 'ircs' : 'irc'}://${m[2].toLowerCase()}:${port ?? (secure ? 6697 : 6667)}/${channel}`;
}

/** "ircs://irc.libera.chat:6697/#linux" → { spec, host, room } for the chat list; null if it isn't one. */
export function parseIrcSpec(spec) {
  const m = /^ircs?:\/\/([a-z0-9.-]+)(?::\d+)?\/?([#&+!].+)$/i.exec(String(spec).trim());
  return m ? { spec: spec.trim(), host: m[1].toLowerCase(), room: m[2] } : null;
}

/** IRC formatting codes (bold, colour, reverse…) stripped. */
const plain = text => text.replace(/\x03\d{0,2}(?:,\d{1,2})?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '');

/** A stable colour per nick. */
function nickColor(nick) {
  let n = 0;
  for (const ch of nick) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${n % 360} 60% 55%)`;
}

const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** People coming and going, nick changes, kicks and topic changes: one dim line each. */
function eventLine(ev) {
  const who = n => h('span', { class: 'irc-nick', style: `color:${nickColor(n)}` }, n);
  const why = r => (r ? ` (${plain(r)})` : '');
  let mark = '→', body;
  switch (ev.kind) {
    case 'join': body = [who(ev.nick), ` joined${ev.host ? ` (${ev.host})` : ''}`]; break;
    case 'part': mark = '←'; body = [who(ev.nick), ` left${why(ev.reason)}`]; break;
    case 'quit': mark = '←'; body = [who(ev.nick), ` quit${why(ev.reason)}`]; break;
    case 'kick': mark = '✕'; body = [who(ev.target), ' was kicked by ', who(ev.nick), why(ev.reason)]; break;
    case 'nick': mark = '↔'; body = [who(ev.nick), ' is now known as ', who(ev.newNick)]; break;
    case 'topic': mark = '✎'; body = [who(ev.nick), ` changed the topic to: ${plain(ev.text)}`]; break;
    default: return h('div');
  }
  return h('div', { class: 'irc-line event' }, h('span', { class: 'irc-time' }, clock(ev.at)), h('span', { class: 'irc-mark' }, mark), ...body);
}

/** Creates the view for a chat tab and starts its connection. → { el, reload, destroy } */
export function createIrcView(chat) {
  const status = h('div', { class: 'irc-status' });
  const log = h('div', { class: 'irc-log' });
  const el = h('div', { class: 'irc-view' }, status, log);
  const v = { el, topic: '', users: null, state: 'connecting', text: '' };

  const paintStatus = () => {
    const parts = [v.text];
    if (v.state === 'joined' && v.users) parts.push(`${v.users} users`);
    status.replaceChildren(h('span', { class: `irc-state ${v.state}` }), h('span', { class: 'irc-status-text' }, parts.filter(Boolean).join(' · ')));
    if (v.topic) status.append(h('div', { class: 'irc-topic', title: v.topic }, plain(v.topic)));
  };

  const add = (...children) => {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(...children);
    while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  };

  v.onEvent = ev => {
    switch (ev.type) {
      case 'status':
        v.state = ev.state;
        v.text = ev.state === 'joined' ? chat.room : ev.text;
        add(h('div', { class: `irc-line sys${ev.state === 'joined' ? ' ok' : ''}` }, ev.text));      // connecting, connected, joined, errors…
        break;
      case 'event': add(eventLine(ev)); break;
      case 'topic': v.topic = ev.text; break;
      case 'users': v.users = ev.count; break;
      case 'message': case 'notice':
        add(h('div', { class: `irc-line${ev.action ? ' action' : ''}${ev.type === 'notice' ? ' notice' : ''}` },
          h('span', { class: 'irc-time' }, clock(ev.at)),
          ev.action ? h('span', { class: 'irc-nick', style: `color:${nickColor(ev.nick)}` }, `* ${ev.nick}`)
                    : h('span', { class: 'irc-nick', style: `color:${nickColor(ev.nick)}` }, ev.nick),
          h('span', { class: 'irc-text' }, plain(ev.text))));
        break;
    }
    paintStatus();
  };

  const connect = () => {
    v.state = 'connecting'; v.text = `Connecting to ${chat.host}…`; paintStatus();
    api.ircConnect(chat.key, chat.spec).then(r => { if (!r?.ok) v.onEvent({ type: 'status', state: 'error', text: r?.error || 'Could not connect' }); });
  };
  v.reload = () => { add(h('div', { class: 'irc-line sys' }, 'Reconnecting…')); connect(); };
  v.destroy = () => { views.delete(chat.key); api.ircDisconnect(chat.key); el.remove(); };

  views.set(chat.key, v);
  paintStatus();
  connect();
  return v;
}

/** Events from the main process, routed to the room they belong to. */
export function bindIrcEvents() {
  api.onIrcEvent(ev => views.get(ev.id)?.onEvent(ev));
}
