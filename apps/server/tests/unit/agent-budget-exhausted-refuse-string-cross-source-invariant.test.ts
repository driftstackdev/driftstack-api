// Cross-source invariant — the "budget exhausted" refuse reason string.
//
// The string `token budget exhausted; start a new session` is duplicated as a
// BARE LITERAL (no shared constant) across three production files:
//
//   1. agent-decomposer-deterministic.ts — emits it as the refuseReason on a
//      pre-call budget refusal.
//   2. agent-decomposer-claude.ts        — emits it likewise (the PRODUCTION
//      decomposer path).
//   3. agent-runtime.ts                  — matches it with an exact `===` to
//      fire the Q.3 atomic session-close on budget exhaustion.
//
// Why an exact-match coupling is fragile: a PRE-CALL budget refusal charges 0
// tokens (the decomposer refused before any LLM call), so the session still
// has budget remaining — it's just insufficient for another turn. That means
// the runtime's OTHER close trigger, `debitZeroedBudget`
// (postDebitSession.tokenBudgetRemaining === 0), does NOT fire. The Q.3 close
// therefore depends ENTIRELY on `decomposed.refuseReason === '<this literal>'`.
// If any decomposer's wording drifts out of sync with the runtime matcher, the
// atomic close SILENTLY stops firing for that decomposer and the customer is
// left retrying into budget refusals — the exact failure Q.3 was built to
// prevent. The deterministic-decomposer runtime test wouldn't catch a drift in
// the Claude decomposer (it drives the deterministic one), so the production
// path could break unnoticed.
//
// The per-decomposer tests pin each emit IN ISOLATION; none pins that all three
// agree. This invariant does. (The robust long-term fix is a single shared
// constant imported by all three — a small behaviour-neutral refactor surfaced
// for a focused pass; this test is the safe immediate drift guard.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src/services');

const CANONICAL = 'token budget exhausted; start a new session';

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

// Capture the refuseReason string that mentions "budget" (uniquely the
// budget-exhausted literal — the runtime's only other refuseReason,
// 'agent layer temporarily unavailable; please retry', has no "budget").
const EMIT_RE = /refuseReason: '([^']*budget[^']*)'/;
const MATCH_RE = /refuseReason === '([^']*budget[^']*)'/;

describe('budget-exhausted refuse-reason cross-source invariant (decomposers ↔ runtime close trigger)', () => {
  const det = read('agent-decomposer-deterministic.ts').match(EMIT_RE)?.[1];
  const claude = read('agent-decomposer-claude.ts').match(EMIT_RE)?.[1];
  const runtime = read('agent-runtime.ts').match(MATCH_RE)?.[1];

  it('the deterministic decomposer emits the canonical budget-exhausted refuse reason', () => {
    expect(det).toBe(CANONICAL);
  });

  it('the Claude (production) decomposer emits the canonical budget-exhausted refuse reason', () => {
    expect(claude).toBe(CANONICAL);
  });

  it('the runtime close trigger matches the SAME literal (else the Q.3 atomic close silently stops firing on a pre-call budget refusal — which charges 0 tokens, so debit-to-zero cannot save it)', () => {
    expect(runtime).toBe(CANONICAL);
  });

  it('all three literals are byte-identical (the actual coupling — drift in any one breaks the close for that path)', () => {
    expect(new Set([det, claude, runtime]).size).toBe(1);
  });
});
