import { readFile, writeFile } from 'node:fs/promises';
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
const seen = new Map();

const CACHE_URL = new URL('./station-names.json', import.meta.url);
const OVERRIDES = { 8600736: 'Flintholm' };
const names = new Map();
try {
  const raw = await readFile(CACHE_URL, 'utf-8');
  for (const [k, v] of Object.entries(JSON.parse(raw))) names.set(k, v);
} catch {}

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
    await writeFile(CACHE_URL, JSON.stringify(Object.fromEntries(names), null, 2));
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

  for (const j of journeys) {
    const train = String(j.TrainNumbers?.TrainNumberRef ?? '?').padStart(6);
    for (const c of asArray(j.EstimatedCalls?.EstimatedCall)) {
      const aimedIso = c.AimedArrivalTime ?? c.AimedDepartureTime;
      const expIso = c.ExpectedArrivalTime ?? c.ExpectedDepartureTime;
      const state = expIso ?? aimedIso ?? '';
      const key = `${train}:${c.StopPointRef}`;
      if (seen.get(key) === state) continue;
      seen.set(key, state);
      const d = delayMin(aimedIso, expIso);
      const delayStr = d === 0 ? '' : `  ${d > 0 ? '+' : ''}${d}m`;
      const stop = (await stationName(c.StopPointRef)).padEnd(15);
      console.log(
        `${enqueued}  F ${train}  →  ${stop}  ${fmtTime(aimedIso)}${delayStr}`,
      );
    }
  }
}

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
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
