// V-487 — bounded-cardinality contract for the
// `driftstack_nowpayments_webhook_total{outcome}` counter as emitted
// by POST /v1/webhooks/nowpayments.
//
// Outcome label is one of 5 values:
//
//   signature_missing — no x-nowpayments-sig header on the request
//   empty_body        — POST with no body bytes (defensive)
//   signature_invalid — HMAC mismatch (caller used wrong IPN secret)
//   malformed_event   — signature valid, but JSON body doesn't parse
//                       to the expected event shape
//   ok                — signature valid + event dispatched
//
// Same pattern as lk3-livekit-token-outcome-bounded-set-parity +
// lk2-mac-nodes-register-outcome-bounded-set-parity: the integration
// test exercises each outcome via fixtures, this parity test enforces
// the bounded set at the source level so a new `bumpOutcome('new')`
// trips a drift-guard before silently inflating Prometheus
// cardinality. Two-layer coverage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts');

const ALLOWED_OUTCOMES = [
  'signature_missing',
  'empty_body',
  'signature_invalid',
  'malformed_event',
  'ok',
] as const;

describe('V-487 nowpayments-webhook outcome bounded-set parity', () => {
  it('route file exists at the canonical path', () => {
    const body = readFileSync(ROUTE, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('every `bumpOutcome(...)` call uses a label from the 5-element allowed set', () => {
    const body = readFileSync(ROUTE, 'utf8');
    // Match `bumpOutcome('label')` — single-quoted label, with the
    // first character a lowercase letter so the const-declaration on
    // line 60 doesn't get caught (that line has `const bumpOutcome =`,
    // no parenthesised string literal).
    const matches = [...body.matchAll(/\bbumpOutcome\(\s*'([a-z_]+)'\s*\)/g)];
    expect(matches.length, 'expected at least one bumpOutcome() call').toBeGreaterThan(0);
    const observed = new Set(matches.map((m) => m[1]!));
    for (const label of observed) {
      expect(
        ALLOWED_OUTCOMES.includes(label as (typeof ALLOWED_OUTCOMES)[number]),
        `bumpOutcome('${label}') not in allowed set [${ALLOWED_OUTCOMES.join(', ')}] — drift would explode Prometheus cardinality`,
      ).toBe(true);
    }
  });

  it('all 5 documented outcomes are wired (signature_missing + empty_body + signature_invalid + malformed_event + ok)', () => {
    const body = readFileSync(ROUTE, 'utf8');
    for (const label of ALLOWED_OUTCOMES) {
      expect(
        body,
        `bumpOutcome('${label}') wiring missing — orphans the documented outcome path`,
      ).toMatch(new RegExp(`bumpOutcome\\('${label}'\\)`));
    }
  });
});
