// A declared account-audit action that no code writes is a dead filter in the
// customer's audit log.
//
// The admin side of this already has a guard —
// every-declared-admin-audit-action-is-reachable — and the account side did not,
// which is the asymmetry this closes. The consequence is worse on this side,
// because of what the other guards already require: the customer dashboard MUST
// carry a FILTER_OPTIONS entry for every AccountAuditAction
// (account-audit-action-cross-source-invariant asserts it). So an action nobody
// writes is not dead weight — it is a dropdown option a customer can select,
// which returns an empty page forever, and reads as "this never happened" when
// the truth is "this can never be recorded".
//
// The vocabulary is also regenerated into all three customer SDKs
// (cross-sdk-audit-action-roster-parity) and documented as a catalog
// (docs-audit-log-action-catalog-completeness). Every one of those checks passes
// for an action that is never written. They describe the vocabulary; none of
// them asks whether the server can produce it.
//
// Measured when this landed: all 46 declared actions have a write site, so this
// protects the forty-seventh rather than fixing any of the forty-six. The
// UNWRITTEN list is deliberately empty for that reason — an exception mechanism
// with nothing in it, ready for the first action that genuinely cannot be
// emitted, the way the admin guard carries `status_subscriber.purged`.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Files that NAME the vocabulary rather than write it. */
const DECLARATIVE = ['db/schema.ts', 'lib/openapi.ts'] as const;

/**
 * Actions that exist in the vocabulary and cannot be written, with the reason.
 *
 * Empty today. Kept because the admin guard needed exactly this for
 * `status_subscriber.purged` — an action whose row is unwireable, since the
 * table demands an account id and the actor is an anonymous email on a timer.
 */
const UNWRITTEN = new Map<string, string>();

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) tsFilesUnder(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Non-comment lines only.
 *
 * Not optional: the admin guard records that `status_subscriber.purged` appeared
 * exactly once outside its own declaration — in a comment — which is enough to
 * make a naive scan call it reachable. A guard that counts prose as a write site
 * reports the very thing it exists to catch as fine.
 */
function codeLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Actions some code path actually writes. */
function writtenActions(declared: readonly string[]): Set<string> {
  const files = tsFilesUnder(SRC).filter((p) => !DECLARATIVE.some((d) => p.endsWith(d)));
  const bodies = files.map(codeLines);
  const found = new Set<string>();
  for (const action of declared) {
    if (bodies.some((b) => b.includes(`'${action}'`))) found.add(action);
  }
  return found;
}

describe('every declared account-audit action is reachable', () => {
  const declared = AccountAuditActionSchema.options;
  const written = writtenActions(declared);

  it('CRITICAL the scan reads real sources and can tell a written action from an invented one', () => {
    // Positive AND negative control. This asserts a set difference is empty,
    // which a scan reaching nothing produces for free; and a scan that matched
    // too loosely would report an invented action as written.
    expect(declared.length, 'the action vocabulary did not load').toBeGreaterThanOrEqual(40);
    expect(
      written.size,
      'no declared action was found written anywhere — the scan is broken',
    ).toBeGreaterThanOrEqual(40);
    expect(
      writtenActions(['account.invented_action_that_does_not_exist']).size,
      'the scan claims to find an action that appears nowhere, so it cannot detect a real absence',
    ).toBe(0);
  });

  it('CRITICAL every declared action is written by some code path, or listed as unwritable', () => {
    const unreachable = declared.filter((a) => !written.has(a) && !UNWRITTEN.has(a)).sort();
    expect(
      unreachable,
      'this action is in the customer-facing vocabulary but no code writes it. The dashboard is ' +
        'required to carry a filter for every action, so a customer can select this one and get ' +
        'an empty page forever — which reads as "this never happened" rather than "this cannot ' +
        'be recorded". Wire it, remove it from the enum, or add it to UNWRITTEN with the reason',
    ).toEqual([]);
  });

  it('CRITICAL the UNWRITTEN list has no stale entry', () => {
    // An entry for an action some path now writes stops being a decision and
    // starts being misinformation.
    const nowWritten = [...UNWRITTEN.keys()].filter((a) => written.has(a)).sort();
    expect(nowWritten, 'an UNWRITTEN entry names an action that is now written').toEqual([]);
  });

  it('CRITICAL every UNWRITTEN entry is still in the vocabulary', () => {
    const orphans = [...UNWRITTEN.keys()].filter((a) => !declared.includes(a as never)).sort();
    expect(orphans, 'an UNWRITTEN entry names an action no longer declared').toEqual([]);
  });
});
