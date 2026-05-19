# drizzle-orm 0.38.4 — silent Date-param crash in raw `sql` templates

**Status:** workaround documented, upstream issue pending (Slice D of the
2026-05-19 scheduled-jobs incident remediation).
**Driver versions affected:** drizzle-orm 0.38.4 + postgres-js 3.4.9
(verified). Likely older + newer versions in the same minor range —
re-verify before assuming a fix.

## What happens

When a `Date` instance is interpolated into a `drizzle.execute(sql\`…\`)`
raw template literal, the call crashes with:

```
TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
string or an instance of Buffer or ArrayBuffer. Received an instance of Date
    at Buffer.byteLength (node:buffer:838)
    at reset.str (postgres/src/bytes.js:22)
    at postgres/src/connection.js:964 (Bind step)
```

The crash is deterministic. Every poller tick / route handler / repo
method that interpolates a `Date` into a raw `sql` template throws.

## Why

`drizzle-orm/postgres-js/driver.js` `construct(client, config)` performs
this swap at every `drizzle(client)` call:

```js
const transparentParser = (val) => val;
for (const type of ['1184', '1082', '1083', '1114']) {
  client.options.parsers[type] = transparentParser;
  client.options.serializers[type] = transparentParser;
}
```

OIDs 1184/1082/1083/1114 are postgres's
`timestamptz`/`date`/`time`/`timestamp`. The default postgres-js
serializer for OID 1184 is
`x => (x instanceof Date ? x : new Date(x)).toISOString()` (converts a
`Date` to an ISO string before the wire serializer runs). drizzle
replaces that with a no-op identity. The `Date` instance then reaches
postgres-js's `Bind` step (`postgres/src/connection.js:954`) where the
inner `.str(x)` calls `Buffer.byteLength(x)` — which only accepts
`string | Buffer | TypedArray`. A `Date` throws.

**Other drizzle paths are unaffected.** `db.update(table).set({ updatedAt:
new Date() })` serializes the `Date` via the column-schema metadata
_before_ the postgres-js Bind step. Only RAW `sql` template literals
hit the broken path.

## Workaround

Pre-serialize Date params to ISO strings in any raw `sql` template
literal:

```ts
// ❌ Crashes:
await db.execute(sql`SELECT id FROM scheduled_jobs WHERE run_at <= ${now}`);

// ✅ Works:
const nowIso = now.toISOString();
await db.execute(sql`SELECT id FROM scheduled_jobs WHERE run_at <= ${nowIso}`);
```

drizzle's `transparentParser` passes the ISO string through unchanged;
postgres parses it as `timestamptz` on the server side. The wire output
is identical to what postgres-js's original date.serialize would have
produced.

When a literal `Date` value is needed for arithmetic _inside_ the SQL
(e.g. `${new Date(opts.now.getTime() - 5 * 60_000)}`), hoist the
computation into a local variable, then `.toISOString()` it:

```ts
const lockStaleAtIso = new Date(opts.now.getTime() - 5 * 60_000).toISOString();
await db.execute(sql`… AND locked_at < ${lockStaleAtIso}`);
```

When you need to bind a timestamptz parameter explicitly (e.g. inside
a `sql.raw()` fragment), cast on the SQL side:

```ts
await db.execute(sql`… WHERE emitted_at >= ${sinceIso}::timestamptz`);
```

The `::timestamptz` server-side cast preserves correct type inference
when the implicit context isn't enough.

## Tracking incident

The first occurrence in this codebase was
`DrizzleScheduledJobsRepo.claimDue` — see
`apps/server/src/db/scheduled-jobs-repo.ts`. The bug ran in production
emitting warn-level TypeErrors every 60 seconds for 10 days (2026-05-09
→ 2026-05-19, 1439 occurrences in the most-recent 24h before fix)
because:

1. The wrapper `{ name: err.name, message: err.message }` in poller
   error logs lost the original Error reference, so Pino's
   stdSerializers couldn't extract the stack — every log line showed
   `stack: ""` empty. Fix: commit `5d7d7348` extended the wrapper
   project-wide to include `stack: err.stack, cause: err.cause` across
   18 call sites in 8 files.
2. The integration test (`trial-pack-expiry.test.ts`) used
   `InMemoryScheduledJobsRepo` and never exercised the Drizzle code
   path. Fix: commit `d4524c4f` added a Drizzle-backed integration
   test against real Postgres that exercises the exact prod hot path
   and would have caught the bug.
3. The fix itself: commit `1b2001c8` pre-serialized 5 Date params in
   `claimDue` to ISO strings via `.toISOString()`.

## Prevention

- Audit any new raw `sql` template literal for `${date}` interpolation
  before merge. Use the ISO-string pattern from the start.
- New Drizzle-backed integration tests (per
  `apps/server/tests/integration/db-scheduled-jobs-repo-drizzle.test.ts`
  - `apps/server/tests/integration/atlas-priority-events-end-to-end.
test.ts`) MUST run against real Postgres in CI's build-test job —
    never InMemoryRepo for the regression-guard layer.

## Upstream

File issue at `github.com/drizzle-team/drizzle-orm`. Suggested title:
"postgres-js driver: transparentParser swap of OID 1184 serializer
crashes on Date params in raw sql template". Re-verify on the latest
release before filing — if 0.39+ fixed this, version-bump instead.

## Quick check for new code

The full grep-able rule: any `sql\`` template literal interpolation
that COULD be a `Date`must be`.toISOString()`'d at the call site,
not at the parameter source. Trust no one upstream to keep their hands
off the serializers map.
