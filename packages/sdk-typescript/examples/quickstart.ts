// Quickstart: drive a Driftstack session end-to-end.
//
// Run with: DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/quickstart.ts

/* eslint-disable no-console */
import { Driftstack } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

const client = new Driftstack({ apiKey });

async function main(): Promise<void> {
  console.log('creating session…');
  const session = await client.sessions.create({ label: 'quickstart' });
  console.log('  →', session.id);

  console.log('navigating to https://example.com…');
  const nav = await client.sessions.navigate(session.id, {
    url: 'https://example.com',
    wait_until: 'load',
  });
  console.log(`  → status ${nav.status.toString()}, ${nav.duration_ms.toString()}ms`);

  console.log('capturing screenshot…');
  const shot = await client.sessions.capture(session.id, { kind: 'screenshot', full_page: false });
  console.log(`  → ${shot.byte_size.toString()} bytes (${shot.encoding})`);

  console.log('destroying session…');
  await client.sessions.destroy(session.id);
  console.log('  → done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
