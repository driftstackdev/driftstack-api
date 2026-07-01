// Cross-source invariant — the AUP-refusal pattern corpus must be IDENTICAL
// across both AgentDecomposer implementations.
//
// Audit fix (2026-07-01): `AUP_REFUSAL_PATTERNS` used to be duplicated (no
// shared constant) in agent-decomposer-claude.ts and
// agent-decomposer-deterministic.ts — each pinned INDEPENDENTLY, with only a
// byte-identical string-comparison test (this file, in its earlier form)
// standing between the two ever silently diverging. That's the same shape of
// risk this session found ACTUALLY manifested elsewhere (packages/webhook-
// delivery's reference impl vs apps/server's real forward-path service had
// the identical race independently, because nobody was forced to touch both
// when fixing one). Closed at the SOURCE instead of just detecting drift
// after the fact: agent-decomposer-claude.ts now IMPORTS the array from
// agent-decomposer-deterministic.ts rather than keeping its own copy, so
// there is only one array to ever edit. This test now asserts that sharing
// structurally (the import exists, no local duplicate re-appears) rather
// than comparing two independent string blocks for equality.
//
// They must stay identical (now: structurally can't NOT be) because
// `selectAgentDecomposer` (lib/bootstrap.ts) wires the DETERMINISTIC
// decomposer as a CUSTOMER-REACHABLE path: when no Anthropic-key path is
// configured (self-hosted / no-key deployments) or when
// `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic` is set. A drift — a new
// abuse pattern added to one decomposer's pre-filter but not the other —
// would mean WEAKER AUP enforcement on deterministic-path deployments: an
// abuse category the Claude path refuses would slip through on the
// deterministic one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUP_REFUSAL_PATTERNS } from '../../src/services/agent-decomposer-deterministic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', '..', '..', 'apps/server/src/services');

function read(file: string): string {
  return readFileSync(resolve(SRC, file), 'utf8');
}

describe('AUP-refusal corpus cross-decomposer invariant (claude ↔ deterministic)', () => {
  it('agent-decomposer-deterministic.ts exports a non-trivial 5-pattern AUP corpus (sanity — the shared source is not vacuous)', () => {
    expect(AUP_REFUSAL_PATTERNS).toHaveLength(5);
    const joined = AUP_REFUSAL_PATTERNS.map((p) => p.reason).join(' ');
    expect(joined).toMatch(/AUP/);
    expect(AUP_REFUSAL_PATTERNS.some((p) => p.pattern.test('csam'))).toBe(true);
    expect(AUP_REFUSAL_PATTERNS.some((p) => p.pattern.test('generate a deepfake'))).toBe(true);
    expect(AUP_REFUSAL_PATTERNS.some((p) => p.pattern.test('bypass captcha'))).toBe(true);
    expect(AUP_REFUSAL_PATTERNS.some((p) => p.pattern.test('brute force'))).toBe(true);
  });

  it('agent-decomposer-claude.ts IMPORTS AUP_REFUSAL_PATTERNS from the deterministic module rather than defining its own copy — a local re-definition here would silently reopen the drift risk this test exists to close', () => {
    const claudeSrc = read('agent-decomposer-claude.ts');
    expect(claudeSrc).toContain(
      "import { AUP_REFUSAL_PATTERNS } from './agent-decomposer-deterministic.js';",
    );
    // The old shape (a local `const AUP_REFUSAL_PATTERNS: ReadonlyArray<...> = [`
    // definition) must NOT reappear — that's exactly the duplicate this fix removed.
    expect(claudeSrc).not.toMatch(
      /const AUP_REFUSAL_PATTERNS: ReadonlyArray<\{ pattern: RegExp; reason: string \}> = \[/,
    );
  });

  it('agent-decomposer-deterministic.ts is the single source of truth: AUP_REFUSAL_PATTERNS is exported (not just a local const)', () => {
    const deterministicSrc = read('agent-decomposer-deterministic.ts');
    expect(deterministicSrc).toMatch(
      /export const AUP_REFUSAL_PATTERNS: ReadonlyArray<\{ pattern: RegExp; reason: string \}> = \[/,
    );
  });
});
