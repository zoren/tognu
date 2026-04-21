import './styles.css';

/**
 * @typedef {Object} Departure
 * @property {string} line
 * @property {string} trainNumber
 * @property {string|null} aimedTime
 * @property {string|null} expectedTime
 * @property {string} destination
 * @property {string|null} destinationStationId
 * @property {string|null} track
 * @property {string} stationId
 */

/** @typedef {Record<string, Departure[]>} State */
/** @typedef {{id: string, name: string}} Station */

const FAVORITES_KEY = 'tognu.favorites';

/** @type {string[]} */
let favorites = loadFavorites();
/** @type {Station[]} */
let allStations = [];
/** @type {State} */
let state = {};
let connState = /** @type {'connecting'|'open'|'closed'} */ ('connecting');
let now = Date.now();
let search = '';
/** @type {EventSource|null} */
let es = null;

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

function addFavorite(id) {
  if (favorites.includes(id)) return;
  favorites = [...favorites, id];
  saveFavorites();
  search = '';
  if (searchInput) searchInput.value = '';
  reconnect();
  renderList();
}

function removeFavorite(id) {
  favorites = favorites.filter((x) => x !== id);
  saveFavorites();
  delete state[id];
  reconnect();
  renderList();
}

function reconnect() {
  if (es) {
    es.close();
    es = null;
  }
  if (favorites.length === 0) {
    connState = 'open';
    return;
  }
  connState = 'connecting';
  const qs = new URLSearchParams({ stations: favorites.join(',') }).toString();
  es = new EventSource(`/api/stream?${qs}`);
  es.onopen = () => {
    connState = 'open';
    renderList();
  };
  es.onerror = () => {
    connState = 'closed';
    renderList();
  };
  es.onmessage = (e) => {
    try {
      state = JSON.parse(e.data);
      renderList();
    } catch {}
  };
}

async function loadStations() {
  try {
    const res = await fetch('/api/stations');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      allStations = data.filter((s) => s && s.id);
      renderList();
    }
  } catch {}
}

function nameOf(id) {
  const hit = allStations.find((s) => s.id === id);
  return hit?.name || id;
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** @param {Departure} d */
function departureEpoch(d) {
  return new Date(d.expectedTime || d.aimedTime || 0).getTime();
}

/** @param {Departure[]} list */
function upcoming(list) {
  return list
    .filter((d) => {
      const t = departureEpoch(d);
      return t > 0 && t >= now - 60_000;
    })
    .sort((a, b) => departureEpoch(a) - departureEpoch(b))
    .slice(0, 10);
}

/** @param {Departure} d */
function renderRow(d) {
  const target = departureEpoch(d);
  const minutes = Math.max(0, Math.round((target - now) / 60_000));
  const delayMin = d.expectedTime && d.aimedTime
    ? Math.round((new Date(d.expectedTime).getTime() - new Date(d.aimedTime).getTime()) / 60_000)
    : 0;
  return el(
    'li',
    { class: 'row' },
    el('span', { class: `line line-${d.line}` }, d.line),
    el(
      'span',
      { class: 'mins' },
      String(minutes),
      el('span', { class: 'min-label' }, ' min'),
      delayMin > 0 ? el('span', { class: 'delay' }, ` +${delayMin}`) : null,
    ),
    el('span', { class: 'dest' }, d.destination || '–'),
    el('span', { class: 'track' }, d.track ?? '–'),
  );
}

/** @param {string} stationId */
function renderStation(stationId) {
  const list = upcoming(state[stationId] ?? []);
  const status =
    connState === 'connecting'
      ? 'Forbinder…'
      : connState === 'closed'
        ? 'Ingen forbindelse'
        : 'Ingen kommende afgange';
  return el(
    'section',
    { class: 'station-card' },
    el(
      'header',
      { class: 'station-head' },
      el('h2', {}, nameOf(stationId)),
      el(
        'button',
        {
          type: 'button',
          class: 'remove',
          title: 'Fjern',
          'aria-label': 'Fjern',
          onclick: () => removeFavorite(stationId),
        },
        '×',
      ),
    ),
    el(
      'ul',
      { class: 'rows' },
      list.length === 0
        ? el('li', { class: 'empty' }, status)
        : list.map(renderRow),
    ),
  );
}

function renderSearchResults() {
  const q = search.trim().toLowerCase();
  if (!q) return null;
  const matches = allStations
    .filter((s) => s.name && s.name.toLowerCase().includes(q))
    .slice(0, 10);
  return el(
    'ul',
    { class: 'search-results' },
    matches.length === 0
      ? el('li', { class: 'empty' }, 'Ingen stationer fundet')
      : matches.map((s) => {
          const added = favorites.includes(s.id);
          return el(
            'li',
            {},
            el(
              'button',
              {
                type: 'button',
                class: 'search-result' + (added ? ' added' : ''),
                disabled: added,
                onclick: () => addFavorite(s.id),
              },
              s.name,
              added ? el('span', { class: 'badge' }, 'tilføjet') : null,
            ),
          );
        }),
  );
}

/** @type {HTMLInputElement|null} */
let searchInput = null;
/** @type {HTMLElement|null} */
let listRoot = null;

function buildShell() {
  searchInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Søg station…',
      autocomplete: 'off',
      'aria-label': 'Søg station',
      oninput: (e) => {
        search = /** @type {HTMLInputElement} */ (e.target).value;
        renderList();
      },
    })
  );
  listRoot = el('div', { class: 'list' });
  const main = el(
    'main',
    { class: 'app' },
    el('header', { class: 'top' }, el('h1', {}, 'S-tog'), searchInput),
    listRoot,
  );
  const root = document.getElementById('app');
  if (root) root.replaceChildren(main);
}

function renderList() {
  if (!listRoot) return;
  const children = [];
  const results = renderSearchResults();
  if (results) children.push(results);
  if (favorites.length === 0 && !search.trim()) {
    children.push(
      el(
        'p',
        { class: 'hint' },
        'Søg efter en station ovenfor og vælg den for at tilføje til dine favoritter.',
      ),
    );
  } else {
    for (const id of favorites) children.push(renderStation(id));
  }
  listRoot.replaceChildren(...children);
}

buildShell();
renderList();
loadStations();
reconnect();
setInterval(() => {
  now = Date.now();
  renderList();
}, 15_000);
