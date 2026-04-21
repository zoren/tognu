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

const upsertJourney = db.prepare(`
  INSERT INTO journeys (
    line, train_number, journey_key, data, earliest_time, latest_time, received_at
  ) VALUES (
    @line, @train_number, @journey_key, @data, @earliest_time, @latest_time, @received_at
  )
  ON CONFLICT(line, train_number, journey_key) DO UPDATE SET
    data = excluded.data,
    earliest_time = excluded.earliest_time,
    latest_time = excluded.latest_time,
    received_at = excluded.received_at
`);

const upsertStation = db.prepare(`
  INSERT INTO stations (id, name) VALUES (@id, @name)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name
    WHERE excluded.name != ''
`);

const getStationName = db.prepare(`SELECT name FROM stations WHERE id = ?`);

const deleteOld = db.prepare(`
  DELETE FROM journeys WHERE latest_time < ?
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

async function ensureStationName(id) {
  const key = String(id);
  if (OVERRIDES[key]) {
    upsertStation.run({ id: key, name: OVERRIDES[key] });
    return;
  }
  if (getStationName.get(key) !== undefined) return;
  const name = await lookupStationName(key);
  upsertStation.run({ id: key, name });
}

function callTime(c) {
  return (
    c.ExpectedDepartureTime ??
    c.ExpectedArrivalTime ??
    c.AimedDepartureTime ??
    c.AimedArrivalTime ??
    null
  );
}

function deriveJourneyKey(j, calls) {
  const datedRef =
    j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef ??
    j.DatedVehicleJourneyRef ??
    null;
  if (datedRef) return String(datedRef);
  const first = calls[0];
  const t = first?.AimedDepartureTime ?? first?.AimedArrivalTime ?? null;
  return t ? String(t) : '';
}

function spanOfCalls(calls) {
  let earliest = null;
  let latest = null;
  for (const c of calls) {
    const t = callTime(c);
    if (!t) continue;
    if (earliest === null || t < earliest) earliest = t;
    if (latest === null || t > latest) latest = t;
  }
  return { earliest, latest };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  isArray: (name) => name === 'EstimatedCall' || name === 'EstimatedVehicleJourney',
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

  const journeys =
    parsed?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery
      ?.EstimatedJourneyVersionFrame?.EstimatedVehicleJourney ?? [];
  if (journeys.length === 0) return;

  if (SAMPLE) {
    console.log(JSON.stringify(journeys[0], null, 2));
    process.exit(0);
  }

  const receivedAt = (msg.enqueuedTimeUtc?.toISOString?.() ?? new Date().toISOString());
  const stopIdsToResolve = new Set();
  const rows = [];

  for (const j of journeys) {
    const calls = j.EstimatedCalls?.EstimatedCall ?? [];
    if (calls.length === 0) continue;
    const line = String(j.LineRef ?? '').trim();
    const trainNumber = String(j.TrainNumbers?.TrainNumberRef ?? '').trim();
    if (!line || !trainNumber) continue;
    const journeyKey = deriveJourneyKey(j, calls);
    if (!journeyKey) continue;
    const { earliest, latest } = spanOfCalls(calls);
    rows.push({
      line,
      train_number: trainNumber,
      journey_key: journeyKey,
      data: JSON.stringify(j),
      earliest_time: earliest,
      latest_time: latest,
      received_at: receivedAt,
    });
    for (const c of calls) {
      if (c.StopPointRef != null) stopIdsToResolve.add(String(c.StopPointRef));
    }
    if (j.DestinationRef != null) stopIdsToResolve.add(String(j.DestinationRef));
    if (j.OriginRef != null) stopIdsToResolve.add(String(j.OriginRef));
  }

  if (rows.length > 0) {
    const tx = db.transaction((rs) => {
      for (const r of rs) upsertJourney.run(r);
    });
    tx(rows);
  }

  for (const id of stopIdsToResolve) {
    await ensureStationName(id);
  }
}

setInterval(() => {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const result = deleteOld.run(cutoff);
  if (result.changes > 0) console.log(`Pruned ${result.changes} past journeys`);
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
