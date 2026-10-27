'use strict';

// The map's GADM download: reading the zip, and turning GADM's Canada level 2 into census divisions.

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { unzipEntry, divisionsFromGadm, simplifyRing } = require('../../src/main/mapdata');

/** A one-file zip, deflated, as GADM serves it. */
function zipOf(name, body) {
  const data = zlib.deflateRawSync(body), n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const at = 30 + n.length + data.length, size = 46 + n.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

test('reads the JSON out of a zip', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'Nova Scotia' }));
  assert.deepStrictEqual(JSON.parse(unzipEntry(zipOf('gadm41_CAN_2.json', body), /\.json$/)), { hello: 'Nova Scotia' });
  assert.throws(() => unzipEntry(zipOf('readme.txt', body), /\.json$/), /nothing like/);
  assert.throws(() => unzipEntry(Buffer.from('not a zip'), /\.json$/), /not a zip/);
});

test('a division gets its province, a spaced name and Statistics Canada\'s code', () => {
  const square = [[-63, 44], [-63, 45], [-62, 45], [-62, 44], [-63, 44]];
  const f = (props, coords = [[square]]) => ({ type: 'Feature', properties: props, geometry: { type: 'MultiPolygon', coordinates: coords } });
  const out = divisionsFromGadm({ features: [
    f({ HASC_2: 'CA.NS.HF', NAME_2: 'Halifax', CC_2: '09', GID_2: 'CAN.7.9_1' }),
    f({ HASC_2: 'CA.NF.DN', NAME_2: 'Division No.1', CC_2: '01', GID_2: 'CAN.5.1_1' }),
    f({ HASC_2: 'CA.QC.XX', NAME_2: 'LesBasques', CC_2: 'NA', GID_2: 'CAN.11.2_1' }),
    f({ HASC_2: 'CA.NS.TY', NAME_2: 'Tiny', CC_2: '99', GID_2: 'x' }, [[[[-63, 44], [-63, 44.001], [-63.001, 44], [-63, 44]]]]),
  ] }).features.map(x => x.properties);
  assert.deepStrictEqual(out, [
    { iso: 'CA', parent: 'CA-NS', kind: 'Census division', name: 'Halifax', code: '1209' },
    { iso: 'CA', parent: 'CA-NL', kind: 'Census division', name: 'Division No. 1', code: '1001' },   // GADM's NF is CA-NL
    { iso: 'CA', parent: 'CA-QC', kind: 'Census division', name: 'Les Basques', code: 'CAN.11.2_1' },
  ]);                                                                    // too small to draw: dropped
});

test('rings are simplified to about half a km and rounded', () => {
  const wiggly = [[0, 0], [0.5, 0.001], [1, 0], [1, 1], [0.5, 1.0001], [0, 1], [0, 0]];
  assert.deepStrictEqual(simplifyRing(wiggly), [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  assert.strictEqual(simplifyRing([[0, 0], [0.001, 0], [0, 0]]), null);
});
