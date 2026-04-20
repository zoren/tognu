import './styles.css';

/**
 * @typedef {Object} Departure
 * @property {string} line
 * @property {string} trainNumber
 * @property {string} aimedTime           ISO timestamp
 * @property {string|null} expectedTime   ISO timestamp, null if not yet estimated
 * @property {string} destination
 * @property {string|null} track
 * @property {string} stationId
 * @property {'north'|'south'} direction
 */

/** @typedef {Record<string, Departure[]>} State */

/** @typedef {'connecting'|'open'|'closed'} ConnState */

const STATIONS = /** @type {const} */ ([
  { id: '8600642', name: 'Nørrebro' },
  { id: '8600783', name: 'København Syd' },
]);

/** @type {State} */
let state = {};
/** @type {string} */
let currentStationId = STATIONS[0].id;
/** @type {ConnState} */
let connState = 'connecting';
/** @type {number} */
let now = Date.now();

/**
 * Tiny DOM builder.
 * @param {string} tag
 * @param {Record<string, string|number|boolean|EventListener>} [attrs]
 * @param {...(Node|string|null|undefined|Array<Node|string|null|undefined>)} children
 * @returns {HTMLElement}
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), /** @type {EventListener} */ (v));
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

/**
 * @param {Departure} d
 * @returns {number}
 */
function departureEpoch(d) {
  return new Date(d.expectedTime || d.aimedTime).getTime();
}

/**
 * @param {State} s
 * @param {string} stationId
 * @returns {Departure[]}
 */
function upcomingDepartures(s, stationId) {
  const list = s[stationId] ?? [];
  return list
    .filter((d) => {
      const t = departureEpoch(d);
      return !Number.isNaN(t) && t >= now - 60_000;
    })
    .sort((a, b) => departureEpoch(a) - departureEpoch(b))
    .slice(0, 14);
}

/**
 * @param {Departure} d
 * @returns {HTMLElement}
 */
function renderRow(d) {
  const target = departureEpoch(d);
  const minutes = Math.max(0, Math.round((target - now) / 60_000));
  const delayMin = d.expectedTime
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
    el('span', { class: 'dest' }, d.destination),
    el('span', { class: 'track' }, d.track ?? '–'),
  );
}

/** @returns {HTMLElement} */
function renderApp() {
  const station = STATIONS.find((s) => s.id === currentStationId) ?? STATIONS[0];
  const upcoming = upcomingDepartures(state, currentStationId);
  const statusText =
    connState === 'open'
      ? 'Ingen kommende afgange'
      : connState === 'connecting'
        ? 'Forbinder…'
        : 'Ingen forbindelse';

  return el(
    'main',
    { class: 'app' },

    el(
      'section',
      { class: 'station' },
      el(
        'div',
        { class: 's-logo', 'aria-hidden': 'true' },
        el('span', {}, 'S'),
      ),
      el('h1', {}, station.name),
      el(
        'button',
        { type: 'button', class: 'bookmark', 'aria-label': 'Gem station' },
        bookmarkIcon(),
      ),
    ),

    el(
      'div',
      { class: 'picker', role: 'tablist', 'aria-label': 'Vælg station' },
      STATIONS.map((s) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': s.id === currentStationId ? 'true' : 'false',
            class: s.id === currentStationId ? 'active' : '',
            onclick: () => {
              currentStationId = s.id;
              render();
            },
          },
          s.name,
        ),
      ),
    ),

    el(
      'div',
      { class: 'table-head' },
      el('span', {}, 'Linje'),
      el('span', {}, 'Om min.'),
      el('span', {}, 'Til'),
      el('span', {}, 'Spor'),
    ),

    el(
      'ul',
      { class: 'rows' },
      upcoming.length === 0
        ? el('li', { class: 'empty' }, statusText)
        : upcoming.map(renderRow),
    ),

    el(
      'footer',
      { class: 'bottom-nav', 'aria-hidden': 'true' },
      navItem('⌂', 'Hjem', false),
      navItem('◎', 'Find Tog', false),
      navItem('⚲', 'Søg Station', true),
      navItem('⚙', 'Indstillinger', false),
    ),
  );
}

/** @returns {SVGElement} */
function bookmarkIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 3h12v18l-6-4-6 4V3z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/**
 * @param {string} icon
 * @param {string} label
 * @param {boolean} active
 * @returns {HTMLElement}
 */
function navItem(icon, label, active) {
  return el(
    'div',
    { class: active ? 'nav-item active' : 'nav-item' },
    el('span', { class: 'nav-icon' }, icon),
    el('span', {}, label),
  );
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  root.replaceChildren(renderApp());
}

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    connState = 'open';
    render();
  };
  es.onerror = () => {
    connState = 'closed';
    render();
  };
  es.onmessage = (e) => {
    try {
      state = JSON.parse(e.data);
      render();
    } catch {}
  };
}

render();
connect();
setInterval(() => {
  now = Date.now();
  render();
}, 15_000);
