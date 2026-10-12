// DOM + formatting helpers shared by the renderer modules.

export const api = window.polyopticon;
export const $ = id => document.getElementById(id);

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') node[k] = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}

const pad2 = n => String(n).padStart(2, '0');

/** "2026-10-04 5:42 PM" */
export function formatStamp(ms) {
  const d = new Date(ms);
  const hr = d.getHours() % 12 || 12;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hr}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

export function formatTime(ms) {
  const d = new Date(ms);
  return `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

export function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function maxAgeLabel(h) {
  if (h === 0) return 'No limit';
  if (h < 24) return `${h}h`;
  return { 24: '1 day', 48: '2 days', 168: '1 week' }[h] ?? `${Math.floor(h / 24)}d`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Shows glyph (text or an icon element) on btn for a moment, then puts back what was there. */
export function flash(btn, glyph, ms = 900) {
  const prev = [...btn.childNodes];
  btn.replaceChildren(glyph);
  setTimeout(() => btn.replaceChildren(...prev), ms);
}

/** Small right-click menu. items: [{ label, onClick, disabled }] or 'sep'. */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' }, ...items.map(it => it === 'sep'
    ? h('div', { class: 'sep' })
    : h('button', { role: 'menuitem', disabled: !!it.disabled, onclick: () => { closeMenu(); it.onClick(); } },
        it.label, it.hint && h('span', { class: 'hint' }, it.hint))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('blur', closeMenu);              // e.g. a click into a webview
  });
}

export function closeMenu() {
  document.querySelector('.ctx-menu')?.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('blur', closeMenu);
}
const onOutside = e => { if (!e.target.closest('.ctx-menu')) closeMenu(); };
const onMenuKey = e => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
