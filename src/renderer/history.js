// History: articles you opened (grouped by day), or everything ever stored,
// with full-text search over titles, summaries and saved article text.

import { api, $, h, dayLabel, formatTime, debounce } from './dom.js';
import { buildRow, bindList } from './feed.js';
import { state } from './state.js';
import { ui, saveUi } from './ui.js';

const PAGE = 150;
const hist = { scope: 'opened', query: '', items: new Map(), offset: 0, done: false, loading: false, seq: 0 };

export function initHistory() {
  const list = $('history-list');
  bindList(list, id => hist.items.get(id), { preferSaved: () => !navigator.onLine });

  if (ui.historyScope === 'all' || ui.historyScope === 'opened') hist.scope = ui.historyScope;
  for (const x of document.querySelectorAll('#history-scope button')) x.classList.toggle('on', x.dataset.scope === hist.scope);
  for (const b of document.querySelectorAll('#history-scope button'))
    b.addEventListener('click', () => {
      hist.scope = b.dataset.scope;
      saveUi({ historyScope: hist.scope });
      for (const x of document.querySelectorAll('#history-scope button')) x.classList.toggle('on', x === b);
      reload();
    });

  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 600) loadMore();
  });
}

export const setHistoryQuery = debounce(q => { hist.query = q; reload(); }, 220);

export function reload() {
  hist.items.clear();
  hist.offset = 0;
  hist.done = false;
  hist.seq++;
  $('history-list').replaceChildren();
  $('history-list').scrollTop = 0;
  loadMore();
}

async function loadMore() {
  if (hist.loading || hist.done) return;
  hist.loading = true;
  const seq = hist.seq;
  try {
    const rows = await api.history({ scope: hist.scope, query: hist.query, sourceIds: [...state.searchSources], limit: PAGE, offset: hist.offset });
    if (seq !== hist.seq) return;                       // a newer search started meanwhile
    hist.offset += rows.length;
    hist.done = rows.length < PAGE;
    append(rows);
  } finally {
    if (seq === hist.seq) hist.loading = false;
    else { hist.loading = false; loadMore(); }
  }
}

function append(rows) {
  const list = $('history-list');
  let lastDay = list.lastElementChild?.dataset.day ?? null;
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const it = { ...r, saved: !!r.savedAt };
    hist.items.set(it.id, it);
    const when = hist.scope === 'opened' ? r.lastOpened : r.publishedAt;
    const day = dayLabel(when);
    if (day !== lastDay) { frag.append(h('div', { class: 'day-head', dataset: { day } }, day)); lastDay = day; }
    const extra = hist.scope === 'opened'
      ? h('span', { class: 'opened-at' }, `opened ${formatTime(r.lastOpened)}${r.opens > 1 ? ` · ${r.opens}×` : ''}`)
      : null;
    const row = buildRow(it, { extraMeta: extra });
    row.dataset.day = day;
    frag.append(row);
  }
  list.append(frag);
  const n = hist.items.size;
  $('feed-count').textContent = `${n}${hist.done ? '' : '+'}`;
  $('history-empty').hidden = n > 0;
  $('history-empty').textContent = hist.query ? 'Nothing matches that search.'
    : hist.scope === 'opened' ? 'Articles you open are recorded here, with a saved copy for offline reading.'
    : 'Nothing stored yet.';
}
