import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const PORT = Number(process.env.PORT ?? 8080);
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL ?? 3000);

const db = openDb();

const queryByStation = db.prepare(`
  SELECT
    line,
    train_number     AS trainNumber,
    station_id       AS stationId,
    aimed_time       AS aimedTime,
    expected_time    AS expectedTime,
    destination,
    destination_station_id AS destinationStationId,
    track
  FROM departures
  WHERE station_id = ?
  ORDER BY COALESCE(expected_time, aimed_time)
`);

const queryStations = db.prepare(`SELECT id, name FROM stations ORDER BY name`);

function parseStations(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function snapshot(stationIds) {
  const out = {};
  for (const id of stationIds) out[id] = queryByStation.all(id);
  return out;
}

const sseClients = new Map(); // res -> { stations: string[], lastPayload: string }

setInterval(() => {
  for (const [res, info] of sseClients) {
    const data = JSON.stringify(snapshot(info.stations));
    if (data !== info.lastPayload) {
      info.lastPayload = data;
      res.write(`data: ${data}\n\n`);
    }
  }
}, POLL_INTERVAL).unref();

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
  if (!filePath.startsWith(DIST_DIR)) {
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
  if (!extname(rel)) {
    try {
      const fallback = join(DIST_DIR, 'index.html');
      const s = await stat(fallback);
      if (s.isFile()) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        createReadStream(fallback).pipe(res);
        return;
      }
    } catch {}
  }
  res.writeHead(404).end('Not Found');
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/stations') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(JSON.stringify(queryStations.all()));
    return;
  }

  if (url.pathname === '/api/state') {
    const stations = parseStations(url.searchParams.get('stations'));
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(JSON.stringify(snapshot(stations)));
    return;
  }

  if (url.pathname === '/api/stream') {
    const stations = parseStations(url.searchParams.get('stations'));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const initial = JSON.stringify(snapshot(stations));
    res.write(`data: ${initial}\n\n`);
    sseClients.set(res, { stations, lastPayload: initial });
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

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  try { httpServer.close(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
