// The audit archive runs for ONE of the five tables it can archive.
//
// This file replaces `audit-archive-is-not-scheduled-and-that-is-recorded`,
// which recorded that AuditArchiveService had never run at all. V-1591 wired it
// — for `session_events` only — so that record became false and had to go. The
// state it recorded did not disappear though, it narrowed, and the narrower
// version is worth exactly as much:
//
//   scheduled:     session_events            (audit.session_events_archive, hourly)
//   NOT scheduled: admin_audit_log
//                  processed_stripe_events
//                  legal_acceptances
//                  webhook_deliveries
//
// The four are held back deliberately, not forgotten. `archiveTable` DELETES
// production rows after an R2 upload, and those four are legal and financial
// records — Stripe event dedup keys, accepted-terms proofs, the admin action
// log. Deleting them is a decision with consequences well past disk usage, and
// unlike session_events they grow slowly enough that nothing forces it. The
// privacy policy's "session metadata 90 days operational" line was the pressure,
// and session_events was the table it named.
//
// What that costs, stated so it stays visible: those four tables have no
// retention bound today. Nothing else prunes them either. If one of them ever
// starts growing quickly, this file is the record that it was known.
//
// If you schedule the rest: delete this file in the same commit. The arms below
// fail the moment a second table is archived, so the record cannot outlive the
// fact — which is precisely how its predecessor came to be replaced.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Every table AuditArchiveService is capable of archiving. */
const ALL_TABLES = [
  'admin_audit_log',
  'processed_stripe_events',
  'legal_acceptances',
  'webhook_deliveries',
  'session_events',
] as const;

/** The only one anything schedules. */
const SCHEDULED = 'session_events';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Non-comment source LINES, so a prose mention does not count as usage.
 *
 * This deliberately does not strip comments with a regex, because two attempts
 * to do that were both wrong on this very tree:
 *
 *   blocks-then-lines  a `/*` inside a LINE comment opened a bogus block that ran
 *                      to the next `*` `/` — 2735 of bootstrap.ts's 3290 lines
 *                      vanished, including every service construction;
 *   lines-then-blocks  better, and still wrong: `'/* routes disabled. '` is a
 *                      STRING, and swallowed lines 1102-3199.
 *
 * A regex cannot know whether `/*` is code, comment or string without lexing
 * TypeScript. So drop the ambition: a construction is a statement on its own
 * line, and a prose mention lives on a line that starts with `//`, `*` or `/*`.
 * Testing the LINE is sound for that question and cannot destroy the file.
 */
function codeLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('four of five audit tables are still not archived, and that is recorded', () => {
  it('CRITICAL the comment stripper preserves real code, so "not found" means not there', () => {
    // The arms below assert ABSENCES across the source tree. An absence check is
    // only as good as the text it searches, and a stripper that eats the file
    // reports every absence as confirmed. This is the case that would have
    // caught the block-before-line ordering bug: bootstrap.ts wires the
    // services, so if the stripped copy cannot see a construction we know is
    // there, nothing below means anything.
    const boot = codeLines(resolve(SRC, 'lib/bootstrap.ts'));
    expect(
      boot,
      'the stripped bootstrap no longer contains a construction that is definitely in it — the ' +
        'comment stripper is destroying source, and every absence assertion below is vacuous',
    ).toContain('new SessionsService(');
    // A second probe DEEP in the file. The first sits early; both broken
    // strippers ate everything after ~1102, so a single early probe passed while
    // three quarters of the file was gone.
    expect(
      boot,
      'a construction late in bootstrap.ts is missing from the scanned text — the tail of the ' +
        'file is being dropped, which is exactly how the first two versions of this helper failed',
    ).toContain('new RetentionScrubSweeperService(');
    expect(
      boot.length / readFileSync(resolve(SRC, 'lib/bootstrap.ts'), 'utf8').length,
      'most of bootstrap.ts vanished from the scanned text, which dropping comment LINES alone ' +
        'cannot explain',
    ).toBeGreaterThan(0.4);
  });

  it('CRITICAL only session_events is archived — a second table appearing means four legal/financial tables started being DELETED', () => {
    const files = walk(SRC).filter((f) => !f.endsWith('services/audit-archive.ts'));
    const archived = new Set<string>();
    for (const f of files) {
      const code = codeLines(f);
      for (const table of ALL_TABLES) {
        // The call shape the scheduled path uses: archiveTable('<table>'...).
        if (new RegExp(`archiveTable\\(\\s*'${table}'`).test(code)) archived.add(table);
      }
    }
    expect(
      [...archived].sort(),
      'a table beyond session_events is now being archived, which means its rows are being ' +
        'DELETED from postgres after upload. If that is intended, delete this file in the same ' +
        'commit — a stale record is worse than none',
    ).toEqual([SCHEDULED]);
  });

  it('CRITICAL nothing calls archiveAll(), which would sweep all five tables at once', () => {
    // The single call that would silently undo the whole distinction above.
    // archiveTable is per-table and explicit; archiveAll iterates AUDIT_TABLES,
    // so one call site would start deleting from legal_acceptances and
    // processed_stripe_events with no other edit anywhere.
    const callers = walk(SRC)
      .filter((f) => !f.endsWith('services/audit-archive.ts'))
      .filter((f) => /\.archiveAll\s*\(/.test(codeLines(f)))
      .map((f) => f.slice(SRC.length + 1));
    expect(
      callers,
      'archiveAll() is now called in production source — that archives and deletes all five ' +
        'tables, including the four this file records as deliberately held back',
    ).toEqual([]);
  });

  it('the four held-back tables are still reachable, so this is a scheduling decision and not dead code', () => {
    // If someone deletes them from AUDIT_TABLES the record above stops meaning
    // anything — it would be recording a capability that no longer exists.
    const service = readFileSync(resolve(SRC, 'services/audit-archive.ts'), 'utf8');
    for (const table of ALL_TABLES) {
      expect(service, `${table} is no longer in AUDIT_TABLES`).toContain(`tableName: '${table}'`);
    }
  });
});
