'use strict';

// Anonymous, read-only IRC connections for the chat column. No login, no password:
// a random guest nick registers, joins one room and passes what it hears to the UI.
// Each connection is one server + one room; it reconnects by itself unless closed.

const net = require('net');
const tls = require('tls');

const MAX_LINE = 8192;
const REGISTER_TIMEOUT_MS = 30_000;      // no welcome from the server by then → try again
const IDLE_TIMEOUT_MS = 6 * 60_000;      // servers PING every few minutes; silence this long means a dead link
const RECONNECT_MS = [3_000, 10_000, 30_000, 60_000];

const conns = new Map();                 // id → Conn

/** "ircs://host:6697/#room" → { host, port, secure, channel } (null if it isn't one). */
function parseSpec(text) {
  const m = /^(ircs?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?\/?([#&+!][^\s,\x00-\x1f\x07]{1,49})$/i.exec(String(text).trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : (m[1].toLowerCase() === 'ircs' ? 6697 : 6667);
  if (port < 1 || port > 65535) return null;
  return { host: m[2].toLowerCase(), port, secure: m[1].toLowerCase() === 'ircs', channel: m[4] };
}

const guestNick = () => `Guest${Math.floor(10000 + Math.random() * 90000)}`;

/** ":nick!user@host PRIVMSG #room :hello" → { prefix, nick, cmd, params[] } */
function parseLine(line) {
  let rest = line;
  if (rest.startsWith('@')) rest = rest.slice(rest.indexOf(' ') + 1);            // IRCv3 message tags: not needed
  let prefix = '';
  if (rest.startsWith(':')) { const i = rest.indexOf(' '); prefix = rest.slice(1, i); rest = rest.slice(i + 1); }
  const params = [];
  while (rest) {
    if (rest.startsWith(':')) { params.push(rest.slice(1)); break; }
    const i = rest.indexOf(' ');
    if (i < 0) { params.push(rest); break; }
    params.push(rest.slice(0, i));
    rest = rest.slice(i + 1).replace(/^ +/, '');
  }
  const cmd = (params.shift() || '').toUpperCase();
  return { prefix, nick: prefix.split('!')[0], cmd, params };
}

class Conn {
  constructor(id, spec, emit) {
    Object.assign(this, { id, spec, emit });
    this.closed = false;
    this.attempt = 0;
    this.socket = null;
    this.timer = null;
    this.nick = guestNick();
    this.registered = false;
    this.users = new Map();            // lower-case nick → nick as shown, for who is in the room
  }

  status(state, text) { this.emit({ id: this.id, type: 'status', state, text }); }

  connect() {
    if (this.closed) return;
    const { host, port, secure } = this.spec;
    this.registered = false;
    this.users.clear();
    this.buffer = '';
    this.status('connecting', `Connecting to ${host}:${port}…`);
    const socket = this.socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      this.send(`NICK ${this.nick}`);
      this.send('USER polyopticon 0 * :Polyopticon (read-only guest)');
      clearTimeout(this.registerTimer);
      this.registerTimer = setTimeout(() => this.drop('No welcome from the server'), REGISTER_TIMEOUT_MS);
    });
    socket.on('data', chunk => this.onData(chunk));
    socket.on('timeout', () => this.drop('Connection went quiet'));
    socket.on('error', e => this.drop(e.code === 'ENOTFOUND' ? `Server not found: ${host}` : e.message));
    socket.on('close', () => this.drop('Disconnected'));
  }

  /** Tell the UI who is in the room now. */
  usersChanged() { this.emit({ id: this.id, type: 'users', count: this.users.size }); }

  /** A room event for the message list ('join', 'part', 'quit', 'kick', 'nick', 'topic'). */
  event(type, fields) { this.emit({ id: this.id, type: 'event', kind: type, at: Date.now(), ...fields }); }

  send(line) { try { this.socket?.write(`${line}\r\n`); } catch { /* socket gone; close handler follows */ } }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE * 8) this.buffer = '';                      // not IRC; don't grow without bound
    let i;
    while ((i = this.buffer.search(/\r?\n/)) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i).replace(/^\r?\n/, '');
      if (line) this.onLine(line.slice(0, MAX_LINE));
    }
  }

  onLine(line) {
    const m = parseLine(line);
    const { channel } = this.spec;
    const mine = target => target && target.toLowerCase() === channel.toLowerCase();
    switch (m.cmd) {
      case 'PING': return this.send(`PONG :${m.params[0] ?? ''}`);
      case '001':
        this.registered = true;
        this.attempt = 0;
        clearTimeout(this.registerTimer);
        this.status('joining', `Connected — joining ${channel}…`);
        return this.send(`JOIN ${channel}`);
      case '432': case '433': case '436':                                         // nick unusable: pick another
        this.nick = guestNick();
        return this.send(`NICK ${this.nick}`);
      case 'JOIN': {
        if (!mine(m.params[0])) return;
        if (m.nick.toLowerCase() === this.nick.toLowerCase()) { this.status('joined', `Joined ${channel}`); return; }
        this.users.set(m.nick.toLowerCase(), m.nick);
        this.event('join', { nick: m.nick, host: m.prefix.split('!')[1] ?? '' });
        return this.usersChanged();
      }
      case 'PART': {
        if (!mine(m.params[0]) || m.nick.toLowerCase() === this.nick.toLowerCase()) return;
        this.users.delete(m.nick.toLowerCase());
        this.event('part', { nick: m.nick, reason: m.params[1] ?? '' });
        return this.usersChanged();
      }
      case 'QUIT': {                                                              // not tied to a room: only people we saw here
        if (!this.users.delete(m.nick.toLowerCase())) return;
        this.event('quit', { nick: m.nick, reason: m.params[0] ?? '' });
        return this.usersChanged();
      }
      case 'NICK': {
        const old = m.nick.toLowerCase();
        if (old === this.nick.toLowerCase()) { this.nick = m.params[0]; return; }
        if (!this.users.delete(old)) return;
        this.users.set(m.params[0].toLowerCase(), m.params[0]);
        return this.event('nick', { nick: m.nick, newNick: m.params[0] });
      }
      case '332': if (mine(m.params[1])) this.emit({ id: this.id, type: 'topic', text: m.params[2] ?? '' }); return;
      case '353':
        if (mine(m.params[2])) for (const n of (m.params[3] ?? '').split(' ').filter(Boolean)) {
          const nick = n.replace(/^[@+%&~!]+/, '');
          if (nick) this.users.set(nick.toLowerCase(), nick);
        }
        return;
      case '366': if (mine(m.params[1])) this.usersChanged(); return;
      case 'TOPIC':
        if (!mine(m.params[0])) return;
        this.emit({ id: this.id, type: 'topic', text: m.params[1] ?? '' });
        return this.event('topic', { nick: m.nick, text: m.params[1] ?? '' });
      case 'PRIVMSG': case 'NOTICE': {
        if (!mine(m.params[0])) return;                                           // private messages aren't ours to show
        const text = m.params[1] ?? '';
        const action = /^\x01ACTION (.*?)\x01?$/.exec(text);
        if (!action && text.startsWith('\x01')) return;                           // CTCP requests: ignored, never answered
        return this.emit({ id: this.id, type: m.cmd === 'NOTICE' ? 'notice' : 'message', nick: m.nick, text: action ? action[1] : text, action: !!action, at: Date.now() });
      }
      case 'KICK': {
        if (!mine(m.params[0])) return;
        if (m.params[1].toLowerCase() === this.nick.toLowerCase()) return this.status('error', `Kicked from ${channel}: ${m.params[2] ?? ''}`.trim());
        this.users.delete(m.params[1].toLowerCase());
        this.event('kick', { nick: m.nick, target: m.params[1], reason: m.params[2] ?? '' });
        return this.usersChanged();
      }
      case '471': case '473': case '474': case '475': case '403': case '405': case '476': case '520':
        this.status('error', `Couldn't join ${channel}: ${m.params.slice(2).join(' ') || m.cmd}`);
        return;
      case 'ERROR': return this.drop(m.params[0] || 'Server closed the connection');
    }
  }

  /** The link is gone (or unusable): tell the UI, then retry with a growing delay. */
  drop(reason) {
    if (this.closed || !this.socket) return;
    clearTimeout(this.registerTimer);
    const socket = this.socket;
    this.socket = null;
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.destroy();
    const wait = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)];
    this.status('disconnected', `${reason} — retrying in ${wait / 1000} s`);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.registerTimer);
    if (this.socket) {
      try { this.socket.write('QUIT :bye\r\n'); } catch { /* already gone */ }
      this.socket.removeAllListeners();
      this.socket.on('error', () => {});
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/** Starts (or restarts) the connection for a chat tab. → { ok, error? } */
function connect(id, specText, emit) {
  const spec = parseSpec(specText);
  if (!spec) return { ok: false, error: 'Not a valid IRC server and room' };
  conns.get(id)?.close();
  const c = new Conn(id, spec, emit);
  conns.set(id, c);
  c.connect();
  return { ok: true };
}

function disconnect(id) {
  conns.get(id)?.close();
  conns.delete(id);
}

function closeAll() {
  for (const c of conns.values()) c.close();
  conns.clear();
}

module.exports = { connect, disconnect, closeAll, parseSpec, parseLine };
