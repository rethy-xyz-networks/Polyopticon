'use strict';

// Times saving an article: the page-side scripts that clean a page (clean.js) and pull out its text
// (Readability + extract.js), on synthetic news pages of growing size with walls, banners, sticky bars and ads.
//
//   node_modules/.bin/electron scripts/bench/article.js [--root=<app folder>]
//
// Runs inside Electron (a hidden window per page); prints one line per page size. --root measures another
// checkout's page scripts (e.g. a git worktree of an older commit) with the same pages.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const ROOT = path.resolve(arg('root') || path.join(__dirname, '..', '..'));
const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js', { paths: [ROOT, __dirname] }), 'utf8');
const CLEAN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'page', 'clean.js'), 'utf8');
const EXTRACT = READABILITY + '\n;' + fs.readFileSync(path.join(ROOT, 'src', 'main', 'page', 'extract.js'), 'utf8');

let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const WORDS = 'the government said officials talks continue next week amid growing pressure from allies and rising prices across the region ceasefire minister parliament election court police border troops'.split(' ');
const sentence = n => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');

/** A news page with roughly `size` elements: article body, navigation, related links, ads, and overlays. */
function page(size) {
  const paras = Array.from({ length: 40 }, () => `<p>${sentence(45)}. <a href="/x">${sentence(3)}</a> ${sentence(30)}.</p>`).join('');
  const filler = n => Array.from({ length: n }, (_, i) =>
    `<div class="card c${i}"><div class="inner"><span class="tag">${sentence(2)}</span><a href="/n/${i}"><span>${sentence(6)}</span></a></div></div>`).join('');
  const ads = Array.from({ length: 25 }, (_, i) => `<div class="ad-slot" id="div-gpt-ad-${i}" style="height:90px"><span>Advertisement</span></div>`).join('');
  return `<!doctype html><html><head><title>Bench</title><style>
    body{margin:0;font:16px sans-serif} .bar{position:sticky;top:0;background:#fff;height:50px}
    .cookie-banner{position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee}
    .paywall-modal{position:fixed;inset:0;background:rgba(0,0,0,.6)}
    .scrim{position:absolute;left:0;right:0;height:300px;background:linear-gradient(transparent,#fff)}
    .abs{position:absolute;left:10px;top:10px;width:40px;height:40px}
  </style></head><body class="modal-open">
    <div class="bar"><nav>${Array.from({ length: 60 }, (_, i) => `<a href="/s/${i}">Section ${i}</a>`).join('')}</nav></div>
    <div class="cookie-banner" id="onetrust-banner-sdk">We value your privacy. Accept cookies <button>Accept</button></div>
    <div class="paywall-modal"><div>Subscribe to continue reading. Already a subscriber? Log in</div></div>
    <main><article><h1>${sentence(9)}</h1>${paras}<div class="scrim"></div>
      <div class="gateway-msg"><p>Subscribe to read the full story</p></div></article>
    <aside>${ads}</aside>
    <section class="related">${filler(Math.max(0, Math.floor(size / 5)))}</section></main>
    ${Array.from({ length: 60 }, (_, i) => `<div class="abs">${i}</div>`).join('')}
    <footer>${filler(Math.floor(size / 20))}</footer>
  </body></html>`;
}

const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];

async function measure(win, size) {
  const file = path.join(os.tmpdir(), `polybench-article-${size}.html`);     // a data: URL has a size limit
  fs.writeFileSync(file, page(size));
  await win.loadFile(file);
  const wc = win.webContents;
  const count = await wc.executeJavaScript('document.querySelectorAll("*").length');
  const clean = [], extract = [];
  for (let i = 0; i < 5; i++) {
    const loaded = new Promise(r => wc.once('did-finish-load', r));
    wc.reload();
    await loaded;
    let t = performance.now();
    const c = await wc.executeJavaScript(CLEAN);
    clean.push(performance.now() - t);
    t = performance.now();
    const e = await wc.executeJavaScript(EXTRACT);
    extract.push(performance.now() - t);
    if (i === 0) console.log(`  (removed ${c.removed} nodes, wall ${c.wall}, extracted ${e.words ?? 0} words by ${e.method ?? 'none'})`);
  }
  fs.rmSync(file, { force: true });
  return { size, elements: count, clean: median(clean), extract: median(extract) };
}

app.whenReady().then(async () => {
  console.log(ROOT);
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true } });
  for (const size of [500, 2000, 8000, 20000]) {
    const r = await measure(win, size);
    console.log(`${String(r.elements).padStart(6)} elements   clean.js ${r.clean.toFixed(0).padStart(5)} ms   extract ${r.extract.toFixed(0).padStart(5)} ms`);
  }
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
