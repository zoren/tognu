import 'dotenv/config';
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

/**
 * @param {import('@azure/service-bus').ServiceBusReceivedMessage} msg
 */
function handleMessage(msg) {
  const raw = msg.body;
  const body =
    typeof raw === 'string'
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf-8')
        : String(raw);

  console.log('─'.repeat(80));
  console.log(`messageId:   ${msg.messageId ?? ''}`);
  console.log(`enqueuedAt:  ${msg.enqueuedTimeUtc?.toISOString() ?? ''}`);
  console.log(`subject:     ${msg.subject ?? ''}`);
  console.log(`contentType: ${msg.contentType ?? ''}`);

  try {
    const parsed = xmlParser.parse(body);
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.log('(failed to parse XML; showing raw body)');
    console.log(body);
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
