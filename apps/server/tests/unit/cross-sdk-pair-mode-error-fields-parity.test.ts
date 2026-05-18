// Arc 4 Wave 2.B sub-slice 8.20.k (v2-#8) — cross-SDK
// PairModeStateInvalidTransitionError typed-extension parity.
//
// All three SDKs MUST expose the `from` + `transition` extension
// fields from the RFC 7807 problem-json response as typed
// attributes so customer code can branch on the exact failed
// transition without re-reading the raw problem dict.
//
// Language-specific names:
//   - TypeScript: err.from, err.transition           (readonly properties)
//   - Python:     err.from_, err.transition          (from_ — reserved word)
//   - Go:         err.From, err.Transition           (struct fields)
//
// This guard scans the SDK source for the language-idiomatic
// field declaration; drift to dropping the field on any SDK
// breaks CI.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TS_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const PY_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');
const GO_ERRORS = resolve(REPO_ROOT, 'packages/sdk-go/errors.go');

describe('Arc 4 Wave 2.B sub-slice 8.20.k cross-SDK PairModeStateInvalidTransitionError field parity', () => {
  it('TypeScript SDK exposes readonly from + transition', () => {
    const body = readFileSync(TS_ERRORS, 'utf8');
    const m = body.match(
      /class PairModeStateInvalidTransitionError extends DriftstackError \{[\s\S]+?\n\}/,
    );
    expect(m, 'TS class declaration must be findable').not.toBeNull();
    const block = m![0];
    expect(block).toMatch(/readonly from: string;/);
    expect(block).toMatch(/readonly transition: string;/);
    // Construction-time assignment from problem-json envelope.
    expect(block).toMatch(/this\.from = .*\.from/);
    expect(block).toMatch(/this\.transition = .*\.transition/);
  });

  it('Python SDK exposes from_ + transition on the class', () => {
    const body = readFileSync(PY_ERRORS, 'utf8');
    // The class body extends through the __init__ method; match the
    // assignment statements explicitly.
    const m = body.match(
      /class PairModeStateInvalidTransitionError\(DriftstackError\):[\s\S]+?\n {8}self\.transition: str = str\(p\.get\("transition", ""\)\)/,
    );
    expect(m, 'Python class must declare from_ + transition assignments').not.toBeNull();
    expect(body).toMatch(/self\.from_: str = str\(p\.get\("from", ""\)\)/);
    expect(body).toMatch(/self\.transition: str = str\(p\.get\("transition", ""\)\)/);
  });

  it('Go SDK exposes From + Transition struct fields', () => {
    const body = readFileSync(GO_ERRORS, 'utf8');
    const m = body.match(/type PairModeStateInvalidTransitionError struct \{[\s\S]+?\}/);
    expect(m, 'Go struct must declare From + Transition').not.toBeNull();
    const block = m![0];
    expect(block).toMatch(/\n\s*From\s+string/);
    expect(block).toMatch(/\n\s*Transition\s+string/);
  });

  it('TS readonly properties cannot be reassigned — types enforce the immutability contract', () => {
    const body = readFileSync(TS_ERRORS, 'utf8');
    // Both fields MUST be declared readonly (not just `from: string`).
    // Drift to removing readonly would let customer code mutate the
    // error post-construction, breaking the "typed evidence of the
    // failed transition" contract.
    expect(body).toMatch(/readonly from: string;[\s\S]*readonly transition: string;/);
  });

  // Arc 4 Wave 2.B sub-slice 8.20.k.3 — extend the parity guard to
  // cover the OTHER two typed-extension errors in the v2-#8 +
  // bundled-LLM surface so all three SDKs stay in lockstep.
  describe('PairModeConflictError.winnerClientId / WinnerClientID / winner_client_id', () => {
    it('TypeScript exposes readonly winnerClientId', () => {
      const body = readFileSync(TS_ERRORS, 'utf8');
      expect(body).toMatch(/class PairModeConflictError extends DriftstackError \{/);
      expect(body).toMatch(/readonly winnerClientId: string;/);
      expect(body).toMatch(/this\.winnerClientId = .*\.winner_client_id/);
    });

    it('Python exposes self.winner_client_id assignment in __init__', () => {
      const body = readFileSync(PY_ERRORS, 'utf8');
      expect(body).toMatch(/class PairModeConflictError\(DriftstackError\):/);
      expect(body).toMatch(/self\.winner_client_id: str = str\(p\.get\("winner_client_id", ""\)\)/);
    });

    it('Go exposes WinnerClientID struct field', () => {
      const body = readFileSync(GO_ERRORS, 'utf8');
      const m = body.match(/type PairModeConflictError struct \{[\s\S]+?\}/);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/\n\s*WinnerClientID\s+string/);
    });
  });

  describe('BundledLlmBudgetExhaustedError.spentCents/SpentCents/spent_cents + capCents/CapCents/cap_cents', () => {
    it('TypeScript exposes readonly spentCents + capCents', () => {
      const body = readFileSync(TS_ERRORS, 'utf8');
      expect(body).toMatch(/class BundledLlmBudgetExhaustedError extends DriftstackError \{/);
      expect(body).toMatch(/readonly spentCents: number;/);
      expect(body).toMatch(/readonly capCents: number;/);
      expect(body).toMatch(/this\.spentCents = .*\.spent_cents/);
      expect(body).toMatch(/this\.capCents = .*\.cap_cents/);
    });

    it('Python exposes self.spent_cents + self.cap_cents in __init__', () => {
      const body = readFileSync(PY_ERRORS, 'utf8');
      expect(body).toMatch(/class BundledLlmBudgetExhaustedError\(DriftstackError\):/);
      expect(body).toMatch(/self\.spent_cents: int = _coerce_int\(p\.get\("spent_cents"\)\)/);
      expect(body).toMatch(/self\.cap_cents: int = _coerce_int\(p\.get\("cap_cents"\)\)/);
    });

    it('Go exposes SpentCents + CapCents struct fields', () => {
      const body = readFileSync(GO_ERRORS, 'utf8');
      const m = body.match(/type BundledLlmBudgetExhaustedError struct \{[\s\S]+?\}/);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/\n\s*SpentCents\s+int/);
      expect(m![0]).toMatch(/\n\s*CapCents\s+int/);
    });
  });
});
