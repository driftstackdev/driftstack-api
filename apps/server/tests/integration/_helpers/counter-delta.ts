// WHY THERE IS NO GUARD FORCING EVERY COUNTER DELTA THROUGH THIS HELPER.
//
// V-1273 closed the fifth file in this class and observed that it has no boundary at which "all
// found" can be asserted — which is normally the argument for a guard. One was prototyped and
// measured before being written, and it is not buildable at acceptable precision.
//
// The signature is "a bare before/after delta on an unfiltered count". Three hits, and only one is
// a defect:
//
//   admin-accounts-list-repo-contract  EXACT delta — but safe, because V-1245 dates its fixtures
//                                      into the far future so the window excludes every other
//                                      file's rows. Scoped by anchor rather than by filter.
//   db-admin-accounts-repo-drizzle     TOLERANT `>=` — safe by construction, and its own title
//                                      says so: a delta around a seed, because the table is
//                                      shared with every other db-* file running concurrently.
//   (the five already converted)       genuinely racy, and now use this helper.
//
// So the class has THREE legitimate mitigations — anchor the window, tolerate with `>=`, or
// detect-and-retry here — and "bare delta on a count" cannot tell which one is in force. A guard
// on that signature would flag two pieces of correct code and push toward replacing a cheaper
// correct mitigation with this heavier one. Same conclusion, and the same reason, as the
// repo-to-repo constant guard rejected in V-1267: a signal that cannot tell two things apart is
// not a weaker guard, it is a wrong one.

// V-1264 — one detect-and-retry measurement for unfiltered, table-wide counters.
//
// Three contracts now measure a counter that takes no filter and counts the whole table:
// `countByStatus` and `countByTier` on accounts (V-1248), and
// `countActiveSubscriptionsByTier` on subscriptions. A plain before/after delta around a seed
// races every other test file writing that table, and the failure is a wrong NUMBER rather than
// an error — `expected +0 to be 1` when a concurrent sweep deleted a row inside the window.
//
// This lived inside the admin-accounts contract. A second contract needing it is the moment to
// give it one home rather than a second copy, which is the same rule this campaign has been
// applying to production constants all session.

/**
 * V-1248 — `countByStatus` and `countByTier` take no filter at all: they count the whole table.
 * A delta measured around a seed therefore races every other test file writing to `accounts`,
 * and unlike `countCreatedSince` there is no time parameter to anchor the window past them.
 *
 * What CAN be done is detect the interference rather than hope it away. A clean measurement has
 * a known shape — the bucket I seeded moves by exactly the amount I seeded, and every other
 * bucket does not move at all. Any other vector means somebody else wrote inside my window, so
 * the reading is discarded and the whole arm re-run on fresh fixtures.
 *
 * After `ATTEMPTS` dirty readings it FAILS, and the message carries the observed vector — which
 * is the difference between "this counter is broken" and "this database was too busy to measure",
 * a distinction the previous version could not make and reported as the former.
 */
export const ATTEMPTS = 5;

export async function cleanDelta<K extends string>(
  read: () => Promise<Record<K, number>>,
  seed: () => Promise<void>,
  expected: Partial<Record<K, number>>,
  /**
   * V-1261 — buckets left UNCONSTRAINED because other test files write them constantly.
   *
   * `accounts.status` defaults to 'active' and `accounts.tier` to 'free', and nearly every
   * fixture in the suite inserts `(id, email)` and takes those defaults. Under a thirty-file
   * contract run those two buckets move inside essentially every measurement window, so
   * requiring them to sit still is requiring the rest of the suite to stop working — the arm
   * failed about one run in five, always reporting VARIED deltas, which is the helper
   * correctly identifying interference rather than a miscount.
   *
   * Ignoring them costs less than it looks: an implementation that ignored its filter would
   * move the buckets that are still constrained, so the property the arm exists for survives.
   */
  // Typed on `string`, not `K`: as `ReadonlySet<K>` it drove the inference of K and narrowed
  // it to whatever the ignore set contained, which made `expected` reject its own keys.
  ignore: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
  const seen: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const before = await read();
    await seed();
    const after = await read();

    const delta = {} as Record<K, number>;
    for (const k of Object.keys(after) as K[]) delta[k] = after[k] - before[k];

    const dirty = (Object.keys(delta) as K[])
      .filter((k) => !ignore.has(k))
      .filter((k) => delta[k] !== (expected[k] ?? 0));
    if (dirty.length === 0) return;
    seen.push(
      dirty.map((k) => `${k}: ${String(delta[k])} (want ${String(expected[k] ?? 0)})`).join(', '),
    );
  }

  // Which of the two it is can be READ OFF the attempts rather than guessed. A dirty vector that
  // is identical every time is deterministic, so it is the counter miscounting; one that varies
  // is another writer landing inside the window. Saying "a concurrent writer moved a bucket"
  // unconditionally would blame the database for a genuine defect — the exact misattribution
  // this contract exists to catch elsewhere, and what the first version of this message did.
  const stable = seen.every((v) => v === seen[0]);
  throw new Error(
    stable
      ? `the counter is MISCOUNTING: the same wrong delta appeared in all ${String(ATTEMPTS)} ` +
          `attempts, which no concurrent writer would reproduce exactly. Delta: ${seen[0] ?? ''}`
      : `no clean reading in ${String(ATTEMPTS)} attempts. These counters are unfiltered and ` +
          `table-wide, and the deltas VARIED between attempts, so another writer landed inside ` +
          `every measurement window: ${seen.join(' | ')}`,
  );
}
