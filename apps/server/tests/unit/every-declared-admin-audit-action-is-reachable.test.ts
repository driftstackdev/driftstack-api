// A declared admin-audit action that no code can emit is a promise the product
// cannot keep.
//
// `AdminAuditAction` is a closed Postgres enum. Every value in it is exported
// through `packages/api-types` and regenerated into all three customer SDKs, and
// the admin audit-list endpoint accepts it as an `action` filter. So a value
// that exists in the vocabulary but that no code path ever writes is not
// harmless dead weight: staff can filter for it, get an empty page, and read
// that as "this never happened" when the truth is "this can never be recorded".
//
// This has happened before. Migration 0097's own comment records that
// `admin-crypto-orders.ts` and `admin-validation-harness.ts` "had zero audit
// wiring despite this file's header invariant" — found by hand, once, and fixed
// once. Nothing stopped the next one.
//
// `status_subscriber.purged` is the next one, and it is worse than unwired: it
// is unwireable. `admin_audit_log.admin_account_id` and `.admin_key_id` are both
// NOT NULL with FKs to `accounts` / `api_keys`, and `account_audit_log` requires
// an `accountId`. A status subscriber is an anonymous email address with no
// account and no key, and the purge is fired by a timer with no admin actor at
// all. There is no way to write the row that bootstrap's comment claimed was
// being written. See V-783.
//
// The scan strips comments before looking. That is not incidental — the ONLY
// occurrence of `status_subscriber.purged` outside its own declaration was
// inside a comment asserting that the write happens, so a naive text search
// finds the string and concludes the action is live. The comment is the defect.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const DECLARATION = resolve(SRC, 'services', 'admin-audit.ts');
const SCHEMA = resolve(SRC, 'db', 'schema.ts');

/**
 * Actions that are deliberately part of the vocabulary but that nothing emits,
 * each with the reason. An entry here is a standing admission, so it has to be
 * justified in words — and the stale-entry case below fails the moment one
 * becomes emittable, so this list cannot quietly outlive its reason.
 */
const UNEMITTABLE: ReadonlyMap<string, string> = new Map([
  [
    'status_subscriber.purged',
    'V-783 — no actor exists to attribute it to. Both audit tables require a ' +
      'non-null account (admin_audit_log also a non-null api_key), the purge is ' +
      'fired by a timer, and a status subscriber is an anonymous email with ' +
      'neither. Reserved in the Postgres enum by migration 0027; a Postgres enum ' +
      'value cannot be dropped without rebuilding the type, so it stays declared.',
  ],
]);

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'migrations') continue;
      tsFilesUnder(p, out);
    } else if (entry.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Source with block and line comments removed — a mention is not an emission. */
function executableText(path: string): string {
  const raw = readFileSync(path, 'utf8');
  const withoutBlocks = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** The `AdminAuditAction` union members, read from the type declaration itself. */
function declaredActions(): string[] {
  const src = readFileSync(DECLARATION, 'utf8');
  const start = src.indexOf('export type AdminAuditAction =');
  const end = src.indexOf('export interface AdminAuditLogRow', start);
  expect(start, 'AdminAuditAction declaration found').toBeGreaterThanOrEqual(0);
  expect(end, 'end of the declaration found').toBeGreaterThan(start);
  return [...new Set([...src.slice(start, end).matchAll(/\|\s*'([a-z_.]+)'/g)].map((m) => m[1]!))];
}

/** Actions referenced as a string literal in executable code outside the declaration. */
function emittedActions(): { emitted: Set<string>; scanned: number } {
  const files = tsFilesUnder(SRC).filter((p) => p !== DECLARATION && p !== SCHEMA);
  const emitted = new Set<string>();
  for (const file of files) {
    const code = executableText(file);
    for (const m of code.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) emitted.add(m[1]!);
  }
  return { emitted, scanned: files.length };
}

describe('every declared admin-audit action is reachable from code', () => {
  it('CRITICAL every value in the AdminAuditAction vocabulary is written by some code path, or is listed as unemittable with a reason. A declared-but-unwritable action is exported to all three SDKs and accepted as an audit-list filter, so staff can query it, get nothing back, and read that as "it never happened" rather than "it can never be recorded".', () => {
    const declared = declaredActions();
    const { emitted, scanned } = emittedActions();

    // Vacuity: an empty declaration set, or a scan that read no files, would
    // make the comparison below pass against nothing at all.
    expect(declared.length, 'union members parsed out of the declaration').toBeGreaterThan(25);
    expect(scanned, 'server source files scanned').toBeGreaterThan(200);
    expect(emitted.size, 'dotted string literals found in executable code').toBeGreaterThan(50);

    const unreachable = declared.filter((a) => !emitted.has(a) && !UNEMITTABLE.has(a));
    expect(
      unreachable,
      'declared admin-audit actions that no executable code path emits — wire them or add them to UNEMITTABLE with the reason:',
    ).toEqual([]);
  });

  it('CRITICAL the UNEMITTABLE list has no stale entry. An action listed here that some code path now emits means the reason expired; leaving it listed would suppress the check for that value forever, which is how an allowlist rots into a blindfold.', () => {
    const { emitted } = emittedActions();
    const nowEmitted = [...UNEMITTABLE.keys()].filter((a) => emitted.has(a));
    expect(
      nowEmitted,
      'listed as unemittable but emitted in code — delete the entry, the obstacle is gone:',
    ).toEqual([]);
  });

  it('CRITICAL every UNEMITTABLE entry is declared. An entry naming an action that is no longer in the vocabulary is a leftover that makes the list look more considered than it is.', () => {
    const declared = new Set(declaredActions());
    const orphans = [...UNEMITTABLE.keys()].filter((a) => !declared.has(a));
    expect(orphans, 'listed as unemittable but not part of AdminAuditAction:').toEqual([]);
  });

  it('CRITICAL comments are stripped before the scan. status_subscriber.purged appeared exactly once outside its own declaration — inside a comment claiming the write happens — so a search over raw text reports it as emitted and the gap stays invisible. This case fails if that stripping is ever dropped.', () => {
    const files = tsFilesUnder(SRC).filter((p) => p !== DECLARATION && p !== SCHEMA);
    const inRawText = files.filter((p) =>
      readFileSync(p, 'utf8').includes("'status_subscriber.purged'"),
    );
    const inCode = files.filter((p) => executableText(p).includes("'status_subscriber.purged'"));

    // If the comment is ever removed this first expectation stops being the
    // point, but the second is the invariant and holds either way.
    expect(inCode, 'no executable code emits it').toEqual([]);
    expect(
      inRawText.length >= inCode.length,
      'stripping can only ever remove occurrences, never add them',
    ).toBe(true);
  });
});
