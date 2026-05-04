// Pagination: walk every session and every webhook delivery using
// the SDK's async iterators. The iterators (V-118 + V-119) handle
// cursor handoff automatically — consumer code reads as a normal
// `for await` loop.
//
// Run with: DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/pagination.ts

/* eslint-disable no-console */
import { Driftstack } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

const client = new Driftstack({ apiKey });

async function listAllSessions(): Promise<void> {
  console.log('listing every session for the calling account…');
  let count = 0;
  for await (const session of client.sessions.iterate({ limit: 50 })) {
    count += 1;
    if (count <= 5) {
      console.log(`  ${session.id}  ${session.status}  ${session.archetype}`);
    }
  }
  console.log(`  → ${count.toString()} session(s) total`);
}

async function listProfiles(): Promise<void> {
  console.log('listing every profile for the calling account…');
  const names: string[] = [];
  for await (const profile of client.profiles.iterate()) {
    names.push(profile.name);
  }
  console.log(`  → profiles: ${names.length === 0 ? '(none)' : names.join(', ')}`);
}

async function dlqDeliveriesForFirstWebhook(): Promise<void> {
  console.log('finding first webhook endpoint…');
  const endpoints = await client.webhooks.list();
  const first = endpoints.data[0];
  if (first === undefined) {
    console.log('  → no webhook endpoints configured; skipping delivery walk');
    return;
  }
  console.log(`  → ${first.id} (${first.url})`);

  console.log('walking dead-letter-queue deliveries…');
  let dlqCount = 0;
  for await (const delivery of client.webhooks.iterateDeliveries(first.id, {
    status: 'dlq',
    limit: 100,
  })) {
    dlqCount += 1;
    if (dlqCount <= 3) {
      console.log(`  ${delivery.id}  ${delivery.event_type}  attempts=${delivery.attempts}`);
    }
  }
  console.log(`  → ${dlqCount.toString()} DLQ deliveries total`);
}

async function main(): Promise<void> {
  await listAllSessions();
  await listProfiles();
  await dlqDeliveriesForFirstWebhook();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
