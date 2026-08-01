// Structural drift guard for the drizzle-orm 0.38.4 Date-param-in-
// raw-sql crash class (see docs/internal/drizzle-date-param-
// workaround.md for the empirical bisection + ISO-string workaround).
//
// 2026-05-19 swept this codebase for the bug:
//   • Fixed `DrizzleScheduledJobsRepo.claimDue` in commit 1b2001c8 (the
//     prod incident root cause).
//   • Fixed `DurableWebhookDeliveryService.processTick` in commit
//     5d7fe344 (found during the post-fix audit, would have fired when
//     the poller is wired in bootstrap).
//
// Both call sites are now ISO-string-safe. This test prevents a 3rd
// instance from being introduced silently — every raw `sql\`...\``
// template literal interpolation that LOOKS like a Date (variable
// named `now` / `*Date` / `new Date(...)` / `*At` time-field idiom)
// must be `.toISOString()`'d at the source.
//
// Match rules (false-positive-leaning vs false-negative-leaning):
//   • False-positives OK — devs can opt-out via the allow-list below
//     when they've audited the call site by hand.
//   • False-negatives BAD — a missed Date interpolation could fire the
//     same TypeError storm that ran for 10 days in prod
//     (2026-05-09 → 2026-05-19, 1439 occurrences/24h).
//
// Implementation: glob walk apps/server/src/**/*.ts, regex-match
// `sql\`` ... `\`` blocks, then within each block look for `${...}`
// interpolations whose inner expression matches a Date-shape
// heuristic. Allow-list specific files+variables that are documented
// as safe.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

// Walk the server src tree, return all .ts files (skip .test.ts).
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Match `sql\`...\`` blocks (greedy across newlines). Drizzle's `sql`
// tag is unambiguous — no other tagged template in the codebase uses
// that exact identifier.
const SQL_TEMPLATE_BLOCK = /\bsql`([^`]*)`/gs;

// Inside a block, match `${...}` interpolations. The inner expression
// stops at the matching `}` (without nesting — drizzle templates don't
// nest objects).
const INTERPOLATION = /\$\{([^}]+)\}/g;

// Heuristic: a variable name that looks like a Date.
const DATE_LOOKING = /^(now|nowDate|date|.*Date|.*At|new\s+Date\([^)]*\))$/;

// Allow-list: { file (relative to repo root): [variable patterns we
// affirmatively know are safe — already .toISOString()'d or non-Date] }.
// Variable patterns are matched as exact-string equality on the
// trimmed interpolation contents.
const ALLOW_LIST: Record<string, string[]> = {
  // 1b2001c8 — scheduled-jobs claimDue uses pre-serialised nowIso /
  // lockStaleAtIso variables (NOT Dates by the time they reach the
  // template).
  'apps/server/src/db/scheduled-jobs-repo.ts': [
    'nowIso',
    'lockStaleAtIso',
    'opts.now',
    'opts.workerId',
    'opts.batchSize',
  ],
  // 5d7fe344 — durable-webhook-delivery processTick uses pre-serialised
  // nowIso.
  'apps/server/src/services/durable-webhook-delivery.ts': ['nowIso', 'batchSize'],
  // webhooks-repo already pre-serialises via nowIso (was the pattern
  // we adopted from). Allow-list its idioms.
  'apps/server/src/db/webhooks-repo.ts': [
    'nowIso',
    'opts.batchSize',
    'opts.now',
    'webhookEndpoints.secret',
    'webhookEndpoints.consecutiveFailures',
    'webhookEndpoints.events',
    'eventType',
    // #79 rotation grace-window guard — column REFERENCES (render as SQL
    // identifiers at build time, not JS Date values): the guard SQL is
    // `secret_prev_expires_at IS NULL OR secret_prev_expires_at <= force_rotated_at`.
    'webhookEndpoints.secretPrevExpiresAt',
    'webhookEndpoints.forceRotatedAt',
  ],
  // #79 Stripe out-of-order recency guard — `subscriptions.updatedAt <=
  // excluded.updated_at` in the onConflictDoUpdate setWhere. A column REFERENCE
  // (stored row) compared to the EXCLUDED pseudo-table column, NOT a JS Date
  // value bound into the template. Safe.
  'apps/server/src/db/stripe-webhooks-repo.ts': ['subscriptions.updatedAt'],
  // §8.1.b atlas-priority repo getStats uses sinceIso (string).
  'apps/server/src/db/atlas-priority-events-repo.ts': ['sinceIso'],
  // schema.ts partial-index expressions reference Drizzle COLUMNS via
  // `t.fieldName` — those render as SQL identifiers at build time, not
  // as JS Date values. Safe.
  'apps/server/src/db/schema.ts': [
    't.revokedAt',
    't.livekitApiKey',
    't.deletedAt',
    // C1 crypto_entitlements expiry-sweep partial index predicate
    // `expired_processed_at IS NULL` — a column REFERENCE, not a JS Date value.
    't.expiredProcessedAt',
    // Agent-turn receipt terminal-shape CHECK references this timestamp
    // COLUMN twice (IS NULL / IS NOT NULL); it is never a bound Date value.
    't.completedAt',
    // session_operations retention-sweep partial index predicate
    // `result_expires_at IS NOT NULL` — a column REFERENCE. Audited: the
    // repository's own expiry comparison deliberately uses the typed
    // `lte(sessionOperations.resultExpiresAt, now)` operator rather than a raw
    // template, precisely so the Date never reaches a raw interpolation. This
    // guard caught a real instance of that during slice 1.
    't.resultExpiresAt',
  ],
  // MFA monotonic timestamp expressions bind pre-serialized nowIso strings.
  // The remaining Date-looking expressions are Drizzle COLUMN references,
  // rendered as identifiers rather than postgres-js parameters.
  'apps/server/src/db/mfa-repo.ts': ['accountMfa.updatedAt', 'accountMfa.enrolledAt'],
  // usage-repo aggregates by day via `date_trunc('day', <column>)` —
  // `usageRecords.recordedAt` is a column REFERENCE (Drizzle's typed
  // accessor), not a JS Date.
  'apps/server/src/db/usage-repo.ts': ['usageRecords.recordedAt'],
  // auth-flows-repo deleteStaleAuthTokens uses pre-serialised
  // consumedIso / expiredIso (strings via .toISOString() at the
  // service-call boundary) AND references `t.consumedAt` as a
  // column accessor (Drizzle table identifier, renders as SQL at
  // build time, NOT a JS Date interpolation).
  'apps/server/src/db/auth-flows-repo.ts': ['t.consumedAt', 'consumedIso', 'expiredIso'],
};

interface Finding {
  file: string;
  block: string;
  interpolation: string;
}

describe('drizzle-orm Date-param-in-raw-sql structural drift guard', () => {
  // Vacuity arm. The case below reports an ABSENCE, which is vacuously true
  // over an empty scan — so a filter that stops matching (a rename, a new
  // extension, a moved root) would leave this reporting clean forever while
  // checking nothing. Measured, not hypothetical: pointing the extension
  // filter at a non-existent suffix left this file GREEN.
  it('CRITICAL the scan found real server sources AND real raw-sql blocks. Files alone is not enough: if SQL_TEMPLATE_BLOCK stopped matching, every file would be read and no interpolation examined, which reads identically to having none.', () => {
    const files = listTsFiles(SERVER_SRC);
    expect(files.length, 'server .ts files scanned').toBeGreaterThan(50);
    let blocks = 0;
    for (const file of files) {
      SQL_TEMPLATE_BLOCK.lastIndex = 0;
      const source = readFileSync(file, 'utf8');
      while (SQL_TEMPLATE_BLOCK.exec(source) !== null) blocks += 1;
    }
    expect(blocks, 'raw sql`` template blocks found').toBeGreaterThan(5);
  });

  it('every raw `sql`` ` template interpolation in apps/server/src is allow-listed or non-Date', () => {
    const findings: Finding[] = [];
    for (const file of listTsFiles(SERVER_SRC)) {
      const rel = relative(REPO_ROOT, file);
      const source = readFileSync(file, 'utf8');
      const allow = new Set(ALLOW_LIST[rel] ?? []);
      let blockMatch: RegExpExecArray | null;
      // Reset lastIndex — global regex retains state per-instance.
      SQL_TEMPLATE_BLOCK.lastIndex = 0;
      while ((blockMatch = SQL_TEMPLATE_BLOCK.exec(source)) !== null) {
        const block = blockMatch[1] ?? '';
        INTERPOLATION.lastIndex = 0;
        let interpMatch: RegExpExecArray | null;
        while ((interpMatch = INTERPOLATION.exec(block)) !== null) {
          const expr = (interpMatch[1] ?? '').trim();
          if (allow.has(expr)) continue;
          // Heuristic — does this LOOK like a Date?
          if (DATE_LOOKING.test(expr)) {
            findings.push({ file: rel, block: block.slice(0, 60), interpolation: expr });
          }
        }
      }
    }
    if (findings.length > 0) {
      const lines = findings.map(
        (f) => `\n  ${f.file}:  \`${f.block}…\`  ← \${${f.interpolation}}`,
      );
      throw new Error(
        `${String(findings.length)} suspected drizzle-Date-param ` +
          `interpolation(s) found in raw sql template literals. Either ` +
          `pre-serialise via .toISOString() at the call site OR add the ` +
          `expression to the ALLOW_LIST in this test if you've audited ` +
          `the call site. See docs/internal/drizzle-date-param-workaround` +
          `.md for the empirical background.${lines.join('')}`,
      );
    }
    expect(findings).toEqual([]);
  });

  it('allow-list entries reference files that exist (catches stale allow-list as repos move)', () => {
    const missing: string[] = [];
    for (const rel of Object.keys(ALLOW_LIST)) {
      try {
        readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });
});
