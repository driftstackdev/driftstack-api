// V-917 — five test files independently decide "has customer egress shipped?",
// and that decision gates what the marketing and trust pages may claim.
//
// V-540.E (2026-05-16) tightened the gate to require the CONCRETE wire: the
// SessionEgressService bootstrapped into AppDeps AND a backend class that
// implements it. Its stated reason is that interface-alone scaffolding must not
// count as shipped. That tightening reached `trust-index-doc-parity` and
// `marketing-egress-claim-sweep`. Three other files kept the original form:
//
//   /customerEgress|egress_config|proxyUrl|SOCKS5/i
//
// which is true if ANY file under apps/server/src so much as mentions SOCKS5.
// Twenty-one do, and `lib/webhook-target-guard.ts` is one of them — it blocks
// proxy schemes as SSRF targets and has nothing to do with customer egress.
// So three guards protecting customer-facing claims retired on a substring in
// an unrelated file, which is precisely what V-540.E ruled out.
//
// Both forms evaluate true today, because egress really did ship, so there is
// no live divergence to point at. That is the reason to pin it rather than to
// shrug: the window where the loose gate was true and the strict one was not
// has already closed, silently, and nothing recorded that it happened.
//
// This guard exists because a fix applied to two of five files is the failure
// mode, not the loose regex itself. Pinning the three would freeze today's
// text; deriving the rule catches the sixth file somebody adds next.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DIR = resolve(HERE);
const SELF = 'the-egress-claim-gate-has-one-definition.test.ts';

/** The two halves of the canonical V-540.E gate, as they appear in source. */
const CANONICAL = [
  String.raw`sessionEgressService:\s*sessionEgressService`,
  String.raw`implements SessionEgressService\b`,
] as const;

/** The pre-V-540.E form: true on any mention of SOCKS5 anywhere in the server. */
const REJECTED = String.raw`customerEgress|egress_config|proxyUrl|SOCKS5`;

/**
 * Comments stripped before any arm looks at a file. Every file below explains
 * the rejected pattern in its own header, so a raw scan reports the fix as the
 * defect — the sentinel-versus-retraction collision this sweep keeps hitting.
 * The negative lookbehind keeps `https://` intact.
 */
function code(src: string): string {
  // V-1256 — via the SHARED scanner. A private block-first pass cannot tell that the
  // `/*` in a line comment such as `// … /v1/agent-sessions/* routes` is inside one, and
  // models neither string nor regex literals. `code-only.ts` does both and keeps line
  // numbers.
  return codeOnly(src);
}

/** Every unit test that DEFINES an egress gate — a mention in prose is not one. */
function gateDefiners(): { file: string; body: string }[] {
  return readdirSync(UNIT_DIR)
    .filter((f) => f.endsWith('.test.ts') && f !== SELF)
    .map((f) => ({ file: f, body: code(readFileSync(join(UNIT_DIR, f), 'utf8')) }))
    .filter((f) => /const hasEgressImpl\s*=/.test(f.body));
}

describe('V-917 the egress claim gate has one definition', () => {
  it('CRITICAL the scan finds the files it is supposed to police. The three arms below all report an ABSENCE, so a broken scan returning nothing would satisfy every one of them having checked nothing — this is the arm that makes their emptiness mean something.', () => {
    const found = gateDefiners().map((f) => f.file);
    expect(found.length, 'files defining an egress gate').toBeGreaterThanOrEqual(5);
    // No assertion about SELF being excluded. Two mutation proofs showed there
    // isn't a truthful one available: this file never writes
    // `const hasEgressImpl =`, so the content filter drops it before the name
    // check applies, and `self.includes(REJECTED)` holds for ANY value of
    // REJECTED because the literal defining it is itself in the file. The
    // `f !== SELF` filter stays as defence for a future edit; claiming a test
    // covers it would be the vacuity this guard exists to catch.
    // Named explicitly: if one is renamed away, this fails rather than quietly
    // policing four files and calling it five.
    for (const f of [
      'comparison-page-doc-parity.test.ts',
      'marketing-index-doc-parity.test.ts',
      'trust-index-doc-parity.test.ts',
      'trust-security-overview-doc-parity.test.ts',
      'marketing-egress-claim-sweep.test.ts',
    ]) {
      expect(found, `${f} defines an egress gate`).toContain(f);
    }
  });

  it('CRITICAL every egress gate requires the concrete wire. V-540.E decided that interface-alone scaffolding is not a shipped feature; a gate that disagrees lets a marketing page call egress shipped on the strength of a comment. The rule is derived rather than pinned so the next file to compute a gate is covered too.', () => {
    const offenders = gateDefiners()
      .filter((f) => !CANONICAL.every((c) => f.body.includes(c)))
      .map((f) => f.file);
    expect(
      offenders,
      'these decide whether customer egress shipped without checking that it is wired into AppDeps and backed by an implementation:',
    ).toEqual([]);
  });

  it('CRITICAL no gate uses the pre-V-540.E form. It is true whenever any of the 338 server sources mentions SOCKS5, which includes webhook-target-guard.ts blocking proxy schemes as SSRF targets — unrelated to customer egress and enough on its own to retire three guards over customer-facing claims.', () => {
    const offenders = gateDefiners()
      .filter((f) => f.body.includes(REJECTED))
      .map((f) => f.file);
    expect(offenders, 'these still use the substring gate V-540.E replaced:').toEqual([]);
  });

  it('CRITICAL the gate is never a silent no-op. `if (!hasEgressImpl) { ...assertions... }` reports a pass while asserting nothing the moment the gate retires, and it retired for all five. A conditional skip is visible in the skip count; a silent early return is indistinguishable in the summary from a real check, which is how this survived.', () => {
    const offenders = gateDefiners()
      .filter((f) => /if \(!?hasEgressImpl\)\s*\{/.test(f.body))
      .map((f) => f.file);
    expect(
      offenders,
      'these branch on the gate inside a test body instead of skipping the test, so they pass having checked nothing:',
    ).toEqual([]);
  });
});
