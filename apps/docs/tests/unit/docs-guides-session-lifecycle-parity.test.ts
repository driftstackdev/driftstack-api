// W259.D — drift-guard for docs.driftstack.io/guides/session-lifecycle.
// Pins:
// 1. Concurrent-cap table matches TIER_CONCURRENT_SESSION_LIMITS.
// 2. Session webhook events match SubscribableWebhookEventTypeSchema
//    (`session.completed` + `session.failed`, NOT the legacy
//    `session.created` / `session.destroyed` / `session.error`).
// 3. Profile-cap exceeded returns 429 tier-limit (not 402).
// 4. Trial-pack credit-exhausted claim removed (the live 429 path has
//    no `trial_pack_exhausted` problem-type slug).
// 5. No fictional PaymentRequiredError SDK class.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TIER_CONCURRENT_SESSION_LIMITS,
  SubscribableWebhookEventTypeSchema,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/session-lifecycle.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W259.D docs/guides/session-lifecycle ↔ live session surface parity', () => {
  const doc = read(DOC);

  it('concurrent-cap table values match TIER_CONCURRENT_SESSION_LIMITS', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.solo_manual).toBe(1);
    expect(TIER_CONCURRENT_SESSION_LIMITS.team_manual).toBe(3);
    expect(TIER_CONCURRENT_SESSION_LIMITS.agency_manual).toBe(8);
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_starter).toBe(2);
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_builder).toBe(8);
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_scale).toBe(24);
    // The doc must reproduce these values verbatim.
    for (const cap of [1, 3, 8, 2, 8, 24]) {
      expect(doc).toMatch(new RegExp(`\\|\\s*${cap}\\s*\\|`));
    }
  });

  it('webhook events list matches SubscribableWebhookEventTypeSchema for session.*', () => {
    const sessionEvents = SubscribableWebhookEventTypeSchema.options.filter((e) =>
      e.startsWith('session.'),
    );
    // Arc 5 EGRESS eg.7.e added session.egress_capability_changed;
    // W393 added session.challenge_detected (challenge-handling);
    // A3 W1364 added session.profile_save_failed (save-back failure).
    expect(sessionEvents.sort()).toEqual([
      'session.challenge_detected',
      'session.completed',
      'session.egress_capability_changed',
      'session.failed',
      'session.profile_save_failed',
    ]);
    for (const e of sessionEvents) {
      expect(doc).toMatch(new RegExp(`\`${e}\``));
    }
  });

  it('does not misclassify a superseded profile save as stale or lost state', () => {
    expect(doc).toMatch(/`superseded` is benign/);
    expect(doc).toMatch(/newer saved profile won the conditional write/);
  });

  it('does not advertise the fictional session.created / session.destroyed / session.error events as live bus events', () => {
    expect(doc).not.toMatch(/^- `session\.created`/m);
    expect(doc).not.toMatch(/^- `session\.destroyed`/m);
    expect(doc).not.toMatch(/^- `session\.error`/m);
  });

  it('profile-cap exceeded returns 429 tier-limit (not the legacy 402)', () => {
    expect(doc).not.toMatch(/`402 profile_cap_reached`/);
    expect(doc).not.toMatch(/`402 Payment Required`/);
    expect(doc).toMatch(/429 tier-limit/);
  });

  it('does not cite the fictional PaymentRequiredError SDK class', () => {
    expect(doc).not.toMatch(/PaymentRequiredError/);
  });

  it('error-shape list cites real problem-type slugs', () => {
    for (const slug of ['rate-limited', 'concurrency-limit', 'tier-limit', 'session-destroyed']) {
      expect(doc).toMatch(new RegExp(`errors\\.driftstack\\.dev\\/${slug}`));
    }
  });

  it('cross-link targets exist', () => {
    expect(doc).toMatch(/\/guides\/profile-management/);
    expect(doc).toMatch(/\/webhooks\/events/);
    expect(doc).toMatch(/\/api\/versioning/);
    expect(doc).toMatch(/\/reference\/errors/);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
  // V-754 — the guide framed session.egress_capability_changed as a TRANSITION signal
  // ("state changed ... react to capability transitions without polling"). There is no
  // change detection on the path: ingestEgressCapabilityReport's own docstring says the
  // event "fires on every successful persist", and the repo write sets
  // egressCapabilities unconditionally with no comparison to the prior value. A
  // subscriber that treated each event as a change would act on identical repeats.
  // The authoritative catalog page (webhooks/events.md) was already correct — this
  // guide and the marketing page were the surfaces that drifted.
  it('V-754 egress_capability_changed is described as per-report, not as a transition', () => {
    expect(doc).toMatch(/It fires on \*\*every\*\* report, not only when the state/);
    expect(doc).toMatch(/there is no change detection on the path/);
    // warnings mixes streaming faults into an egress-named event; customers alarming on
    // egress need to know that.
    expect(doc).toMatch(/streaming_blank/);
    // The transition framing must not return.
    expect(doc).not.toMatch(/capability transitions without polling/);
  });
});
