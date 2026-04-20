import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientSecretCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { XMLParser } from 'fast-xml-parser';

const required = [
  'DUV_TENANT_ID',
  'DUV_CLIENT_ID',
  'DUV_CLIENT_SECRET',
  'DUV_NAMESPACE',
  'DUV_TOPIC',
  'DUV_SUBSCRIPTION',
];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

const credential = new ClientSecretCredential(
  process.env.DUV_TENANT_ID,
  process.env.DUV_CLIENT_ID,
  process.env.DUV_CLIENT_SECRET,
);
const client = new ServiceBusClient(process.env.DUV_NAMESPACE, credential);
const receiver = client.createReceiver(process.env.DUV_TOPIC, process.env.DUV_SUBSCRIPTION);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

const SAMPLE = process.env.SAMPLE === '1';
const PORT = Number(process.env.PORT ?? 8080);
const seen = new Map();

const CACHE_URL = new URL('./station-names.json', import.meta.url);
const OVERRIDES = { 8600736: 'Flintholm' };
const NØRREBRO = '8600642';
const KBH_SYD = '8600783';
const HELLERUP = '8600655';

let F_LINE_ORDER = [];
const names = new Map();
try {
  const raw = await readFile(CACHE_URL, 'utf-8');
  const { order = [], names: cachedNames = {} } = JSON.parse(raw);
  F_LINE_ORDER = order;
  for (const [k, v] of Object.entries(cachedNames)) names.set(k, v);
} catch {}

// Station state: stationId -> Map<trainKey, departure>
const stations = new Map();
const sseClients = new Set();

function snapshot() {
  const out = {};
  for (const [stationId, deps] of stations) {
    out[stationId] = Array.from(deps.values());
  }
  return out;
}

function broadcast() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function upsertDeparture(stationId, key, dep) {
  let deps = stations.get(stationId);
  if (!deps) {
    deps = new Map();
    stations.set(stationId, deps);
  }
  deps.set(key, dep);
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 1000;
  let changed = false;
  for (const deps of stations.values()) {
    for (const [key, dep] of deps) {
      const t = new Date(dep.expectedTime || dep.aimedTime).getTime();
      if (Number.isNaN(t) || t < cutoff) {
        deps.delete(key);
        changed = true;
      }
    }
  }
  if (changed) broadcast();
}, 30_000).unref();

function journeyDirection(calls) {
  const indices = calls
    .map((c) => F_LINE_ORDER.indexOf(String(c.StopPointRef)))
    .filter((i) => i >= 0);
  if (indices.length < 2) return null;
  return indices[indices.length - 1] > indices[0] ? 'north' : 'south';
}

async function stationName(id) {
  if (OVERRIDES[id]) return OVERRIDES[id];
  const key = String(id);
  if (names.has(key)) return names.get(key) || key;
  const query = `SELECT ?l WHERE { ?s wdt:P722 "${key}" . ?s rdfs:label ?l . FILTER(LANG(?l) = "da") } LIMIT 1`;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`;
  let name = '';
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'tognu-train-demo/0.1' },
    });
    if (res.ok) {
      const data = await res.json();
      const label = data?.results?.bindings?.[0]?.l?.value;
      if (label) name = label.replace(/\s+Station$/, '');
    }
  } catch {}
  names.set(key, name);
  try {
    await writeFile(
      CACHE_URL,
      JSON.stringify({ order: F_LINE_ORDER, names: Object.fromEntries(names) }, null, 2),
    );
  } catch {}
  return name || key;
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('da-DK', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function delayMin(aimedIso, expectedIso) {
  if (!aimedIso || !expectedIso) return 0;
  return Math.round((new Date(expectedIso) - new Date(aimedIso)) / 60000);
}

function extractTrack(c) {
  return (
    c.DeparturePlatformName ??
    c.ArrivalPlatformName ??
    c.DepartureStopAssignment?.AimedQuayName ??
    c.ArrivalStopAssignment?.AimedQuayName ??
    null
  );
}

/**
 * @param {import('@azure/service-bus').ServiceBusReceivedMessage} msg
 */
async function handleMessage(msg) {
  const raw = msg.body;
  const body =
    typeof raw === 'string'
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf-8')
        : String(raw);

  let parsed;
  try {
    parsed = xmlParser.parse(body);
  } catch {
    return;
  }

  const journeys = asArray(
    parsed?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery
      ?.EstimatedJourneyVersionFrame?.EstimatedVehicleJourney,
  ).filter((j) => j.LineRef === 'F');

  if (journeys.length === 0) return;

  if (SAMPLE) {
    console.log(JSON.stringify(journeys[0], null, 2));
    process.exit(0);
  }

  const enqueued = fmtTime(msg.enqueuedTimeUtc?.toISOString());
  let changed = false;

  for (const j of journeys) {
    const calls = asArray(j.EstimatedCalls?.EstimatedCall);
    const dir = journeyDirection(calls);
    if (!dir) continue;
    const trainNumber = String(j.TrainNumbers?.TrainNumberRef ?? '?');
    const train = trainNumber.padStart(6);
    for (const c of calls) {
      const stopId = String(c.StopPointRef);
      if (stopId !== NØRREBRO && !(stopId === KBH_SYD && dir === 'north')) continue;
      const aimedIso = c.AimedArrivalTime ?? c.AimedDepartureTime ?? null;
      const expIso = c.ExpectedArrivalTime ?? c.ExpectedDepartureTime ?? null;
      const state = expIso ?? aimedIso ?? '';
      const key = `${train}:${c.StopPointRef}`;
      if (seen.get(key) === state) continue;
      seen.set(key, state);
      changed = true;

      const destStationId = dir === 'north' ? HELLERUP : KBH_SYD;
      const destination = await stationName(destStationId);
      const track = extractTrack(c);

      upsertDeparture(stopId, key, {
        line: 'F',
        trainNumber: trainNumber.trim(),
        aimedTime: aimedIso,
        expectedTime: expIso,
        destination,
        track: track ? String(track) : null,
        stationId: stopId,
        direction: dir,
      });

      const d = delayMin(aimedIso, expIso);
      const delayStr = d === 0 ? '' : `  ${d > 0 ? '+' : ''}${d}m`;
      const stopName = await stationName(c.StopPointRef);
      const display =
        stopId === NØRREBRO ? `${stopName} → ${destination}` : stopName;
      const stop = display.padEnd(25);
      console.log(
        `${enqueued}  F ${train}  →  ${stop}  ${fmtTime(aimedIso)}${delayStr}`,
      );
    }
  }

  if (changed) broadcast();
}

// ---- HTTP server (static + API) -----------------------------------------

const DIST_DIR = fileURLToPath(new URL('./dist/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const safe = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const rel = safe === '/' || safe === '' ? 'index.html' : safe.replace(/^\/+/, '');
  const filePath = join(DIST_DIR, rel);
  if (!filePath.startsWith(DIST_DIR + sep) && filePath !== join(DIST_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isFile()) {
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      createReadStream(filePath).pipe(res);
      return;
    }
  } catch {}
  // SPA fallback
  try {
    const fallback = join(DIST_DIR, 'index.html');
    const s = await stat(fallback);
    if (s.isFile()) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      createReadStream(fallback).pipe(res);
      return;
    }
  } catch {}
  res.writeHead(404).end('Not Found');
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end();
    return;
  }
  if (req.url === '/api/state') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (req.url === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    const cleanup = () => {
      clearInterval(ping);
      sseClients.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  await serveStatic(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`HTTP listening on http://localhost:${PORT}`);
});

// ---- SIRI subscription ---------------------------------------------------

console.log(
  `Listening on ${process.env.DUV_TOPIC}/${process.env.DUV_SUBSCRIPTION} (Ctrl+C to stop)`,
);

const subscription = receiver.subscribe({
  processMessage: async (msg) => handleMessage(msg),
  processError: async (args) => {
    console.error(`Error from ${args.entityPath}:`, args.error);
  },
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  try { await subscription.close(); } catch {}
  try { await receiver.close(); } catch {}
  try { await client.close(); } catch {}
  try { httpServer.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
