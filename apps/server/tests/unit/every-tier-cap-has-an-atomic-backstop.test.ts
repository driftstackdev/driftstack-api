// A tier cap is enforced under a lock, not by reading a count and hoping.
//
// Reading a count, comparing it to a limit, and then inserting is a TOCTOU: N
// concurrent creates all read the same pre-insert count, all pass the check, and
// all insert. The free tier permits ONE profile; two simultaneous requests get
// two. The customer is not doing anything clever — two browser tabs is enough.
//
// This repo has hit that exact race repeatedly and fixed it repeatedly. Five
// separate places carry a TOCTOU note: sessions, webhooks, profiles,
// agent-sessions and team-members. Each fix moved enforcement into the repo, as
// a conditional insert that counts and writes inside ONE transaction holding a
// `FOR UPDATE` on the owning account row (or an advisory xact lock), so
// concurrent creates for the same account serialize and the loser reads the
// post-insert count and is refused.
//
// Every capped resource is enforced that way today. What was missing is anything
// that KEEPS it that way. The next capped resource — a seat count, a snapshot
// quota, a stored-bytes ceiling — will be written by someone reading the
// service-layer code, where the visible pattern is
//
//     const limit = somethingLimitFor(tier);
//     if (current >= limit) throw new TierLimitError(...);
//
// and that pattern is the bug. It is correct here only because a locking repo
// method re-checks underneath, which the service call site does not show.
//
// So this asserts the pairing directly: anything consulting a tier-limit helper
// must also reach a conditional-insert method. Both sides are DERIVED — the
// helpers from their own `export function …LimitFor(` declarations, the
// enforcement methods from the `IfUnder…` / `WithLimit` naming the repos already
// use consistently. A new helper or a new enforcement method is picked up
// without editing this file; a helper with no enforcement is not.
//
// WHAT THIS DOES NOT CLAIM. It does not verify the locking is CORRECT — that the
// transaction really serializes, that the lock ordering is deadlock-safe. The
// db-* integration suites exercise that against a real Postgres. This is the
// cheaper structural half: that the enforcement exists at all and is reached
// from the place that decides the limit.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const DB_DIR = resolve(SERVER_SRC, 'db');

/** Every .ts under src, excluding SQL migrations. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'migrations') walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(SERVER_SRC);
  return out;
}

/** Tier-limit helpers, read from their own declarations. */
function limitHelpers(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/export function (\w*[Ll]imitFor)\s*\(/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

/**
 * Repo methods that count and insert under a lock. Named by convention —
 * `insertWithLimit`, `createIfUnderActiveCap`, `insertSessionIfUnderLimit` — so
 * the set grows with the repos rather than with this file.
 */
function enforcementMethods(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(DB_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(resolve(DB_DIR, entry), 'utf8');
    for (const m of text.matchAll(/async (\w*(?:IfUnder\w*|WithLimit))\s*\(/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

interface CallSite {
  file: string;
  limitCalls: number;
  reaches: string[];
}

/** Files that consult a tier-limit helper, and what enforcement they reach. */
function limitCallSites(): CallSite[] {
  const helpers = limitHelpers();
  const enforcement = enforcementMethods();
  const out: CallSite[] = [];

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    let calls = 0;
    for (const helper of helpers) {
      const uses = [...text.matchAll(new RegExp(`\\b${helper}\\s*\\(`, 'g'))].length;
      // The helper's own `export function foo(` is a declaration, not a use.
      const declares = new RegExp(`export function ${helper}\\s*\\(`).test(text) ? 1 : 0;
      calls += uses - declares;
    }
    if (calls <= 0) continue;
    out.push({
      file: file.slice(SERVER_SRC.length + 1),
      limitCalls: calls,
      reaches: enforcement.filter((m) => new RegExp(`\\.${m}\\s*\\(`).test(text)),
    });
  }
  return out;
}

describe('every tier cap has an atomic backstop', () => {
  it('CRITICAL both sides of the pairing were found. The assertion below is "no call site is missing enforcement", and a scan that matched no call sites has none missing — it would report every cap safely enforced having read no cap at all.', () => {
    const helpers = limitHelpers();
    const enforcement = enforcementMethods();
    const sites = limitCallSites();

    // MEASURED: 2 helpers (concurrentSessionLimitFor, profileLimitFor),
    // 5 enforcement methods, 4 files that consult a helper.
    expect(helpers.length, 'tier-limit helpers found').toBeGreaterThanOrEqual(2);
    expect(
      enforcement.length,
      'conditional-insert enforcement methods found',
    ).toBeGreaterThanOrEqual(3);
    expect(sites.length, 'files consulting a tier-limit helper').toBeGreaterThanOrEqual(4);
    expect(enforcement, 'including the profile one this repo fixed first').toContain(
      'insertWithLimit',
    );
  });

  it('CRITICAL every file that consults a tier limit also reaches a conditional-insert method. The service-layer pattern — read the count, compare, throw — is a TOCTOU on its own, and it is correct here only because a locking repo method re-checks underneath. A new capped resource copied from that visible pattern would ship the race.', () => {
    const unbacked = limitCallSites()
      .filter((s) => s.reaches.length === 0)
      .map((s) => `${s.file} (${String(s.limitCalls)} limit call(s), no conditional insert)`)
      .sort();
    expect(
      unbacked,
      'tier cap(s) enforced by a read-then-act check with no atomic backstop:',
    ).toEqual([]);
  });

  it('CRITICAL the enforcement methods still take a lock. The name is the convention this file matches on, and a method that kept the name while losing its transaction would satisfy every assertion above while reintroducing the race it was written to close.', () => {
    const unlocked: string[] = [];
    for (const entry of readdirSync(DB_DIR)) {
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(resolve(DB_DIR, entry), 'utf8');
      for (const m of text.matchAll(/async (\w*(?:IfUnder\w*|WithLimit))\s*\(/g)) {
        // Bounded to the method body: from its signature to the next `async ` at
        // the same nesting, or 4000 chars, whichever is shorter.
        const start = m.index;
        const nextMethod = text.indexOf('\n  async ', start + 1);
        const end = nextMethod === -1 ? start + 4000 : Math.min(nextMethod, start + 4000);
        const body = text.slice(start, end);
        const locks =
          body.includes(".for('update')") ||
          body.includes('pg_advisory_xact_lock') ||
          body.includes('FOR UPDATE');
        if (!locks) unlocked.push(`${entry} ${m[1]!}`);
      }
    }
    expect(unlocked.sort(), 'enforcement method(s) that no longer take a lock:').toEqual([]);
  });
  // ⛔ V-1988 — enforcing under a lock is not enough if the lock counts the wrong
  // rows. The profile cap deliberately counts LIVE + TRASHED (anti-abuse,
  // 2026-06-17): a trashed profile still holds a row, a DEK and a sealed blob, so
  // excluding it would let a customer soft-delete their way past the cap and hoard
  // unbounded recoverable profiles for the whole 30-day retention window. Adding a
  // `notDeleted` filter to the enforcement count reopens exactly that, and it
  // type-checks — measured 2026-08-27, the mutation passed 474 test files / 6374
  // tests untouched, which is why this arm exists.
  //
  // The divergence with `countByAccount` is deliberate and BOTH sides are pinned
  // here: the enforcement counts trashed, the display/pre-check does not. A
  // future tidy-up that unifies them must fail this and read the reason.
  it('CRITICAL the profile cap counts TRASHED rows too, so a soft delete cannot buy a free slot. Enforcement and the display count deliberately differ; both directions are pinned', () => {
    const repo = readFileSync(resolve(DB_DIR, 'profiles-repo.ts'), 'utf8');

    /** The `select({ n: count() })…;` statement inside one method body. */
    const capCountIn = (method: string): string => {
      const start = repo.indexOf(`async ${method}`);
      expect(start, `${method} still exists`).toBeGreaterThan(-1);
      const nextMethod = repo.indexOf('\n  async ', start + 1);
      const body = repo.slice(start, nextMethod === -1 ? start + 4000 : nextMethod);
      const m = /\.select\(\{ n: count\(\) \}\)[\s\S]*?;/.exec(body);
      expect(m, `${method} still counts rows against the cap`).not.toBeNull();
      return m?.[0] ?? '';
    };

    for (const method of ['insertWithLimit', 'transferAtomic']) {
      expect(
        capCountIn(method),
        `${method} must count LIVE + TRASHED against the cap — a notDeleted filter here lets a customer soft-delete past their limit`,
      ).not.toContain('notDeleted');
    }

    // The other direction: the reported/pre-check count is LIVE-only ON PURPOSE.
    // Without this the arm above could be satisfied by deleting the filter
    // everywhere, which would silently change what the published profile_count means.
    expect(
      capCountIn('countByAccount'),
      'countByAccount is the LIVE-only population the pre-check and /v1/account/me report',
    ).toContain('notDeleted');
  });
});
