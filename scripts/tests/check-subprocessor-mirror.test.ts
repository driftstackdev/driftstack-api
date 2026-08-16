// The sub-processor mirror linter actually detects drift, in both directions.
//
// `check-subprocessor-mirror.mjs` runs inside `npm run lint`, which CI runs. It
// keeps the customer-facing sub-processor list in lockstep with DPA Annex 3,
// because adding or removing a sub-processor is an Article 28(2) GDPR amendment
// and forces a customer re-acceptance flow — silent drift is a compliance bug,
// not doc rot.
//
// It had no test. A compliance guard that quietly stopped detecting drift would
// go on printing "✓ subprocessor mirror check passed" while the two surfaces
// diverged, which is worse than having no linter, because it reads as active
// protection. These arms are about the LINTER, not the current data: they pass
// synthetic lists in so they keep meaning the same thing when a real
// sub-processor is added.

import { describe, expect, it } from 'vitest';
import { compareSubprocessorLists } from '../check-subprocessor-mirror.mjs';

describe('sub-processor mirror comparison', () => {
  it('reports no drift when both surfaces name the same vendors', () => {
    const verdict = compareSubprocessorLists({
      publicNames: ['Hetzner', 'Cloudflare'],
      dpaNames: ['Hetzner Online GmbH', 'Cloudflare, Inc.'],
    });
    expect(verdict).toEqual({ missingFromPublic: [], missingFromDpa: [] });
  });

  it('CRITICAL catches a vendor in the DPA that customers were never told about', () => {
    // The direction that matters most: a sub-processor is contracted and
    // annexed, and the public page never mentions it.
    const verdict = compareSubprocessorLists({
      publicNames: ['Hetzner'],
      dpaNames: ['Hetzner Online GmbH', 'Twilio Ireland Limited'],
    });
    expect(verdict.missingFromPublic).toEqual(['Twilio Ireland Limited']);
    expect(verdict.missingFromDpa).toEqual([]);
  });

  it('CRITICAL catches a vendor published to customers that the DPA never annexed', () => {
    const verdict = compareSubprocessorLists({
      publicNames: ['Hetzner', 'Twilio'],
      dpaNames: ['Hetzner Online GmbH'],
    });
    expect(verdict.missingFromDpa).toEqual(['Twilio']);
    expect(verdict.missingFromPublic).toEqual([]);
  });

  it('allows the documented Stripe split — two annex rows resolving to one public entry', () => {
    const verdict = compareSubprocessorLists({
      publicNames: ['Stripe'],
      dpaNames: ['Stripe Payments Europe Ltd', 'Stripe, Inc.'],
    });
    expect(verdict).toEqual({ missingFromPublic: [], missingFromDpa: [] });
  });

  it('CRITICAL does not match two unrelated vendors on a shared entity suffix', () => {
    // The matcher works on distinctive tokens with entity suffixes stripped.
    // Without that stripping, "Twilio Ireland Limited" and "Acme Limited" share
    // "limited" and each would satisfy the other — drift in BOTH directions
    // would report clean, and the linter would be decorative.
    const verdict = compareSubprocessorLists({
      publicNames: ['Acme Limited'],
      dpaNames: ['Twilio Ireland Limited'],
    });
    expect(verdict.missingFromPublic).toEqual(['Twilio Ireland Limited']);
    expect(verdict.missingFromDpa).toEqual(['Acme Limited']);
  });

  it('treats an empty public list as every annex row being unpublished', () => {
    const verdict = compareSubprocessorLists({
      publicNames: [],
      dpaNames: ['Hetzner Online GmbH'],
    });
    expect(verdict.missingFromPublic).toEqual(['Hetzner Online GmbH']);
  });
});
