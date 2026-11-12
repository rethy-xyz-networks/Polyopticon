'use strict';

// A small RTMP client: connects to rtmp:// (or rtmps://) and plays one stream, handing its audio
// and video on as an FLV stream — what RTMP carries, and what the stream player (rtmp-player.html,
// with mpegts.js) can show. Chromium has no RTMP of its own. Play only: no publishing, no
// authentication, no encrypted (RTMPE) or tunnelled (RTMPT) variants.
//
//   play(url, { onData(buffer), onEnd(error | null) }) -> stop()

const net = require('net');
const tls = require('tls');

const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30_000;          // a live stream that sends nothing this long has ended
const MAX_MESSAGE = 16 * 1024 * 1024;    // a message larger than this is a broken stream, not a video frame
const FLV_HEADER = Buffer.from([0x46, 0x4C, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);   // "FLV", audio + video, first back-pointer
const TYPE = { CHUNK_SIZE: 1, ACK: 3, CONTROL: 4, WINDOW: 5, AUDIO: 8, VIDEO: 9, DATA: 18, COMMAND: 20, AGGREGATE: 22 };

/** rtmp://host[:port]/app[/more]/stream[?query] -> its parts; null if it isn't one. The last path segment is the stream. */
function parseUrl(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  if (!/^rtmps?:$/.test(u.protocol) || !u.hostname) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const secure = u.protocol === 'rtmps:', port = Number(u.port) || (secure ? 443 : 1935);
  const app = parts.slice(0, -1).join('/');
  return { secure, host: u.hostname, port, app, stream: decodeURIComponent(parts.at(-1)) + u.search, tcUrl: `${u.protocol}//${u.hostname}:${port}/${app}` };
}

// AMF0, the encoding of RTMP's commands

function amfEncode(values) {
  const out = [];
  const str = s => { const b = Buffer.from(s, 'utf8'), n = Buffer.alloc(2); n.writeUInt16BE(b.length); out.push(n, b); };
  const put = v => {
    if (typeof v === 'number') { const b = Buffer.alloc(9); b[0] = 0; b.writeDoubleBE(v, 1); out.push(b); }
    else if (typeof v === 'boolean') out.push(Buffer.from([1, v ? 1 : 0]));
    else if (typeof v === 'string') { out.push(Buffer.from([2])); str(v); }
    else if (v === null) out.push(Buffer.from([5]));
    else { out.push(Buffer.from([3])); for (const [k, x] of Object.entries(v)) { str(k); put(x); } out.push(Buffer.from([0, 0, 9])); }
  };
  values.forEach(put);
  return Buffer.concat(out);
}

/** Every value in the buffer. Stops quietly at anything unknown or cut short. */
function amfDecode(buf) {
  let at = 0;
  const str = long => { const n = long ? buf.readUInt32BE(at) : buf.readUInt16BE(at); at += long ? 4 : 2; if (at + n > buf.length) throw new RangeError('cut short'); const s = buf.toString('utf8', at, at + n); at += n; return s; };
  const props = () => {
    const o = {};
    while (at + 3 <= buf.length) {
      const k = str(false);
      if (!k && buf[at] === 9) { at++; break; }
      o[k] = value();
    }
    return o;
  };
  const value = () => {
    const t = buf[at++];
    switch (t) {
      case 0: at += 8; return buf.readDoubleBE(at - 8);
      case 1: return buf[at++] !== 0;
      case 2: return str(false);
      case 3: return props();
      case 5: case 6: return null;
      case 8: at += 4; return props();
      case 10: { const n = buf.readUInt32BE(at); at += 4; return Array.from({ length: n }, value); }
      case 11: at += 10; return buf.readDoubleBE(at - 10);
      case 12: return str(true);
      default: throw new RangeError(`AMF type ${t}`);
    }
  };
  const out = [];
  try { while (at < buf.length) out.push(value()); } catch { /* what was read so far */ }
  return out;
}

/** One FLV tag (audio 8, video 9, data 18) with the back-pointer that follows it. */
function flvTag(type, timestamp, body) {
  const b = Buffer.alloc(11 + body.length + 4);
  b[0] = type;
  b.writeUIntBE(body.length, 1, 3);
  b.writeUIntBE(timestamp & 0xFFFFFF, 4, 3);
  b[7] = (timestamp >>> 24) & 0xFF;
  body.copy(b, 11);
  b.writeUInt32BE(11 + body.length, 11 + body.length);
  return b;
}

/**
 * Splits the bytes from the server into messages. feed(buffer) calls onMessage({ type, timestamp, streamId, body })
 * for each complete one. `chunkSize` is set by the caller when the server changes it.
 */
function createReader(onMessage) {
  const streams = new Map();            // chunk stream id -> { timestamp, delta, length, type, streamId, extended, parts, got }
  let pending = Buffer.alloc(0);
  const reader = {
    chunkSize: 128,
    feed(data) {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      let at = 0;
      for (;;) {
        // Basic header: format and chunk stream id
        if (pending.length - at < 1) break;
        let p = at;
        const fmt = pending[p] >> 6;
        let csid = pending[p++] & 0x3F;
        if (csid === 0) { if (pending.length - p < 1) break; csid = 64 + pending[p++]; }
        else if (csid === 1) { if (pending.length - p < 2) break; csid = 64 + pending[p] + pending[p + 1] * 256; p += 2; }
        const headerLen = [11, 7, 3, 0][fmt];
        if (pending.length - p < headerLen) break;
        const prev = streams.get(csid);
        const s = prev ? { ...prev } : { timestamp: 0, delta: 0, length: 0, type: 0, streamId: 0, extended: false, parts: [], got: 0 };
        let field = -1;
        if (fmt <= 2) field = pending.readUIntBE(p, 3);
        if (fmt <= 1) { s.length = pending.readUIntBE(p + 3, 3); s.type = pending[p + 6]; }
        if (fmt === 0) s.streamId = pending.readUInt32LE(p + 7);
        p += headerLen;
        if (fmt <= 2) s.extended = field === 0xFFFFFF;
        if (s.extended) { if (pending.length - p < 4) break; field = pending.readUInt32BE(p); p += 4; }
        if (s.length > MAX_MESSAGE) throw new Error('message too large');
        const size = Math.min(reader.chunkSize, s.length - s.got);
        if (pending.length - p < size) break;
        // The whole chunk is here: only now is the stream's state changed
        if (s.got === 0) {                                   // first chunk of a message
          if (fmt === 0) { s.timestamp = field; s.delta = 0; }
          else { if (fmt <= 2) s.delta = field; s.timestamp = (s.timestamp + s.delta) >>> 0; }
          s.parts = [];
        }
        s.parts.push(pending.subarray(p, p + size));
        s.got += size;
        at = p + size;
        if (s.got >= s.length) {
          const body = s.parts.length === 1 ? s.parts[0] : Buffer.concat(s.parts);
          s.parts = []; s.got = 0;
          streams.set(csid, s);
          onMessage({ type: s.type, timestamp: s.timestamp, streamId: s.streamId, body });
        } else streams.set(csid, s);
      }
      pending = at < pending.length ? Buffer.from(pending.subarray(at)) : Buffer.alloc(0);
    },
  };
  return reader;
}

/** A message as one chunk (ours are all smaller than the chunk size we announce). */
function message(csid, type, streamId, body) {
  const h = Buffer.alloc(12);
  h[0] = csid;                                  // format 0: full header, timestamp 0
  h.writeUIntBE(body.length, 4, 3);
  h[7] = type;
  h.writeUInt32LE(streamId, 8);
  return Buffer.concat([h, body]);
}
const uint32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** Plays the stream. onData gets FLV bytes (the header first); onEnd(error) is called once, with null if the stream just ended. */
function play(url, { onData, onEnd }) {
  const target = parseUrl(url);
  if (!target) { setImmediate(() => onEnd(new Error('Not an rtmp:// link with an app and a stream name'))); return () => {}; }

  let done = false, handshake = Buffer.alloc(0), shaken = false, started = false;
  let received = 0, acked = 0, window = 2_500_000;
  const socket = target.secure ? tls.connect({ host: target.host, port: target.port, servername: target.host }) : net.connect({ host: target.host, port: target.port });
  const finish = error => {
    if (done) return;
    done = true;
    socket.destroy();
    onEnd(error ?? null);
  };
  const send = (csid, type, streamId, body) => { if (!done) socket.write(message(csid, type, streamId, body)); };
  const command = (csid, streamId, ...values) => send(csid, TYPE.COMMAND, streamId, amfEncode(values));
  const tag = (type, timestamp, body) => {
    if (!started) { started = true; onData(FLV_HEADER); }
    onData(flvTag(type, timestamp, body));
  };

  const reader = createReader(m => {
    const b = m.body;
    switch (m.type) {
      case TYPE.CHUNK_SIZE: if (b.length >= 4) reader.chunkSize = Math.max(1, b.readUInt32BE(0) & 0x7FFFFFFF); break;
      case TYPE.WINDOW: if (b.length >= 4) window = b.readUInt32BE(0) || window; break;
      case TYPE.CONTROL:                           // a ping is answered with the same time
        if (b.length >= 6 && b.readUInt16BE(0) === 6) send(2, TYPE.CONTROL, 0, Buffer.concat([Buffer.from([0, 7]), b.subarray(2, 6)]));
        break;
      case TYPE.AUDIO: case TYPE.VIDEO: if (b.length) tag(m.type, m.timestamp, b); break;
      case TYPE.DATA: {                            // onMetaData, sometimes wrapped in "@setDataFrame"
        const wrapped = b.length > 16 && b[0] === 2 && b.toString('latin1', 3, 16) === '@setDataFrame';
        tag(TYPE.DATA, m.timestamp, wrapped ? b.subarray(16) : b);
        break;
      }
      case TYPE.AGGREGATE: {                       // several FLV tags in one message; their times are relative to its first tag
        let at = 0, first = null;
        while (at + 11 <= b.length) {
          const type = b[at], size = b.readUIntBE(at + 1, 3), ts = b.readUIntBE(at + 4, 3) | (b[at + 7] << 24);
          if (at + 11 + size > b.length) break;
          first ??= ts;
          if (type === TYPE.AUDIO || type === TYPE.VIDEO || type === TYPE.DATA) tag(type, (m.timestamp + ts - first) >>> 0, b.subarray(at + 11, at + 11 + size));
          at += 11 + size + 4;
        }
        break;
      }
      case TYPE.COMMAND: {
        const [name, txn, , info] = amfDecode(b);
        if (name === '_result' && txn === 1) {      // connected: ask for a stream to play on
          send(2, TYPE.WINDOW, 0, uint32(window));
          command(3, 0, 'createStream', 2, null);
        } else if (name === '_result' && txn === 2) {
          const id = Number(info) || 1;
          command(8, id, 'play', 0, null, target.stream);
          send(2, TYPE.CONTROL, 0, Buffer.concat([Buffer.from([0, 3]), uint32(id), uint32(3000)]));   // our buffer: 3 s
        } else if (name === '_error') finish(new Error(info?.description || info?.code || 'The server refused the connection'));
        else if (name === 'onStatus' && info?.level === 'error') finish(new Error(info.description || info.code || 'The server refused the stream'));
        else if (name === 'onStatus' && /^NetStream\.Play\.(Stop|Complete|UnpublishNotify)$/.test(info?.code || '')) finish(null);
        break;
      }
      default: break;
    }
  });

  socket.setNoDelay(true);
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.on('timeout', () => finish(new Error(started ? 'The stream stopped sending' : 'The server did not answer')));
  socket.on('error', e => finish(e));
  socket.on('close', () => finish(started ? null : new Error('The server closed the connection')));
  socket.on(target.secure ? 'secureConnect' : 'connect', () => {
    // Handshake: version 3, then 1536 bytes (time, zero, anything)
    const c1 = Buffer.alloc(1536);
    for (let i = 8; i < 1536; i++) c1[i] = (Math.random() * 256) | 0;
    socket.write(Buffer.concat([Buffer.from([3]), c1]));
  });
  socket.on('data', data => {
    if (done) return;
    try {
      if (!shaken) {
        handshake = Buffer.concat([handshake, data]);
        if (handshake.length < 1 + 1536 * 2) return;        // S0, S1 and S2
        if (handshake[0] !== 3) return finish(new Error('Not an RTMP server'));
        shaken = true;
        socket.setTimeout(IDLE_TIMEOUT_MS);
        socket.write(handshake.subarray(1, 1537));           // C2: the server's S1 back
        send(2, TYPE.CHUNK_SIZE, 0, uint32(4096));           // so each of our commands is one chunk
        command(3, 0, 'connect', 1, {
          app: target.app, flashVer: 'LNX 9,0,124,2', tcUrl: target.tcUrl, fpad: false,
          capabilities: 15, audioCodecs: 4071, videoCodecs: 252, videoFunction: 1,
        });
        data = handshake.subarray(1 + 1536 * 2);
        handshake = null;
        if (!data.length) return;
      }
      received += data.length;
      if (received - acked >= window / 2) { acked = received; send(2, TYPE.ACK, 0, uint32(received)); }   // or the server stops sending
      reader.feed(data);
    } catch (e) { finish(new Error(`Broken stream: ${e.message}`)); }
  });

  return () => finish(null);
}

module.exports = { play, parseUrl, amfEncode, amfDecode, flvTag, createReader };
