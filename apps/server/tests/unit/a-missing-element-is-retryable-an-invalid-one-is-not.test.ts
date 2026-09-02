// `intent_element_not_found` exists so the executor can tell two failures apart
// that the harness used to report under one code.
//
// An INVALID selector is a planning fault: the request itself has to change, and
// replaying it is pure latency. An element that is simply NOT THERE is page
// state: the lookup ran, nothing executed, and the commonest cause is timing —
// the page was still settling, or the element appears after an interaction.
//
// Merged under `intent_invalid_parameter` the executor could never recover from
// the recoverable half, and the word "parameter" pointed every reader at the
// selector: two rounds of CSS-dialect and planning work were spent above a
// failure that happened a layer below.
//
// These arms pin the SPLIT, not either code in isolation — the pair is the
// property. A guard on the new code alone would still pass if the old one were
// quietly given the same handling, which would restore the conflation.

import { describe, it, expect } from 'vitest';
import {
  HARNESS_ERROR_CODES,
  HarnessErrorCodeSchema,
} from '../../src/schemas/harness-control-protocol.js';
import { intentResultToCustomer } from '../../src/services/agent-intent-result.js';
import type { AgentIntent } from '@driftstack/api-types';

const TAP: AgentIntent = {
  kind: 'interact',
  action: 'tap',
  selector: 'a[href*="signup"]',
};

/** Drive the REAL exported boundary, not `diagnose` — that is module-private,
 *  and the property customers see is the whole result, not the helper. */
function failed(code: string) {
  const res = intentResultToCustomer(TAP, {
    success: false,
    errorCode: code as never,
    errorMessage: 'element not found for selector: a[href*="signup"]',
  } as never);
  if (res.kind !== 'failure') throw new Error('expected a failure result');
  return res;
}
const diagnose = (code: string) => failed(code).diagnosis;

describe('the decode enum accepts the code before the harness emits it', () => {
  it('carries intent_element_not_found', () => {
    // ⚠️ This half must ship FIRST. An unknown code fails the intent-result
    // envelope, the correlator drops the frame, and the dispatch hangs to its
    // timeout instead of failing cleanly — the trap the protocol file documents
    // for two prior codes. The harness gates emission behind a flag until this
    // is deployed.
    expect(HARNESS_ERROR_CODES).toContain('intent_element_not_found');
    expect(HarnessErrorCodeSchema.safeParse('intent_element_not_found').success).toBe(true);
  });

  it('still accepts the code it was split out of', () => {
    // Vacuity control: the split ADDS a code, it does not replace one. The
    // harness emits the old code until the flag flips, and a decode that
    // stopped accepting it would hang every dispatch in exactly the way the
    // ordering above exists to prevent.
    expect(HarnessErrorCodeSchema.safeParse('intent_invalid_parameter').success).toBe(true);
  });
});

describe('a missing element is retryable; an invalid one is not', () => {
  it('diagnoses a missing element as element_not_found AND retryable', () => {
    const d = diagnose('intent_element_not_found');
    expect(d?.category).toBe('element_not_found');
    expect(d?.retryable).toBe(true);
  });

  it('keeps an invalid parameter unretryable', () => {
    // The other side of the split. If this ever reports retryable the two codes
    // have collapsed back together and the distinction buys nothing.
    const d = diagnose('intent_invalid_parameter');
    expect(d?.category).toBe('invalid_request');
    expect(d?.retryable).toBe(false);
  });

  it('gives the two codes DIFFERENT handling', () => {
    // The property is the difference itself. Stated directly so a change that
    // makes both codes behave alike fails here even if someone updates the two
    // arms above to match each other.
    const missing = diagnose('intent_element_not_found');
    const invalid = diagnose('intent_invalid_parameter');
    expect(missing?.retryable).not.toBe(invalid?.retryable);
    expect(missing?.category).not.toBe(invalid?.category);
  });

  it('says which failure it was in the customer-facing reason', () => {
    // The prose has to move with the code, or the split is invisible to the
    // human reading the transcript — the audience that was misdirected first.
    const res = failed('intent_element_not_found');
    expect(res.reason).toContain('no element on the page matched this selector');
    expect(res.reason).not.toContain('a parameter was invalid');
  });
});
