// Shared renderer state. Modules read and mutate this directly and call the
// relevant render function afterwards.

export const state = {
  settings: null,
  types: {},                    // source-type catalogue from main
  accounts: null,               // which keys / logins are configured (no secrets)
  sources: [],
  sourcesById: new Map(),
  statuses: new Map(),          // source id -> { label, isError } from the last poll
  sourceCounts: new Map(),      // source id -> items in the live list
  hiddenSources: new Set(),     // unticked in the sidebar (view filter, kept in ui.json)

  tags: { Inclusions: [], Exclusions: [] },
  activeTags: { inc: [], exc: [] },

  items: [],                    // live feed, newest -> oldest
  itemsById: new Map(),
  seenKeys: new Set(),          // url/title keys already shown (cross-source de-dup)

  mode: 'live',                 // 'live' | 'history'
  search: '', searchLower: '', caseSensitive: false,
  searchSources: new Set(),     // source chips in the search bar (see sourcesearch.js)
  autoScroll: false,
  selectedId: null,
  placeFilter: null,            // { keys, name } from the map: a place, or the places of a map cluster
  visible: [],                  // live items passing the filters (for the map)

  bias: new Map(),              // source id -> { checkedAt, outlet | null }: its political-lean lookup (bias.js)
  biasProgress: null,           // { done, total } while sources are being looked up

  tabs: [],                     // see tabs.js
  activeTabId: null,

  countdown: 0,
  refreshing: false,
};

export function setSources(list) {
  state.sources = list;
  state.sourcesById = new Map(list.map(s => [s.id, s]));
}

export function setBias(rows) {
  state.bias = new Map(rows.map(r => [r.sourceId, r]));
}

export const sourceColor = id => state.sourcesById.get(id)?.color ?? '#4A4A4A';

// Sidebar groups fall into three sections: countries (A -> Z), areas spanning
// several countries, then groups that aren't places at all. A group not listed
// below counts as a country (groups are named after countries by convention).
export const SECTIONS = [
  { key: 'countries', title: 'Countries' },
  { key: 'areas',     title: 'Areas' },
  { key: 'other',     title: 'Other' },
];
const AREA_GROUPS  = ['EU', 'Pacific Islands', 'Africa', 'International'];
const OTHER_GROUPS = ['Telegram', 'Wires & Search', 'Disasters & Health', 'Business', 'Sports'];   // kept in this order

export const sectionOf = grp => AREA_GROUPS.includes(grp) ? 'areas' : OTHER_GROUPS.includes(grp) ? 'other' : 'countries';
export const isCountryGroup = grp => sectionOf(grp) !== 'other';

/** Sources bucketed by group, as [[group, sources]] in display order (section, then name). */
export function groupSources(list) {
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.grp)) groups.set(s.grp, []);
    groups.get(s.grp).push(s);
  }
  const section = g => SECTIONS.findIndex(x => x.key === sectionOf(g));
  const other = g => OTHER_GROUPS.indexOf(g);
  return [...groups].sort(([a], [b]) => section(a) - section(b)
    || (sectionOf(a) === 'other' && other(a) - other(b))
    || a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
