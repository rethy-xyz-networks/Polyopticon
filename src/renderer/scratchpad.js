// The Scratchpad: one permanent note, shown as a tab (📜 in the toolbar). Plain text with light
// Markdown highlighting; pasted or dropped images sit inline, exactly where they were put.
// Saved automatically — after a pause in typing, when the tab is left or closed, and as the
// window closes — and stored encrypted by the main process (src/main/scratchpad.js). Nothing
// here touches disk itself.
//
// The saved text is one string; an image is a line of its own: ![image](scratch-img:<id>) or,
// once resized, ![image](scratch-img:<id>?w=<px>). The image data lives in `images`.
//
// On screen the note is a column of blocks: text blocks (a transparent <textarea> over a <pre>
// showing the same text, highlighted) with image blocks between them. There is always a text
// block before, after and between images, so the caret can go anywhere.

import { api, h, $, showMenu } from './dom.js';
import { icon } from './icons.js';

const SAVE_AFTER_MS = 1500;                        // inactivity before an automatic save
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const IMG_TOKEN = /!\[[^\]\n]*\]\(scratch-img:([A-Za-z0-9_-]+)(?:\?w=\d+)?\)/g;
const IMG_LINE = /^!\[[^\]\n]*\]\(scratch-img:([A-Za-z0-9_-]+)(?:\?w=(\d{2,5}))?\)$/;
const DEFAULT_WIDTH = 480;                         // shown width of a big image that hasn't been resized
const MIN_WIDTH = 40;

let ready = null;                                  // promise of the first load
let root = null, doc = null, blocksEl = null, status = null, lightbox = null;
let images = {};                                   // every image seen this session (saved: only the ones in the text)
let lastText = null;                               // the text block last focused
let dirty = false, saving = null, again = false, timer = null;

// Highlighting

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, s) => `<span class="${cls}">${s}</span>`;

// code | image | link | bold | bold | italic | italic
const INLINE = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\n]*\))|(\[[^\]\n]+\]\([^)\n]*\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\b_[^_\s][^_\n]*_\b)/g;
const INLINE_CLASS = [null, 'md-code', 'md-img', 'md-link', 'md-b', 'md-b', 'md-i', 'md-i'];

function inline(line) {
  return line.replace(INLINE, (m, ...g) => span(INLINE_CLASS[g.findIndex(x => x !== undefined) + 1], m));
}

/** Escaped HTML for the text with Markdown marked up. Adds only <span>s: every character stays where it was. */
export function highlight(text) {
  let fenced = false;
  return text.split('\n').map(raw => {
    const line = esc(raw);
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return span('md-code', line); }
    if (fenced) return span('md-code', line);
    let m;
    if (/^#{1,6}(\s.*)?$/.test(raw)) return span('md-h', line);
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return span('md-rule', line);
    if ((m = /^(\s*&gt;\s?)(.*)$/.exec(line))) return span('md-quote', m[1]) + span('md-quote', inline(m[2]));
    if ((m = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line))) return span('md-list', m[1]) + inline(m[2]);
    return inline(line);
  }).join('\n');
}

// The note as text

const isText = el => el.classList.contains('scratch-tb');
const imageToken = el => `![image](scratch-img:${el.dataset.id}${el.dataset.w ? `?w=${el.dataset.w}` : ''})`;
const referencedIds = text => [...new Set([...text.matchAll(IMG_TOKEN)].map(m => m[1]))];

/** The note's text: every block's lines, an image being a line of its own. */
function serialize() {
  const lines = [];
  for (const el of blocksEl.children) {
    if (isText(el)) { if (el.ta.value !== '') lines.push(...el.ta.value.split('\n')); }
    else lines.push(imageToken(el));
  }
  return lines.join('\n');
}

/** Blocks for a text: image lines (of images we have) split the text; text blocks go before, between and after. */
function parse(text) {
  const out = [];
  let buf = [];
  const flush = () => { out.push({ text: buf.join('\n') }); buf = []; };
  for (const line of text.split('\n')) {
    const m = IMG_LINE.exec(line);
    if (m && images[m[1]]) { flush(); out.push({ id: m[1], w: m[2] }); }
    else buf.push(line);
  }
  flush();
  return out;
}

function render(text) {
  blocksEl.replaceChildren(...parse(text).map(b => (b.id ? imageBlock(b.id, b.w) : textBlock(b.text))));
  paintPlaceholder();
  scheduleToc();
}

// Table of contents
// A fixed column beside the note listing its Markdown headings (# … ######), indented by level.
// Built from the highlighted mirrors, so it lists exactly the lines shown as headings (not ones
// inside a ``` code block). Clicking an entry scrolls the note to that heading and puts the
// caret at its start.

let toc = null, tocTimer = null;

function scheduleToc() {
  clearTimeout(tocTimer);
  tocTimer = setTimeout(renderToc, 120);
}

function renderToc() {
  if (!toc) return;
  const entries = [...blocksEl.querySelectorAll('.scratch-mirror > .md-h')].map(span => {
    const m = /^(#{1,6})\s*(.*?)\s*#*\s*$/.exec(span.textContent);
    return m && m[2] ? { span, level: m[1].length, text: m[2] } : null;
  }).filter(Boolean);
  toc.list.replaceChildren(...entries.map(e => h('button', {
    type: 'button', class: `scratch-toc-item l${e.level}`, title: e.text,
    onclick: () => goToHeading(e.span),
  }, e.text)));
  toc.empty.hidden = entries.length > 0;
}

function goToHeading(span) {
  const tb = span.closest('.scratch-tb');
  // The heading's position in the text: everything in the mirror before it (the mirror holds the same characters).
  const range = document.createRange();
  range.setStart(tb.querySelector('.scratch-mirror'), 0);
  range.setEndBefore(span);
  const at = range.toString().length;
  tb.ta.focus({ preventScroll: true });
  tb.ta.setSelectionRange(at, at);
  doc.scrollTo({ top: doc.scrollTop + span.getBoundingClientRect().top - doc.getBoundingClientRect().top - 12, behavior: 'smooth' });
}

/** The hint shows only while the whole note is a single empty block. */
function paintPlaceholder() {
  for (const el of blocksEl.children) {
    if (isText(el)) el.ta.placeholder = blocksEl.children.length === 1
      ? 'Scratchpad — type or paste text and images. Markdown is highlighted. Saved automatically and stored encrypted.' : '';
  }
}

// Text blocks

function textBlock(value) {
  const mirror = h('pre', { class: 'scratch-mirror', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'scratch-text', rows: 1, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Scratchpad' });
  const el = h('div', { class: 'scratch-tb' }, mirror, ta);
  el.ta = ta;
  // focus('start' | 'end') puts the caret in the textarea (an image block's focus() ignores the argument).
  el.focus = (where = 'end') => { ta.focus(); const at = where === 'start' ? 0 : ta.value.length; ta.setSelectionRange(at, at); };
  el.sync = () => { mirror.innerHTML = highlight(ta.value) + '\n'; scheduleToc(); };   // the extra line keeps a trailing newline measurable
  ta.value = value;
  el.sync();
  ta.addEventListener('input', () => { el.sync(); onEdit(); });
  ta.addEventListener('focus', () => { lastText = el; });
  ta.addEventListener('keydown', e => textKey(e, el));
  return el;
}

/** Arrow keys and Backspace/Delete step across images instead of skipping over them. */
function textKey(e, el) {
  const ta = el.ta;
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {          // a tab character, not a jump to the next control
    e.preventDefault();
    if (!document.execCommand('insertText', false, '\t')) {                              // execCommand keeps Ctrl+Z working
      ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    return;
  }
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || ta.selectionStart !== ta.selectionEnd) return;
  const prev = el.previousElementSibling, next = el.nextElementSibling;
  const atStart = ta.selectionStart === 0, atEnd = ta.selectionEnd === ta.value.length;
  if (atStart && prev && (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'Backspace')) { e.preventDefault(); prev.focus(); }
  else if (atEnd && next && (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'Delete')) { e.preventDefault(); next.focus('start'); }
}

// Image blocks

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function imageBlock(id, width) {
  const img = h('img', { class: 'scratch-pic', src: images[id], alt: '', draggable: 'false' });
  const el = h('div', { class: 'scratch-image', tabindex: '0', role: 'img', 'aria-label': 'Image — Enter enlarges, Delete removes', dataset: { id } });
  if (width) { el.dataset.w = width; img.style.width = `${width}px`; }
  else img.addEventListener('load', () => { if (!el.dataset.w) img.style.width = `${Math.max(MIN_WIDTH, Math.min(img.naturalWidth, DEFAULT_WIDTH))}px`; });

  const bar = h('div', { class: 'scratch-bar' },
    h('button', { type: 'button', title: 'Enlarge', 'aria-label': 'Enlarge image', onclick: () => showLightbox(images[id]) }, icon('enlarge')),
    h('button', { type: 'button', title: 'Delete image', 'aria-label': 'Delete image', onclick: () => removeImage(el) }, icon('delete')));
  const grip = h('div', { class: 'scratch-grip', title: 'Drag to resize · double-click to reset' });
  grip.addEventListener('pointerdown', e => resizeStart(e, el, img, grip));
  grip.addEventListener('dblclick', () => {
    delete el.dataset.w;
    img.style.width = `${Math.max(MIN_WIDTH, Math.min(img.naturalWidth || DEFAULT_WIDTH, DEFAULT_WIDTH))}px`;
    onEdit();
  });

  el.append(h('div', { class: 'scratch-frame' }, img, bar, grip));
  img.addEventListener('click', () => { el.focus(); showLightbox(images[id]); });
  el.addEventListener('keydown', e => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeImage(el); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showLightbox(images[id]); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); el.nextElementSibling?.focus('start'); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); el.previousElementSibling?.focus(); }
  });
  // Ctrl + scroll over the picture resizes it in place (plain scrolling still scrolls the note).
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const maxW = Math.max(MIN_WIDTH, blocksEl.clientWidth - 40);
    const w = Math.round(Math.max(MIN_WIDTH, Math.min(maxW, img.getBoundingClientRect().width * Math.exp(-e.deltaY * 0.0015))));
    img.style.width = `${w}px`;
    el.dataset.w = w;
    onEdit();
  }, { passive: false });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Enlarge', onClick: () => showLightbox(images[id]) },
      { label: 'Reset size', disabled: !el.dataset.w, onClick: () => grip.dispatchEvent(new Event('dblclick')) },
      'sep',
      { label: 'Delete image', onClick: () => removeImage(el) },
    ]);
  });
  return el;
}

function resizeStart(e, el, img, grip) {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const startX = e.clientX, startW = img.getBoundingClientRect().width;
  const maxW = Math.max(MIN_WIDTH, blocksEl.clientWidth - 40);
  const move = ev => {
    const w = Math.round(Math.max(MIN_WIDTH, Math.min(maxW, startW + ev.clientX - startX)));
    img.style.width = `${w}px`;
    el.dataset.w = w;
  };
  const up = () => { grip.removeEventListener('pointermove', move); onEdit(); };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
}

/** Take an image out of the note; the text around it joins up. */
function removeImage(el) {
  const prev = el.previousElementSibling, next = el.nextElementSibling;
  const a = prev.ta.value, b = next.ta.value;
  prev.ta.value = a && b ? `${a}\n${b}` : a || b;
  prev.sync();
  el.remove();
  next.remove();
  paintPlaceholder();
  prev.ta.focus();
  const caret = a && b ? a.length + 1 : a.length;
  prev.ta.setSelectionRange(caret, caret);
  onEdit();
}

// The enlarged view: scroll to zoom (about the pointer), drag to pan, double-click to reset.
const view = { s: 1, x: 0, y: 0, moved: false };
const ZOOM_MIN = 0.2, ZOOM_MAX = 16;

function paintZoom() {
  const img = lightbox.querySelector('img');
  if (!img) return;
  img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  img.style.cursor = view.s > 1 ? 'grab' : 'default';
}

function showLightbox(src) {
  Object.assign(view, { s: 1, x: 0, y: 0, moved: false });
  lightbox.replaceChildren(
    h('img', { src, alt: '', draggable: 'false' }),
    h('button', { type: 'button', class: 'scratch-lightbox-close', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => { lightbox.hidden = true; } }, '✕'),
    h('div', { class: 'scratch-lightbox-hint' }, 'Scroll to zoom · drag to move · double-click to reset'));
  lightbox.hidden = false;
  paintZoom();
}

function bindLightbox() {
  lightbox.addEventListener('wheel', e => {
    e.preventDefault();
    const r = lightbox.getBoundingClientRect();
    const px = e.clientX - (r.left + r.width / 2), py = e.clientY - (r.top + r.height / 2);   // pointer, from the centre
    const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.s * Math.exp(-e.deltaY * 0.0015)));
    view.x = px - (s * (px - view.x)) / view.s;                 // the point under the pointer stays put
    view.y = py - (s * (py - view.y)) / view.s;
    view.s = s;
    paintZoom();
  }, { passive: false });
  lightbox.addEventListener('pointerdown', e => {
    if (e.target.tagName !== 'IMG' || e.button !== 0) return;
    e.preventDefault();
    const img = e.target;
    img.setPointerCapture(e.pointerId);                         // captured by the picture, so the click still lands on it
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    view.moved = false;
    const move = ev => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) view.moved = true;
      view.x = ox + ev.clientX - sx;
      view.y = oy + ev.clientY - sy;
      paintZoom();
    };
    img.addEventListener('pointermove', move);
    img.addEventListener('pointerup', () => img.removeEventListener('pointermove', move), { once: true });
  });
  lightbox.addEventListener('dblclick', e => {
    if (e.target.tagName !== 'IMG') return;
    Object.assign(view, { s: 1, x: 0, y: 0 });
    paintZoom();
  });
  lightbox.addEventListener('click', e => {                     // the dark area closes it; the picture doesn't
    if (view.moved) { view.moved = false; return; }
    if (e.target === lightbox) lightbox.hidden = true;
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Put an image into the note at the caret of this text block (splitting the block). */
function insertImage(id, tb) {
  const ta = tb.ta;
  const before = ta.value.slice(0, ta.selectionStart).replace(/\n$/, '');
  const after = ta.value.slice(ta.selectionEnd).replace(/^\n/, '');
  ta.value = before;
  tb.sync();
  const pic = imageBlock(id);
  const rest = textBlock(after);
  tb.after(pic, rest);
  paintPlaceholder();
  rest.ta.focus();
  rest.ta.setSelectionRange(0, 0);
  rest.scrollIntoView({ block: 'nearest' });
  onEdit();
}

async function addImages(files, tb) {
  for (const file of files) {
    if (!IMAGE_TYPES.test(file.type)) { setStatus('Only PNG, JPEG, GIF and WebP images can be added.', 'err'); continue; }
    if (file.size > MAX_IMAGE_BYTES) { setStatus('That image is over 20 MB — too large to add.', 'err'); continue; }
    try {
      const id = newId();
      images[id] = await readFile(file);
      insertImage(id, tb);
      tb = lastText;                                            // the next image goes after this one
    } catch (e) { setStatus(`Could not read the image: ${e.message}`, 'err'); }
  }
}

/** Where a paste or drop lands: the text block it happened in, else the one last used, else the end. */
function targetBlock(e) {
  const own = e.target.closest?.('.scratch-tb');
  if (own) return own;
  const image = e.target.closest?.('.scratch-image');
  if (image) return image.nextElementSibling;                   // just after the image
  return lastText?.isConnected ? lastText : [...blocksEl.children].filter(isText).at(-1);
}

// Saving

const snapshot = () => {
  const text = serialize();
  return { text, images: Object.fromEntries(referencedIds(text).filter(id => images[id]).map(id => [id, images[id]])) };
};

function setStatus(msg, cls = '') {
  if (!status) return;
  status.textContent = msg;
  status.className = `scratch-status ${cls}`;
}

function onEdit() {
  dirty = true;
  setStatus('Unsaved changes…');
  clearTimeout(timer);
  timer = setTimeout(save, SAVE_AFTER_MS);
}

/** Save now (if there is anything to save). One save at a time; edits made meanwhile trigger another. */
export function save() {
  clearTimeout(timer);
  if (!blocksEl || !dirty) return saving ?? Promise.resolve();
  if (saving) { again = true; return saving; }
  dirty = false;
  setStatus('Saving…');
  saving = (async () => {
    let res;
    try { res = await api.saveScratch(snapshot()); }
    catch (e) { res = { ok: false, error: e.message }; }
    saving = null;
    if (!res.ok) { dirty = true; setStatus(res.error || 'Could not save the scratchpad.', 'err'); return; }
    if (dirty || again) { again = false; return save(); }
    setStatus('Saved · encrypted on this computer', 'ok');
  })();
  return saving;
}

/**
 * Add a line at the end of the note (from outside the Scratchpad, e.g. the 📝 button on a page)
 * and save it straight away. Loads the note first if it hasn't been opened yet.
 */
export async function appendToScratch(line) {
  await initScratch();
  const last = [...blocksEl.children].filter(isText).at(-1);
  if (!last) return;
  const v = last.ta.value;
  last.ta.value = v === '' || v.endsWith('\n') ? v + line : `${v}\n${line}`;
  last.sync();
  paintPlaceholder();
  onEdit();
  await save();
}

/** Called when the tab is left or closed. */
export const flushScratch = () => { if (dirty) save(); };

window.addEventListener('beforeunload', () => {                // the window is closing: write synchronously
  if (!blocksEl || !dirty) return;
  dirty = false;
  try { api.saveScratchSync(snapshot()); } catch { /* nothing more can be done */ }
});

// View

function build() {
  root = $('scratch-view');
  blocksEl = h('div', { class: 'scratch-blocks' });
  doc = h('div', { class: 'scratch-doc' }, blocksEl);
  status = h('span', { class: 'scratch-status' });
  toc = { list: h('nav', { class: 'scratch-toc-list', 'aria-label': 'Table of contents' }),
          empty: h('p', { class: 'scratch-toc-empty' }, 'Start a line with # to add a heading here.') };
  lightbox = h('div', { class: 'scratch-lightbox', hidden: true });
  bindLightbox();

  // Click in the empty space below the note: the caret goes to the end.
  doc.addEventListener('mousedown', e => {
    if (e.target !== doc && e.target !== blocksEl) return;
    e.preventDefault();
    const last = [...blocksEl.children].filter(isText).at(-1);
    last?.ta.focus();
    last?.ta.setSelectionRange(last.ta.value.length, last.ta.value.length);
  });
  doc.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget)) flushScratch(); });

  doc.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;                                  // plain text pastes normally
    e.preventDefault();
    addImages(files, targetBlock(e));
  });
  doc.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  doc.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    addImages(files, targetBlock(e));
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lightbox.hidden) { lightbox.hidden = true; e.stopPropagation(); } }, true);

  root.append(h('div', { class: 'scratch-main' },
      h('aside', { class: 'scratch-toc' }, h('div', { class: 'caps scratch-toc-title' }, 'Contents'), toc.list, toc.empty), doc),
    h('div', { class: 'scratch-foot' }, status, h('span', { class: 'muted' }, 'Paste or drop images · drag an image’s corner to resize · click to enlarge')), lightbox);
}

/** First use: build the view and load the note. Safe to call repeatedly. */
export function initScratch() {
  ready ??= (async () => {
    build();
    setStatus('Loading…');
    try {
      const note = await api.loadScratch();
      images = { ...note.images };
      render(note.text);
      setStatus('Saved · encrypted on this computer', 'ok');
    } catch (e) {
      setStatus(`Could not load the scratchpad: ${e.message}`, 'err');
      api.log('error', `Scratchpad: load failed: ${e.message}`);
    }
  })();
  return ready;
}

export async function focusScratch() {
  await initScratch();
  const last = [...(blocksEl?.children ?? [])].filter(isText).at(-1);
  if (!last) return;
  last.ta.focus();
  last.ta.setSelectionRange(last.ta.value.length, last.ta.value.length);
}
