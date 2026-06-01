// Cross-source invariant — the AUP-refusal pattern corpus must be IDENTICAL
// across both AgentDecomposer implementations.
//
// `AUP_REFUSAL_PATTERNS` is duplicated (no shared constant) in
// agent-decomposer-claude.ts and agent-decomposer-deterministic.ts. Each is
// pinned INDEPENDENTLY today — the Claude unit test asserts the corpus has 5
// patterns + the "identical to the deterministic decomposer's corpus" comment;
// the deterministic content-parity test pins its 5 patterns — but nothing pins
// that the two corpora actually MATCH.
//
// They must stay identical because `selectAgentDecomposer` (lib/bootstrap.ts)
// wires the DETERMINISTIC decomposer as a CUSTOMER-REACHABLE path: when no
// Anthropic-key path is configured (self-hosted / no-key deployments) or when
// `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic` is set. So a drift — a new
// abuse pattern added to one decomposer's pre-filter but not the other — would
// mean WEAKER AUP enforcement on deterministic-path deployments: an abuse
// category the Claude path refuses would slip through on the deterministic one.
// This invariant fails the moment the two corpora diverge.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', '..', '..', 'apps/server/src/services');

// The full `const AUP_REFUSAL_PATTERNS … = [ … ];` block.
const AUP_BLOCK_RE =
  /const AUP_REFUSAL_PATTERNS: ReadonlyArray<\{ pattern: RegExp; reason: string \}> = \[[\s\S]*?\n\];/;

function aupBlock(file: string): string {
  const src = readFileSync(resolve(SRC, file), 'utf8');
  const m = src.match(AUP_BLOCK_RE);
  if (m === null) throw new Error(`AUP_REFUSAL_PATTERNS block not found in ${file}`);
  return m[0];
}

describe('AUP-refusal corpus cross-decomposer invariant (claude ↔ deterministic)', () => {
  const claude = aupBlock('agent-decomposer-claude.ts');
  const deterministic = aupBlock('agent-decomposer-deterministic.ts');

  it('both decomposers define a non-trivial 5-pattern AUP corpus (sanity — extraction is not vacuous)', () => {
    for (const block of [claude, deterministic]) {
      expect(block).toContain('child sexual abuse material');
      expect(block).toContain('deepfake');
      expect(block).toContain('captcha');
      expect(block).toContain('brute');
      // Count only the 5 regex-literal entries (`pattern: /…/`), NOT the
      // `pattern: RegExp` in the array's type annotation.
      expect((block.match(/pattern: \//g) ?? []).length).toBe(5);
    }
  });

  it('the AUP corpus is BYTE-IDENTICAL across both decomposers — a drift would weaken AUP enforcement on the deterministic-path (no-key / self-hosted / forced) deployments', () => {
    expect(deterministic).toBe(claude);
  });
});
