// A repo read whose row count is a property of the TABLE, not of its arguments.
//
// 165 repo methods run a SELECT. Most are bounded by something: a `.limit()`, an
// aggregate that returns one row, or an equality on an id the caller supplied.
// Twelve are bounded by nothing the caller controls — they load whatever the
// table happens to hold, into memory, in one array. That is fine at launch
// scale and it is a page-out at some later scale, and the difference between
// the two is invisible in review because the code reads identically.
//
// Most of the twelve are fine for a reason that has nothing to do with the
// query: the table only grows when an operator adds a row. What this pins is
// which ones those are, so the thirteenth has to be classified rather than
// merged.
//
// FOUR ARE NOT IN THAT CATEGORY, and they are the reason this exists:
//
//   status-subscribers listConfirmed      the incident fan-out list. Signup is
//                                         on the public status page, so this
//                                         grows with the internet, not with
//                                         staff. Every confirmed subscriber is
//                                         materialised for every incident
//                                         create, update and resolve.
//   status-subscribers listPurgeCandidates the same table's 90-day email
//                                         erasure. THIS SHAPE HAS ALREADY
//                                         FAILED IN PRODUCTION — see the
//                                         comment on purgeEmails: a backlog
//                                         past the bind-parameter ceiling made
//                                         the purge throw, and the erasure did
//                                         not happen. The fix chunked the
//                                         WRITE. The READ that produced the
//                                         oversized list is still this.
//   cost-nightly       listAllAccountIds  every active account, per nightly
//                                         tick. Grows with the business.
//   audit-archive      selectArchivableRows  every row older than the cutoff,
//                                         across the five tables in AUDIT_TABLES.
//                                         The service
//                                         defines DEFAULT_BATCH_SIZE = 10_000
//                                         and documents it as "keeps memory
//                                         bounded on large windows" — but the
//                                         batching happens downstream of this
//                                         read, so it bounds the UPLOAD chunks
//                                         and not the load. The service has
//                                         never been scheduled, which means its
//                                         first run is also its largest.
//
// This does not rewrite them. Turning a fan-out into a keyset walk is a design
// change with a migration behind it, and picking that unilaterally out of a
// drift guard would be the wrong call. What it does is stop the set from
// growing quietly, and put the four in one place where the decision can be made
// against the whole list instead of one function at a time.
//
// WHY THIS DETECTOR AND NOT A SMARTER ONE. An earlier pass classified by
// "does the WHERE contain an eq()", which exempted `eq(accounts.status,
// 'active')` — the single largest scan in the set — and separately reported
// `listPendingInvites` as unscoped when it filters on ownerAccountId. Both
// errors ran in the direction that under-reports. The rule here is mechanical
// and checkable by eye: no `.limit()`, no aggregate, and no equality or
// membership predicate on a column whose name ends in `id`. It says nothing
// about whether a scan is SAFE — that judgement is the roster's, recorded by
// hand.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');

/** `eq(x.somethingId, …)` / `inArray(x.id, …)` — the caller bounds the rows. */
const ID_PREDICATE = /\b(?:eq|inArray)\(\s*\w+\.(?:\w*[Ii]d)\b/;
/** An aggregate returns one row whatever the table holds. */
const AGGREGATE = /count\(\*\)|sql<string>`count|\.groupBy\(|sum\(/;

/**
 * Every unbounded scan, with what actually bounds it in practice.
 *
 * `operator` — the table only grows when staff add a row.
 * `capacity` — bounded by live infrastructure, not by stored history.
 * `CUSTOMERS` — grows with customer or public activity. These are the ones to
 *               look at, and they are shouted so the list cannot be skimmed
 *               without seeing them.
 */
const UNBOUNDED_SCANS = new Map<string, string>([
  [
    'agent-sessions-repo.ts:listActivePairModeSessionIds',
    'capacity — only sessions that are live right now, bounded by fleet concurrency',
  ],
  [
    'audit-archive-repo.ts:selectArchivableRows',
    'CUSTOMERS — every audit row past the cutoff. DEFAULT_BATCH_SIZE bounds the upload, not this read, and the service has never run so its first run is its largest',
  ],
  [
    'cost-nightly-accounts-provider.ts:listAllAccountIds',
    'CUSTOMERS — every active account, once per nightly tick',
  ],
  ['fleet-nodes-repo.ts:listActive', 'operator — fleet size, provisioned by us'],
  ['fleet-nodes-repo.ts:listActiveByRegion', 'operator — a subset of the fleet'],
  ['fleet-nodes-repo.ts:listWithLivekitNearest', 'operator — a subset of the fleet'],
  ['oauth-store.ts:listClients', 'operator — OAuth clients are registered by staff'],
  ['platform-secrets-repo.ts:listMeta', 'operator — one row per configured secret'],
  ['pricing-repo.ts:listAll', 'operator — one row per tier'],
  [
    'status-subscribers-repo.ts:listConfirmed',
    'CUSTOMERS — every confirmed subscriber, materialised per incident create/update/resolve. Signup is public',
  ],
  [
    'status-subscribers-repo.ts:listPurgeCandidates',
    'CUSTOMERS — every unsubscribed row past the cutoff. This shape already failed once here; the fix chunked the write, not this read',
  ],
  ['validation-schedules-repo.ts:list', 'operator — schedules are configured by staff'],
]);

/**
 * Where a method's BODY starts — after the parameter list and after any return
 * type annotation.
 *
 * The obvious version, "first `{` after the method name", is wrong twice and
 * both times it reads LESS than it claims:
 *
 *   `listAll(opts: { limit: number; offset: number })` — the first `{` opens the
 *   parameter's inline type, so the "body" is `{ limit: number; offset: number }`,
 *   which contains no `.select(` and drops the method from the scan entirely.
 *   That hid 38 of 165 select-performing methods, and it is why the mutation
 *   that removed a `.limit()` from exactly this method SURVIVED the first
 *   version of this guard.
 *
 *   `Promise<{ rows: X[] }>` — the same trap in the return type. Tracked by
 *   angle depth, so a brace inside `<…>` is not mistaken for the body.
 */
function bodyStart(src: string, parenAt: number): number {
  let i = parenAt;
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  let angle = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '<') angle += 1;
    else if (c === '>') angle -= 1;
    else if (c === '{' && angle <= 0) return i;
    // An interface member declaration ends at `;` and has no body at all.
    else if (c === ';') return -1;
  }
  return -1;
}

/** Method name → body, for every `  name(` / `  async name(` in a repo file. */
function methods(src: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of src.matchAll(/\n {2}(?:async )?(\w+)\(/g)) {
    const open = bodyStart(src, (m.index ?? 0) + m[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    let end = src.length;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    out.push([m[1] ?? '', src.slice(open, end)]);
  }
  return out;
}

interface Scan {
  readonly selectMethods: number;
  readonly unbounded: string[];
}

function scan(): Scan {
  let selectMethods = 0;
  const unbounded: string[] = [];
  for (const file of readdirSync(DB).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(DB, file), 'utf8');
    for (const [name, body] of methods(src)) {
      if (!body.includes('.select(')) continue;
      selectMethods += 1;
      if (/\.limit\(/.test(body)) continue;
      if (AGGREGATE.test(body)) continue;
      if (ID_PREDICATE.test(body)) continue;
      unbounded.push(`${file}:${name}`);
    }
  }
  return { selectMethods, unbounded: unbounded.sort() };
}

describe('an unbounded repo scan is a recorded decision', () => {
  const { selectMethods, unbounded } = scan();

  it('CRITICAL the scan reads the repos and can tell a bounded read from an unbounded one. Every assertion here compares a set to a list, so a detector that matched nothing would report an empty set — which reads as "no unbounded scans" and is the most reassuring possible way to be wrong. Both directions are probed by name.', () => {
    // 165 today. The floor is above the 127 the broken body extractor could
    // see, so a regression to that shape fails here rather than reporting a
    // clean roster over three quarters of the repos.
    expect(selectMethods, 'repo methods running a SELECT').toBeGreaterThan(150);
    expect(
      unbounded,
      'a keyset listing that takes an explicit limit must NOT be reported',
    ).not.toContain('sessions-repo.ts:listSessions');
    expect(
      unbounded,
      'the known unbounded incident fan-out read is missing — the detector is broken',
    ).toContain('status-subscribers-repo.ts:listConfirmed');
  });

  it('CRITICAL no repo scans a whole table without that being a decision someone made. If the new method is bounded by an id the caller supplies, filter on it and this stops reporting it. If it is genuinely a full scan, add it here with what bounds it in practice — and if the answer is "customer activity", say so, because that is the class that is fine in staging and is an outage at scale.', () => {
    const unrecorded = unbounded.filter((k) => !UNBOUNDED_SCANS.has(k));
    expect(unrecorded, 'unbounded repo scan(s) with no recorded justification:').toEqual([]);
  });

  it('CRITICAL every recorded entry still names a real unbounded scan. A stale entry claims a read was reviewed when it has since gained a limit or stopped existing, and a roster that keeps entries it no longer needs is one nobody re-reads.', () => {
    const stale = [...UNBOUNDED_SCANS.keys()].filter((k) => !unbounded.includes(k)).sort();
    expect(stale, 'recorded scan(s) that no longer match:').toEqual([]);
  });

  it('CRITICAL the four customer-growth scans are still exactly these four. The operator-bounded majority is the boring part; this list is the one that decides whether the set is getting worse. A fifth arriving is the signal, and it would otherwise be one entry in a roster of a dozen.', () => {
    const byCustomers = [...UNBOUNDED_SCANS.entries()]
      .filter(([, why]) => why.startsWith('CUSTOMERS'))
      .map(([k]) => k)
      .sort();
    expect(byCustomers, 'scans whose size is customer activity:').toEqual([
      'audit-archive-repo.ts:selectArchivableRows',
      'cost-nightly-accounts-provider.ts:listAllAccountIds',
      'status-subscribers-repo.ts:listConfirmed',
      'status-subscribers-repo.ts:listPurgeCandidates',
    ]);
  });
});
