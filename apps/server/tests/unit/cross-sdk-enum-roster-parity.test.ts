// v2-#14 — cross-SDK enum roster parity.
//
// Pins the customer-visible enum values across the 3 SDKs against
// the api-types Zod source-of-truth. Drift on ANY SDK fails the
// test at CI time.
//
// Covered enums:
//   - SessionStatus (5 values)
//   - SessionPurpose (3 values; V-169)
//   - CaptureKind (3 values)
//   - WebhookDeliveryStatus (5 values)
//   - WebhookEventType (9 values)
//
// Source-of-truth in `packages/api-types/src/sessions.ts` +
// `packages/api-types/src/webhooks.ts`. The Python SDK consumes the
// regenerated `_generated/models.py` (datamodel-codegen output);
// the Go SDK has hand-maintained const declarations.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SessionStatusSchema,
  SessionPurposeSchema,
  CaptureKindSchema,
  WebhookDeliveryStatusSchema,
  WebhookEventTypeSchema,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const SDK_PYTHON_GENERATED = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/_generated/models.py',
);
const SDK_GO_TYPES = resolve(REPO_ROOT, 'packages/sdk-go/types.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2-#14 cross-SDK enum roster parity', () => {
  it('canonical files exist at the expected paths', () => {
    expect(existsSync(SDK_PYTHON_GENERATED)).toBe(true);
    expect(existsSync(SDK_GO_TYPES)).toBe(true);
  });

  it('CRITICAL SessionStatus — 5 values (creating, ready, busy, destroyed, errored) across api-types + Python + Go SDKs', () => {
    const expected = ['creating', 'ready', 'busy', 'destroyed', 'errored'];
    expect(SessionStatusSchema.options).toEqual(expected);

    const py = read(SDK_PYTHON_GENERATED);
    expect(py).toMatch(/status: Literal\["creating", "ready", "busy", "destroyed", "errored"\]/);

    const go = read(SDK_GO_TYPES);
    expect(go).toMatch(/SessionCreating\s+SessionStatus = "creating"/);
    expect(go).toMatch(/SessionReady\s+SessionStatus = "ready"/);
    expect(go).toMatch(/SessionBusy\s+SessionStatus = "busy"/);
    expect(go).toMatch(/SessionDestroyed SessionStatus = "destroyed"/);
    expect(go).toMatch(/SessionErrored\s+SessionStatus = "errored"/);
  });

  it('CRITICAL SessionPurpose — 3 values (production_customer, cumulative_rig_validation, test_domain_probe) per V-169 across api-types + Python + Go', () => {
    const expected = ['production_customer', 'cumulative_rig_validation', 'test_domain_probe'];
    expect(SessionPurposeSchema.options).toEqual(expected);

    const py = read(SDK_PYTHON_GENERATED);
    // pydantic emits multi-line Literal for longer tuples.
    expect(py).toMatch(/"production_customer", "cumulative_rig_validation", "test_domain_probe"/);

    const go = read(SDK_GO_TYPES);
    expect(go).toMatch(/PurposeProductionCustomer\s+SessionPurpose = "production_customer"/);
    expect(go).toMatch(
      /PurposeCumulativeRigValidation SessionPurpose = "cumulative_rig_validation"/,
    );
    expect(go).toMatch(/PurposeTestDomainProbe\s+SessionPurpose = "test_domain_probe"/);
  });

  it('CRITICAL CaptureKind — 3 values (screenshot, dom_snapshot, pdf) across api-types + Python + Go', () => {
    const expected = ['screenshot', 'dom_snapshot', 'pdf'];
    expect(CaptureKindSchema.options).toEqual(expected);

    const py = read(SDK_PYTHON_GENERATED);
    expect(py).toMatch(/Literal\["screenshot", "dom_snapshot", "pdf"\]/);

    const go = read(SDK_GO_TYPES);
    // Go uses descriptive const names; verify the underlying string
    // literals appear in const declarations.
    expect(go).toMatch(/"screenshot"/);
    expect(go).toMatch(/"dom_snapshot"/);
    expect(go).toMatch(/"pdf"/);
  });

  it('CRITICAL WebhookDeliveryStatus — 5 values (pending, in_flight, delivered, failed, dlq) across api-types + Go', () => {
    const expected = ['pending', 'in_flight', 'delivered', 'failed', 'dlq'];
    expect(WebhookDeliveryStatusSchema.options).toEqual(expected);

    const go = read(SDK_GO_TYPES);
    expect(go).toMatch(/DeliveryPending\s+WebhookDeliveryStatus = "pending"/);
    expect(go).toMatch(/DeliveryInFlight\s+WebhookDeliveryStatus = "in_flight"/);
    expect(go).toMatch(/DeliveryDelivered WebhookDeliveryStatus = "delivered"/);
    expect(go).toMatch(/DeliveryFailed\s+WebhookDeliveryStatus = "failed"/);
    expect(go).toMatch(/DeliveryDLQ\s+WebhookDeliveryStatus = "dlq"/);
  });

  it('CRITICAL WebhookEventType — closed roster across api-types + Go', () => {
    // WebhookEventType: exact emitted roster (test.ping = V-356 synthetic;
    // session.egress_capability_changed = Arc 5 EGRESS eg.7; the crypto pair
    // = V-666). .toEqual (not .toContain) so a FUTURE roster addition fails
    // here — matching the other enums above + closing the subset-check gap
    // that let the egress + crypto pair drift out of the Go SDK unnoticed.
    expect(WebhookEventTypeSchema.options).toEqual([
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'session.egress_capability_changed',
      'test.ping',
      'crypto.order.paid',
      'crypto.order.failed',
      'session.challenge_detected',
      'session.profile_save_failed',
    ]);

    const go = read(SDK_GO_TYPES);
    expect(go).toMatch(/"session\.completed"/);
    expect(go).toMatch(/"session\.failed"/);
    expect(go).not.toMatch(/"quota\.warning_80pct"/);
    expect(go).not.toMatch(/"quota\.exceeded"/);
    expect(go).toMatch(/"api_key\.revoked"/);
    expect(go).toMatch(/"session\.egress_capability_changed"/);
    expect(go).toMatch(/"test\.ping"/);
    expect(go).toMatch(/"crypto\.order\.paid"/);
    expect(go).toMatch(/"crypto\.order\.failed"/);
    expect(go).toMatch(/"session\.challenge_detected"/);
    expect(go).toMatch(/"session\.profile_save_failed"/);
  });

  it('CRITICAL no SDK exports an enum value that api-types does NOT — drift would surface customer-visible values without a source-of-truth pin', () => {
    // Walk the Go const declarations for SessionStatus / SessionPurpose
    // / WebhookDeliveryStatus and verify each value is in the Zod
    // enum's option list. This catches "Go added a value Python +
    // api-types do not have" drift.
    const go = read(SDK_GO_TYPES);

    const statusRe = /SessionStatus = "([^"]+)"/g;
    const purposeRe = /SessionPurpose = "([^"]+)"/g;
    const deliveryRe = /WebhookDeliveryStatus = "([^"]+)"/g;

    const collect = (re: RegExp): string[] => {
      const out: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(go)) !== null) {
        if (m[1]) out.push(m[1]);
      }
      return out;
    };

    for (const v of collect(statusRe)) {
      expect(SessionStatusSchema.options as readonly string[]).toContain(v);
    }
    for (const v of collect(purposeRe)) {
      expect(SessionPurposeSchema.options as readonly string[]).toContain(v);
    }
    for (const v of collect(deliveryRe)) {
      expect(WebhookDeliveryStatusSchema.options as readonly string[]).toContain(v);
    }
  });

  it('test file metadata — exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-enum-roster-parity.test.ts')),
    ).toBe(true);
  });
});
