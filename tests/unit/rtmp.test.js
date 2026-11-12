'use strict';

// The RTMP client (src/main/rtmp.js): links, AMF0, chunk reading, and a whole play against a small
// server in this process. Plus the stream area's handling of rtmp:// links (src/renderer/streams.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const { play, parseUrl, amfEncode, amfDecode, flvTag, createReader } = require('../../src/main/rtmp');

test('parseUrl: host, port, app and stream; the last path segment is the stream', () => {
  assert.deepEqual(parseUrl('rtmp://live.example.com/live/blastwave'),
    { secure: false, host: 'live.example.com', port: 1935, app: 'live', stream: 'blastwave', tcUrl: 'rtmp://live.example.com:1935/live' });
  const u = parseUrl('rtmps://example.com:8443/app/inst/key?token=1');
  assert.deepEqual([u.secure, u.port, u.app, u.stream], [true, 8443, 'app/inst', 'key?token=1']);
  for (const bad of ['https://example.com/a/b', 'rtmp://example.com/onlyapp', 'rtmp://', 'nonsense']) assert.equal(parseUrl(bad), null);
});

test('AMF0 values survive encoding and decoding', () => {
  const values = ['connect', 1, { app: 'live', fpad: false, n: 2.5 }, null];
  assert.deepEqual(amfDecode(amfEncode(values)), values);
  assert.deepEqual(amfDecode(Buffer.from([2, 0, 5, 0x61])), []);      // cut short: nothing, no throw
});

test('flvTag: header, body and back-pointer, with the high byte of long timestamps', () => {
  const t = flvTag(9, 0x01020304, Buffer.from([1, 2, 3]));
  assert.deepEqual([...t], [9, 0, 0, 3, 2, 3, 4, 1, 0, 0, 0, 1, 2, 3, 0, 0, 0, 14]);
});

/** A message split into chunks the way a server sends it: a full header, then continuation chunks. */
function chunked(csid, type, streamId, timestamp, body, size) {
  const h = Buffer.alloc(12);
  h[0] = csid; h.writeUIntBE(timestamp, 1, 3); h.writeUIntBE(body.length, 4, 3); h[7] = type; h.writeUInt32LE(streamId, 8);
  const out = [h];
  for (let at = 0; at < body.length; at += size) { if (at) out.push(Buffer.from([0xC0 | csid])); out.push(body.subarray(at, at + size)); }
  return Buffer.concat(out);
}

test('the reader joins chunks, however the bytes arrive, and follows timestamp deltas', () => {
  const got = [];
  const reader = createReader(m => got.push([m.type, m.timestamp, m.streamId, m.body.toString()]));
  const body = Buffer.from('x'.repeat(300));
  const delta = Buffer.concat([Buffer.from([0x40 | 4, 0, 0, 40, 0, 0, 2, 9]), Buffer.from('ab')]);   // format 1: +40 ms, new length
  const same = Buffer.concat([Buffer.from([0xC0 | 4]), Buffer.from('cd')]);                           // format 3: same again
  const bytes = Buffer.concat([chunked(4, 9, 1, 1000, body, 128), delta, same]);
  for (let at = 0; at < bytes.length; at += 7) reader.feed(bytes.subarray(at, at + 7));               // in 7-byte pieces
  assert.deepEqual(got, [[9, 1000, 1, body.toString()], [9, 1040, 1, 'ab'], [9, 1080, 1, 'cd']]);
});

/** A server that plays `frames` on the stream named "ok" and refuses any other. */
function fakeServer(frames) {
  const server = net.createServer(sock => {
    let shaken = 0, buf = Buffer.alloc(0);
    const send = (type, sid, ts, body) => sock.write(chunked(type === 20 ? 3 : 5, type, sid, ts, body, 64));
    const reader = createReader(m => {
      if (m.type !== 20) return;
      const [name, txn, , arg] = amfDecode(m.body);
      if (name === 'connect') { sock.write(chunked(2, 1, 0, 0, Buffer.from([0, 0, 0, 64]), 128)); send(20, 0, 0, amfEncode(['_result', txn, null, { code: 'NetConnection.Connect.Success' }])); }
      else if (name === 'createStream') send(20, 0, 0, amfEncode(['_result', txn, null, 1]));
      else if (name === 'play' && arg === 'ok') {
        send(20, 1, 0, amfEncode(['onStatus', 0, null, { level: 'status', code: 'NetStream.Play.Start' }]));
        send(18, 1, 0, Buffer.concat([amfEncode(['@setDataFrame']), amfEncode(['onMetaData', { width: 2 }])]));
        frames.forEach((f, i) => send(f[0], 1, 1000 + i * 40, f[1]));
        send(20, 1, 0, amfEncode(['onStatus', 0, null, { level: 'status', code: 'NetStream.Play.UnpublishNotify' }]));
      } else if (name === 'play') send(20, 1, 0, amfEncode(['onStatus', 0, null, { level: 'error', code: 'NetStream.Play.StreamNotFound', description: 'No such stream' }]));
    });
    reader.chunkSize = 4096;
    sock.on('error', () => {});
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (shaken === 0 && buf.length >= 1537) { sock.write(Buffer.concat([Buffer.from([3]), Buffer.alloc(1536), buf.subarray(1, 1537)])); buf = buf.subarray(1537); shaken = 1; }
      if (shaken === 1 && buf.length >= 1536) { buf = buf.subarray(1536); shaken = 2; }
      if (shaken === 2 && buf.length) { reader.feed(buf); buf = Buffer.alloc(0); }
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}
const played = url => new Promise(done => { const parts = []; play(url, { onData: b => parts.push(b), onEnd: error => done({ error, flv: Buffer.concat(parts) }) }); });

test('play: handshake, connect and play; the stream arrives as FLV, and a refusal as its reason', async () => {
  const frames = [[9, Buffer.from('v'.repeat(200))], [8, Buffer.from('aa')], [9, Buffer.from('w'.repeat(70))]];
  const server = await fakeServer(frames);
  const base = `rtmp://127.0.0.1:${server.address().port}/live`;
  try {
    const { error, flv } = await played(`${base}/ok`);
    assert.equal(error, null);
    assert.equal(flv.toString('latin1', 0, 3), 'FLV');
    const tags = [];
    for (let at = 13; at < flv.length;) { const n = flv.readUIntBE(at + 1, 3); tags.push([flv[at], flv.readUIntBE(at + 4, 3), flv.subarray(at + 11, at + 11 + n)]); at += 11 + n + 4; }
    assert.deepEqual(tags.map(t => t[0]), [18, 9, 8, 9]);
    assert.deepEqual(amfDecode(tags[0][2]), ['onMetaData', { width: 2 }]);            // unwrapped from @setDataFrame
    assert.deepEqual(tags.slice(1).map(t => [t[1], t[2].toString()]), frames.map((f, i) => [1000 + i * 40, f[1].toString()]));

    const refused = await played(`${base}/missing`);
    assert.equal(refused.error.message, 'No such stream');
    assert.equal(refused.flv.length, 0);
  } finally { server.close(); }
});

test('the stream area takes rtmp:// links as Direct streams, played by the app\'s own page', async () => {
  const s = await import(pathToFileURL(path.join(__dirname, '../../src/renderer/streams.js')));
  const link = 'rtmp://live.genunix.com/live/blastwave';
  assert.equal(s.siteOfLink(link), 'direct');
  assert.equal(s.parseStream('direct', ` ${link} `), link);
  assert.equal(s.parseStream('direct', 'rtmp://host/onlyapp'), null);
  assert.equal(s.streamUrl('direct', link), `polyopticon-rtmp://player/?u=${encodeURIComponent(link)}`);
  assert.equal(s.streamLabel('direct', link), 'Direct: blastwave');
  assert.equal(s.streamUrl('direct', 'https://example.com/clip.mp4'), 'https://example.com/clip.mp4');
});
