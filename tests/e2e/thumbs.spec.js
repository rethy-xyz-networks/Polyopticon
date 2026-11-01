'use strict';

// Story pictures: a feed item that names a picture shows it on the left of its row
// (fetched and shrunk by the app, served as polyopticon-icon://thumb/<id>); items
// without one, or whose picture is broken, show only their text.

const http = require('http');
const zlib = require('zlib');
const { test, expect } = require('./fixtures');

test.use({ settings: { GroupStories: false } });           // the three similar headlines would group into one row

/** A solid-colour PNG, width × height. */
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;                                         // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

let server, base, picRequests = 0, laterPics = false;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      const now = new Date().toUTCString();
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Pictures</title>
        <item><title>Story with a picture</title><link>${base}/a</link><guid>${base}/a</guid><pubDate>${now}</pubDate>
          <media:content url="${base}/pic.png" medium="image"/></item>
        <item><title>Story with a broken picture</title><link>${base}/b</link><guid>${base}/b</guid><pubDate>${now}</pubDate>
          <enclosure url="${base}/missing.jpg" type="image/jpeg"/></item>
        <item><title>Story without a picture</title><link>${base}/c</link><guid>${base}/c</guid><pubDate>${now}</pubDate>
          <description>Just text</description></item>
      </channel></rss>`);
    }
    if (req.url === '/later') {
      // A story first listed without a picture; the feed names one on a later poll.
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Later</title>
        <item><title>Picture added later</title><link>${base}/l</link><guid>${base}/l</guid><pubDate>${new Date(Date.now() - 60e3).toUTCString()}</pubDate>
          ${laterPics ? `<media:thumbnail url="${base}/pic.png"/>` : ''}</item>
      </channel></rss>`);
    }
    if (req.url === '/pic.png') { picRequests++; res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png(400, 300)); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

test('feed pictures show left of the story; stories without one (or a broken one) show text only', async ({ window }) => {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Picture Feed', grp: 'Test', category: 'T', color: '#1F3A5F', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);

  const row = title => window.locator('#feed-list .item', { hasText: title });
  await expect(row('Story with a picture')).toBeVisible({ timeout: 30_000 });

  const pic = row('Story with a picture').locator('img.thumb');
  await expect.poll(() => pic.evaluate(img => img.complete && img.naturalWidth), { timeout: 15_000 }).toBe(192);   // shrunk from 400
  await expect(row('Story with a picture')).toHaveClass(/has-thumb/);
  const [picBox, titleBox] = await Promise.all([pic.boundingBox(), row('Story with a picture').locator('.title').boundingBox()]);
  expect(picBox.x + picBox.width).toBeLessThanOrEqual(titleBox.x);  // on the left of the text

  await expect(row('Story with a broken picture').locator('img.thumb')).toHaveCount(0, { timeout: 15_000 });
  await expect(row('Story with a broken picture')).not.toHaveClass(/has-thumb/);
  await expect(row('Story without a picture').locator('img.thumb')).toHaveCount(0);
  await expect(row('Story without a picture')).not.toHaveClass(/has-thumb/);
  expect(picRequests).toBe(1);
  expect(window.pageErrors).toEqual([]);
});

test('a story already listed gets its picture when its feed names one later', async ({ window }) => {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Later Feed', grp: 'Test', category: 'T', color: '#1F3A5F', enabled: true, config: { url },
  }), `${base}/later`);
  expect(saved.ok, saved.error).toBe(true);
  const row = window.locator('#feed-list .item', { hasText: 'Picture added later' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('img.thumb')).toHaveCount(0);

  laterPics = true;
  await window.evaluate(() => window.polyopticon.refresh());
  await expect.poll(() => row.locator('img.thumb').evaluate(img => img.complete && img.naturalWidth).catch(() => 0), { timeout: 30_000 }).toBe(192);
  await expect(row).toHaveClass(/has-thumb/);
  expect(window.pageErrors).toEqual([]);
});

test('pictures have two sizes: small when the story list is at its narrowest, normal otherwise', async ({ window }) => {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Picture Feed', grp: 'Test', category: 'T', color: '#1F3A5F', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  const pic = window.locator('#feed-list .item', { hasText: 'Story with a picture' }).locator('img.thumb');
  await expect(pic).toBeVisible({ timeout: 30_000 });
  const width = () => pic.evaluate(img => img.getBoundingClientRect().width);
  const set = (k, v) => window.evaluate(async ([k, v]) => (await import('./settings.js')).setSetting(k, v), [k, v]);
  const paneWidth = w => window.evaluate(w => document.documentElement.style.setProperty('--w-feed', `${w}px`), w);

  await paneWidth(420);
  await expect.poll(width).toBe(96);
  await set('FontSize', 10); await set('FeedDensity', 0);            // text size and density don't change it
  await expect.poll(width).toBe(96);
  await paneWidth(340);
  await expect.poll(width).toBe(96);
  await paneWidth(260);                                               // the narrowest the pane can be dragged
  await expect.poll(width).toBe(44);
  expect(window.pageErrors).toEqual([]);
});

test('hovering a picture shows a larger preview, capped in width; leaving hides it', async ({ window }) => {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Picture Feed', grp: 'Test', category: 'T', color: '#1F3A5F', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  const pic = window.locator('#feed-list .item', { hasText: 'Story with a picture' }).locator('img.thumb');
  await expect.poll(() => pic.evaluate(img => img.complete && img.naturalWidth), { timeout: 30_000 }).toBe(192);

  await pic.hover();
  const preview = window.locator('#thumb-preview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(img => img.complete && img.naturalWidth)).toBe(400);   // the 400px original, not the row's copy
  const [box, picBox] = await Promise.all([preview.boundingBox(), pic.boundingBox()]);
  expect(box.width).toBeLessThanOrEqual(360);                         // capped
  expect(box.width).toBeGreaterThan(picBox.width * 2);                // but clearly larger
  expect(box.x).toBeGreaterThanOrEqual(picBox.x + picBox.width);     // beside the picture, not over it
  const vp = await window.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  expect(box.x + box.width).toBeLessThanOrEqual(vp.w);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.h);

  await window.locator('#feed-list .item', { hasText: 'Story without a picture' }).locator('.title').hover();
  await expect(preview).toBeHidden();
  expect(window.pageErrors).toEqual([]);
});
