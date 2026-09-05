// Profile management — V-073 profiles surface end-to-end.
//
// Profiles are persistent browser-state slots: cookies, localStorage,
// IndexedDB. Sessions can attach to a profile to resume a logged-in
// state across runs. The Manual ladder uses profile count as the
// tier-defining metric (Personal = 10, Team = 50, Agency
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
  // 1. Create a fresh profile. Archetype defaults server-side to your tier's
  //    device if omitted: the locked iPhone 17 / iOS 18.7 / Safari 26.4
  //    surface on tiers entitled to every device (V-136 LOCKED_ARCHETYPE_ID),
  //    the newest iPhone 13 on the free tier.
  console.log('creating profile…');
  const created = await client.profiles.create({
    name: `demo-${Date.now().toString()}`,
    description: 'Profile-management example fixture',
  });
  console.log(`  → ${created.id}  (${created.name})`);

  // 2. List all profiles for this account, paginated.
  //    Using iterate() walks the cursor automatically — fine for
  //    accounts with up to a few hundred profiles. For very large
  //    accounts (Agency = 200, API Scale = 500), prefer
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

  // 5. V-313 — clone the profile. Server auto-derives "(copy)" /
  //    "(copy 2)" / ... naming when no name is supplied. Tier-cap +
  //    name-conflict are checked the same as create (429 / 409).
  console.log('cloning profile…');
  const cloned = await client.profiles.clone(updated.id);
  console.log(`  → ${cloned.id}  name="${cloned.name}"`);

  // 6. V-312 — capture an immutable point-in-time snapshot of the
  //    parent profile. The snapshot is frozen; the parent keeps
  //    evolving.
  console.log('capturing snapshot…');
  const snapshot = await client.profileSnapshots.capture(updated.id, {
    label: 'baseline',
    description: 'Captured by the profile-management example',
  });
  console.log(`  → ${snapshot.id}  label="${snapshot.label}"`);

  // 7. Restore the snapshot into a NEW profile. The original parent
  //    profile is never modified.
  console.log('restoring snapshot into a new profile…');
  const restored = await client.profileSnapshots.restore(snapshot.id, {
    name: `${updated.name}-restored`,
  });
  console.log(`  → ${restored.id}  name="${restored.name}"`);

  // 8. Cleanup — delete the snapshot, the cloned profile, the
  //    restored profile, and the original. Snapshots have no
  //    automatic lifecycle; capture as many as you want, delete
  //    when you no longer need them.
  console.log('cleaning up…');
  await client.profileSnapshots.delete(snapshot.id);
  await client.profiles.delete(restored.id);
  await client.profiles.delete(cloned.id);
  await client.profiles.delete(updated.id);
  console.log('  → cleaned up');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
