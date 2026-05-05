// Profile management — V-073 profiles surface end-to-end.
//
// Profiles are persistent browser-state slots: cookies, localStorage,
// IndexedDB. Sessions can attach to a profile to resume a logged-in
// state across runs. The Manual ladder uses profile count as the
// tier-defining metric (Solo Manual = 10, Team Manual = 50, Agency
// Manual = 200); the API ladder also caps profiles per ADR-004.
//
// This example walks: create → list (paginated) → get → update →
// delete. Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/profile-management.ts

/* eslint-disable no-console */
import { Driftstack } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

const client = new Driftstack({ apiKey });

async function main(): Promise<void> {
  // 1. Create a fresh profile. Archetype defaults to the locked
  //    iPhone 16 Pro / iOS 18.7 / Safari 26.4 surface server-side
  //    if omitted (V-136 LOCKED_ARCHETYPE_ID).
  console.log('creating profile…');
  const created = await client.profiles.create({
    name: `demo-${Date.now().toString()}`,
    description: 'Profile-management example fixture',
  });
  console.log(`  → ${created.id}  (${created.name})`);

  // 2. List all profiles for this account, paginated.
  //    Using iterate() walks the cursor automatically — fine for
  //    accounts with up to a few hundred profiles. For very large
  //    accounts (Agency Manual = 200, API Scale = 500), prefer
  //    list({ limit }) + cursor pagination.
  console.log('listing all profiles…');
  let count = 0;
  for await (const profile of client.profiles.iterate({ limit: 50 })) {
    count += 1;
    if (count <= 5) {
      console.log(`  ${profile.id}  ${profile.name}  ${profile.archetype}`);
    }
  }
  console.log(`  → ${count.toString()} profile(s) total`);

  // 3. Fetch a single profile by id.
  console.log('fetching the new profile by id…');
  const fetched = await client.profiles.get(created.id);
  console.log(`  → ${fetched.id}  description="${fetched.description ?? ''}"`);

  // 4. Update — rename + change description. Profile-name uniqueness
  //    is scoped to (account_id, name) per D-032; renaming to a name
  //    already used by another profile in the same account would
  //    conflict with 409.
  console.log('updating profile…');
  const updated = await client.profiles.update(created.id, {
    name: `${created.name}-renamed`,
    description: 'Updated via profile-management example',
  });
  console.log(`  → ${updated.id}  new name="${updated.name}"`);

  // 5. Delete. Idempotent — calling it on a missing profile returns
  //    404, but on a profile already-deleted returns 404 too (gone).
  console.log('deleting profile…');
  await client.profiles.delete(created.id);
  console.log('  → deleted');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
