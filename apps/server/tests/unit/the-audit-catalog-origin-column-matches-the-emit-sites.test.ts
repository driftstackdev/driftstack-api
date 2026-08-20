// V-1135 — the audit catalog's Origin column, checked against the code that emits the rows.
//
// `api/audit-log.md` documents each customer audit action and an Origin — `customer`,
// `system`, or `customer or system`. The page also advertises `?actor_type=` filtering
// as a GDPR Article 15 self-audit path, which is what makes the column load-bearing
// rather than decorative: a row labelled `customer` that the server also emits as
// `system` makes a customer's filtered read silently incomplete. They get a short
// answer with no indication it is short.
//
// D-5 raised this against `session.destroyed`, which is genuinely emitted both ways —
// `actorType: 'customer'` on the customer teardown path and `'system'` on three
// failure/expiry paths in `services/sessions.ts`. The doc row already says
// "customer or system", so that one is right. What was NOT known is whether any OTHER
// of the forty rows carries the same shape and a one-value cell. Measured: none does.
// All forty agree with source today, so this guard ships green and stays that way only
// while that holds.
//
// ── How the resolver works, and why it is shaped this way ──────────────────
//
// Actions reach the audit log through several mechanisms — a literal `action:` beside
// `actorType:`, a per-service `emitAuditBestEffort` helper, and local route helpers
// like `emitProxyAudit`. Enumerating the mechanisms was a losing game, so this keys off
// the ACTOR TYPE instead: every emit-site actorType literal claims the action literals
// near it. Three narrower attempts are recorded here because each produced a wrong
// answer and the wrongness was not visible without checking:
//
//   • Requiring `action:` adjacent to `actorType:` resolved 22 of 40 and reported zero
//     mismatches — a clean-looking result over half the population.
//   • Attributing every actorType in a FILE to every action in it resolved 40 of 40 and
//     produced two mismatches, BOTH false: `services/sessions.ts` contains customer and
//     system emits, so `session.created` inherited `system` from a neighbour.
//   • Matching `actorType: '<x>'` without requiring a trailing comma picked up
//     `actorType: 'customer' | 'system' | 'staff';` — the TYPE UNION in
//     `CustomerAuditEmitter` — and attributed `customer` to every action listed in that
//     interface, including one only ever emitted as `system`.
//
// The comma is what separates an object-literal emit from a type declaration; the
// `as const` arm is required because `services/sessions.ts` writes
// `actorType: 'customer' as const,`. A resolver that silently mis-attributes reads
// exactly like one that works, which is why the arms below fail on an UNRESOLVED row
// rather than skipping it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');
const CATALOG = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');

/** An emit-site actor type: an object-literal property, never a type union member. */
const EMIT = /actorType:\s*'(\w+)'(?:\s+as\s+const)?\s*,/g;

/** How far an actorType literal reaches when claiming nearby action literals. */
const WINDOW = 1200;

interface Row {
  action: string;
  origin: Set<string>;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function catalogRows(): Row[] {
  const doc = readFileSync(CATALOG, 'utf8');
  const re = /^\| `([a-z_]+\.[a-z_]+)`\s*\|\s*([^|]+?)\s*\|/gm;
  return [...doc.matchAll(re)].map((m) => ({
    action: m[1] ?? '',
    origin: new Set(
      (m[2] ?? '')
        .toLowerCase()
        .split(/\bor\b|,|\//)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  }));
}

function resolveActorTypes(action: string, sources: ReadonlyArray<string>): Set<string> {
  const needle = `'${action}'`;
  const found = new Set<string>();
  for (const text of sources) {
    if (!text.includes(needle)) continue;
    for (const m of text.matchAll(EMIT)) {
      const from = Math.max(0, m.index - WINDOW);
      if (text.slice(from, m.index + m[0].length + WINDOW).includes(needle)) {
        found.add(m[1] ?? '');
      }
    }
  }
  return found;
}

describe('V-1135 the audit catalog Origin column matches the emit sites', () => {
  it('CRITICAL every documented audit action resolves to at least one emit-site actor type. An action nobody can locate in source is the failure mode this file exists to avoid reporting as agreement — an unresolved row would otherwise compare an empty set against a populated cell and be silently skipped.', () => {
    const sources = walk(SRC, []).map((f) => readFileSync(f, 'utf8'));
    expect(sources.length, 'no server sources walked — the src layout moved').toBeGreaterThan(50);

    const rows = catalogRows();
    expect(
      rows.length,
      'no rows parsed out of the catalog — its table shape moved',
    ).toBeGreaterThan(30);

    const unresolved = rows
      .filter((r) => resolveActorTypes(r.action, sources).size === 0)
      .map((r) => r.action);
    expect(unresolved.sort(), 'documented audit actions with no locatable emit site').toEqual([]);
  });

  it('CRITICAL the Origin cell of every documented action equals the actor types the server actually emits it with. The page sells `?actor_type=` as a GDPR Article 15 self-audit, so a one-value cell over a two-value action hands the customer a short answer that looks complete.', () => {
    const sources = walk(SRC, []).map((f) => readFileSync(f, 'utf8'));
    const wrong = catalogRows()
      .map((r) => ({ r, actual: resolveActorTypes(r.action, sources) }))
      .filter(({ r, actual }) => [...actual].sort().join(',') !== [...r.origin].sort().join(','))
      .map(
        ({ r, actual }) =>
          `${r.action}: doc=[${[...r.origin].sort().join(', ')}] source=[${[...actual].sort().join(', ')}]`,
      );
    expect(wrong.sort(), 'Origin cells that disagree with the emit sites').toEqual([]);
  });

  it('CRITICAL the dual-origin case still resolves to BOTH actor types. `session.destroyed` is the one action emitted as customer and as system, and it is the reason this column cannot be a single value per row. If the resolver stops seeing both, it has narrowed and every other row above became easier to satisfy, not more correct.', () => {
    const sources = walk(SRC, []).map((f) => readFileSync(f, 'utf8'));
    expect([...resolveActorTypes('session.destroyed', sources)].sort()).toEqual([
      'customer',
      'system',
    ]);
  });

  it('CRITICAL the resolver still excludes type declarations. `CustomerAuditEmitter` declares `actorType` as a union of all three values; counting that as an emit attributes `customer` to actions only ever emitted as `system`, which is a false agreement rather than a false alarm.', () => {
    const apiKeys = readFileSync(resolve(SRC, 'services/api-keys.ts'), 'utf8');
    expect(apiKeys, 'the type union this resolver must not match has moved').toMatch(
      /actorType:\s*'customer' \| 'system' \| 'staff';/,
    );
    expect(
      [...resolveActorTypes('subscription.tier_changed', [apiKeys])],
      'the type union was matched as an emit site',
    ).toEqual([]);
  });
});
