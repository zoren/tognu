import { readFile } from 'node:fs/promises';
import { ClientSecretCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { XMLParser } from 'fast-xml-parser';
import { openDb } from './db.js';

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

const SAMPLE = process.env.SAMPLE === '1';
const RETENTION_MS = 2 * 60 * 1000;
const CLEANUP_INTERVAL = 60_000;

const OVERRIDES = { 8600736: 'Flintholm' };

const db = openDb();

const upsertDeparture = db.prepare(`
  INSERT INTO departures (
    line, train_number, station_id, aimed_time, expected_time,
    destination, destination_station_id, track, updated_at
  ) VALUES (
    @line, @train_number, @station_id, @aimed_time, @expected_time,
    @destination, @destination_station_id, @track, @updated_at
  )
  ON CONFLICT(line, train_number, station_id) DO UPDATE SET
    aimed_time = excluded.aimed_time,
    expected_time = excluded.expected_time,
    destination = excluded.destination,
    destination_station_id = excluded.destination_station_id,
    track = excluded.track,
    updated_at = excluded.updated_at
`);

const upsertStation = db.prepare(`
  INSERT INTO stations (id, name) VALUES (@id, @name)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name
    WHERE excluded.name != ''
`);

const getStationName = db.prepare(`SELECT name FROM stations WHERE id = ?`);

const deleteOld = db.prepare(`
  DELETE FROM departures WHERE COALESCE(expected_time, aimed_time) < ?
`);

// One-time seed of station names from the legacy JSON cache.
try {
  const raw = await readFile(new URL('./station-names.json', import.meta.url), 'utf-8');
  const { names = {} } = JSON.parse(raw);
  const seed = db.transaction((entries) => {
    for (const [id, name] of entries) upsertStation.run({ id, name });
  });
  seed(Object.entries(names).filter(([, name]) => name));
} catch {}

async function lookupStationName(id) {
  const query = `SELECT ?l WHERE { ?s wdt:P722 "${id}" . ?s rdfs:label ?l . FILTER(LANG(?l) = "da") } LIMIT 1`;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'tognu-train-demo/0.1' },
    });
    if (!res.ok) return '';
    const data = await res.json();
    const label = data?.results?.bindings?.[0]?.l?.value;
    return label ? label.replace(/\s+Station$/, '') : '';
  } catch {
    return '';
  }
}

async function stationName(id) {
  const key = String(id);
  if (OVERRIDES[key]) return OVERRIDES[key];
  const row = getStationName.get(key);
  if (row !== undefined) return row.name || key;
  const name = await lookupStationName(key);
  upsertStation.run({ id: key, name });
  return name || key;
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
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

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return String(node);
}

async function deriveDestination(j, calls) {
  const destRef = j.DestinationRef ? String(j.DestinationRef) : null;
  const destName = textOf(j.DestinationName).trim();
  if (destName) return { destination: destName, destination_station_id: destRef };
  if (destRef) {
    return { destination: await stationName(destRef), destination_station_id: destRef };
  }
  const last = calls[calls.length - 1];
  if (last?.StopPointRef) {
    const lastId = String(last.StopPointRef);
    return { destination: await stationName(lastId), destination_station_id: lastId };
  }
  return { destination: '', destination_station_id: null };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

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
  );
  if (journeys.length === 0) return;

  if (SAMPLE) {
    console.log(JSON.stringify(journeys[0], null, 2));
    process.exit(0);
  }

  const updatedAt = new Date().toISOString();

  for (const j of journeys) {
    const calls = asArray(j.EstimatedCalls?.EstimatedCall);
    if (calls.length === 0) continue;
    const line = String(j.LineRef ?? '').trim();
    const trainNumber = String(j.TrainNumbers?.TrainNumberRef ?? '').trim();
    if (!line || !trainNumber) continue;

    const { destination, destination_station_id } = await deriveDestination(j, calls);

    const rows = [];
    for (const c of calls) {
      const stopId = String(c.StopPointRef);
      if (!stopId) continue;
      const track = extractTrack(c);
      rows.push({
        line,
        train_number: trainNumber,
        station_id: stopId,
        aimed_time: c.AimedArrivalTime ?? c.AimedDepartureTime ?? null,
        expected_time: c.ExpectedArrivalTime ?? c.ExpectedDepartureTime ?? null,
        destination,
        destination_station_id,
        track: track != null ? String(track) : null,
        updated_at: updatedAt,
      });
    }

    if (rows.length > 0) {
      const tx = db.transaction((rs) => {
        for (const r of rs) upsertDeparture.run(r);
      });
      tx(rows);
    }
  }
}

setInterval(() => {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const result = deleteOld.run(cutoff);
  if (result.changes > 0) console.log(`Pruned ${result.changes} past departures`);
}, CLEANUP_INTERVAL).unref();

const credential = new ClientSecretCredential(
  process.env.DUV_TENANT_ID,
  process.env.DUV_CLIENT_ID,
  process.env.DUV_CLIENT_SECRET,
);
const sbClient = new ServiceBusClient(process.env.DUV_NAMESPACE, credential);
const receiver = sbClient.createReceiver(process.env.DUV_TOPIC, process.env.DUV_SUBSCRIPTION);

console.log(
  `Ingesting from ${process.env.DUV_TOPIC}/${process.env.DUV_SUBSCRIPTION} (Ctrl+C to stop)`,
);

const subscription = receiver.subscribe({
  processMessage: handleMessage,
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
  try { await sbClient.close(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
