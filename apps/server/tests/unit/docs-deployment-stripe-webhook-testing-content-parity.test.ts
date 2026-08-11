// W554.C — drift guard for /docs/deployment/stripe-webhook-testing.md.
// V-197 wire-level Stripe webhook verification procedures.
// Drift here either weakens the algorithm-vs-wire-separation
// (would let in-process tests be mistaken for end-to-end
// verification), drops the SSH-write-live-keys posture (would
// re-permit chat-readable terminal exposure for whsec_*), or
// weakens the rotation procedure (would lose Stripe-Dashboard-
// first ordering against in-flight retries).
//
//   • V-197. Pairs with stripe-signing-reference-vectors.test.ts.
//   • In-process auto-covered: algorithm + failure modes +
//     idempotency + concurrent-delivery race (V-085) + dispatch.
//   • Wire delivery from Stripe network is NOT covered by
//     integration suite — these procedures close that gap.
//   • Local: stripe listen --forward-to localhost:3000/v1/webhooks/stripe.
//   • Staging: test-mode endpoint, signing-secret via SSH-write.
//   • Production: live-mode endpoint, live keys SSH-write only
//     (never gh-secret-set, never PR diff).
//   • Rotation: Stripe Dashboard "Roll signing secret" FIRST,
//     then SSH-write new secret, then restart server.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/deployment/stripe-webhook-testing.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W554.C /docs/deployment/stripe-webhook-testing.md content parity', () => {
  const body = read(LIB);

  it("Header + V-197 + reference-vectors pairing framing pinned: '# Stripe webhook testing — staging + production verification' + 'V-197 — operational procedures for verifying Stripe webhook delivery end-to-end on staging and (post-launch) production.' + 'Pairs with the reference-vector unit tests in `apps/server/tests/unit/stripe-signing-reference-vectors.test.ts` — those confirm the algorithm is correct in-process; the procedures below confirm the wire is correct between Stripe and our endpoint.' — pinned so the V-197-operational-procedures + reference-vector-test-pairing + algorithm-vs-wire-separation commitment survives", () => {
    expect(body).toMatch(/^# Stripe webhook testing — staging \+ production verification$/m);
    expect(body).toMatch(/V-197 — operational procedures for verifying Stripe webhook delivery/);
    expect(body).toMatch(/end-to-end on staging and \(post-launch\) production\./);
    expect(body).toMatch(/Pairs with the/);
    expect(body).toMatch(/reference-vector unit tests in/);
    expect(body).toMatch(
      /`apps\/server\/tests\/unit\/stripe-signing-reference-vectors\.test\.ts` —/,
    );
    expect(body).toMatch(/those confirm the algorithm is correct in-process; the procedures/);
    expect(body).toMatch(/below confirm the wire is correct between Stripe and our endpoint\./);
  });

  it("In-process auto-covered framing pinned: '**Algorithm correctness** — `verifyStripeSignature` is tested against HMAC-SHA256 reference vectors computed by `openssl dgst -sha256-hmac`' + '**Failure modes** — missing header, invalid signature, wrong secret, malformed header, timestamp outside tolerance window all return 401 with the reason captured in the error body.' + '**Idempotency** — duplicate `event.id` returns 200 with `outcome=duplicate`; only the first is recorded.' + '**Concurrent delivery race** — two concurrent deliveries of the same event end with exactly one ledger row (V-085).' + '**Dispatch** — subscription lifecycle + invoice payment events route to the right handler; unknown event types return `outcome=ignored`.' + 'What the integration suite **does not** cover: actual wire delivery from Stripe's network to our endpoint.' — pinned so the 5-auto-covered (algorithm + failure-modes + idempotency + V-085-concurrent-race + dispatch-ignored) + does-not-cover-wire-delivery commitment survives", () => {
    expect(body).toMatch(
      /- \*\*Algorithm correctness\*\* — `verifyStripeSignature` is tested against/,
    );
    expect(body).toMatch(/HMAC-SHA256 reference vectors computed by `openssl dgst -sha256/);
    expect(body).toMatch(/-hmac`\. If our impl drifts from Stripe's algorithm, those tests fail/);
    expect(body).toMatch(
      /- \*\*Failure modes\*\* — missing header, invalid signature, wrong secret,/,
    );
    expect(body).toMatch(/malformed header, timestamp outside tolerance window all return/);
    expect(body).toMatch(/401 with the reason captured in the error body\./);
    expect(body).toMatch(/- \*\*Idempotency\*\* — duplicate `event\.id` returns 200 with/);
    expect(body).toMatch(/`outcome=duplicate`; only the first is recorded\./);
    expect(body).toMatch(
      /- \*\*Concurrent delivery race\*\* — two concurrent deliveries of the same/,
    );
    expect(body).toMatch(/event end with exactly one ledger row \(V-085\)\./);
    expect(body).toMatch(
      /- \*\*Dispatch\*\* — subscription lifecycle \+ invoice payment events route/,
    );
    expect(body).toMatch(/to the right handler; unknown event types return/);
    expect(body).toMatch(/`outcome=ignored`\./);
    expect(body).toMatch(/What the integration suite \*\*does not\*\* cover: actual wire delivery/);
    expect(body).toMatch(/from Stripe's network to our endpoint\./);
  });

  it("Local + Staging procedure framing pinned. V-755 CORRECTED the env var name in both procedures: the server reads STRIPE_WEBHOOK_SECRET (config.ts), and setting STRIPE_WEBHOOK_SIGNING_SECRET instead leaves POST /v1/webhooks/stripe UNREGISTERED — Stripe's deliveries 404 and no subscription event is ever processed, so customers pay without being upgraded. The wrong name almost certainly came from the app-level dep being called stripeWebhookSigningSecret. Still pins the SSH-write-never-chat-or-PR commitment.", () => {
    expect(body).toMatch(/## Local development — `stripe listen`/);
    expect(body).toMatch(
      /stripe listen --forward-to http:\/\/localhost:3000\/v1\/webhooks\/stripe/,
    );
    expect(body).toMatch(/Set this in your \.env as STRIPE_WEBHOOK_SECRET, restart server\./);
    expect(body).toMatch(/stripe trigger customer\.subscription\.created/);
    expect(body).toMatch(/stripe trigger invoice\.paid/);
    expect(body).toMatch(/## Staging environment/);
    expect(body).toMatch(/Create a \*\*test-mode\*\* webhook endpoint in the Stripe Dashboard/);
    expect(body).toMatch(/pointed at `https:\/\/staging\.driftstack\.dev\/v1\/webhooks\/stripe`/);
    expect(body).toMatch(/SSH into the staging host and write it/);
    expect(body).toMatch(/to the staging \.env \(`STRIPE_WEBHOOK_SECRET=whsec_\.\.\.`\)/);
    // V-755 — the wrong name must not return as an INSTRUCTION. It still appears once,
    // deliberately, inside the warning note explaining why it is wrong.
    expect(body).not.toMatch(/Set this in your \.env as STRIPE_WEBHOOK_SIGNING_SECRET/);
    expect(body).not.toMatch(/\(`STRIPE_WEBHOOK_SIGNING_SECRET=whsec_/);
    expect(body).toMatch(/leaves the endpoint UNREGISTERED/);
    expect(body).toMatch(/per the locked stripe-credential-handling memory — never paste/);
    expect(body).toMatch(/webhook secrets into chat or PR diffs\./);
  });

  it("Production cutover + Replay procedures framing pinned: 'After commercial activation (entity registered + KvK + BV in place)' + '**Live-mode** webhook endpoint in the Stripe Dashboard pointed at `https://api.driftstack.dev/v1/webhooks/stripe`.' + 'Live-mode signing secret goes via SSH-write to the prod .env per the stripe-credential-handling memory (live keys NEVER through chat or PR).' + '**Before** enabling the endpoint, send a test webhook from the Dashboard's \"Send test webhook\" UI. Confirm 200 + ledger row before flipping the endpoint to `enabled` in Stripe.' + '## Replay procedures' + 'If transient (network blip / our server briefly down), Stripe auto-retries with exponential backoff for ~3 days.' + 'To force-replay manually: Stripe Dashboard → event detail → \"Resend webhook\". Our endpoint returns `outcome=duplicate` if the first delivery did get recorded' — pinned so the commercial-activation-entity-registered + live-mode-api.driftstack.dev + SSH-write-live-keys-NEVER-chat-or-PR + Send-test-webhook-before-enable + ~3-day-auto-retry + outcome=duplicate-on-replay commitment survives", () => {
    expect(body).toMatch(
      /After commercial activation \(entity registered \+ KvK \+ BV in place\):/,
    );
    expect(body).toMatch(
      /1\. \*\*Live-mode\*\* webhook endpoint in the Stripe Dashboard pointed at/,
    );
    expect(body).toMatch(/`https:\/\/api\.driftstack\.dev\/v1\/webhooks\/stripe`/);
    expect(body).toMatch(/Live-mode signing secret goes via SSH-write to the prod \.env per/);
    expect(body).toMatch(/the stripe-credential-handling memory \(live keys NEVER through/);
    expect(body).toMatch(/chat or PR\)\./);
    expect(body).toMatch(/\*\*Before\*\* enabling the endpoint, send a test webhook from the/);
    expect(body).toMatch(/Dashboard's "Send test webhook" UI\. Confirm 200 \+ ledger row/);
    expect(body).toMatch(/before flipping the endpoint to `enabled` in Stripe\./);
    expect(body).toMatch(/## Replay procedures/);
    expect(body).toMatch(/If transient \(network blip \/ our server briefly down\), Stripe/);
    expect(body).toMatch(/auto-retries with exponential backoff for ~3 days\./);
    expect(body).toMatch(/To force-replay manually: Stripe Dashboard → event detail →/);
    expect(body).toMatch(/"Resend webhook"\. Our endpoint returns `outcome=duplicate` if the/);
    expect(body).toMatch(/first delivery did get recorded;/);
  });

  it("Failure-mode rotation + Standing observability framing pinned: '## Failure-mode rotation' + 'Rotate in the Stripe Dashboard first**: Webhooks → endpoint → \"Roll signing secret\". This invalidates the old secret instantly' + 'SSH-write the new secret to the prod .env.' + 'Restart the server (or send SIGHUP if hot-reload is wired).' + 'Audit the period the old secret was live for any unauthorized webhook deliveries' + '## Standing observability' + 'Log line per webhook delivery: `verifyStripeSignature` reason emitted on every 401. Set up a Sentry alert for sustained `invalid_signature`' — pinned so the Dashboard-first-rotation + SSH-write-new-secret + restart-or-SIGHUP + audit-old-secret-period + Sentry-invalid_signature-alert commitment survives", () => {
    expect(body).toMatch(/## Failure-mode rotation/);
    expect(body).toMatch(/1\. \*\*Rotate in the Stripe Dashboard first\*\*: Webhooks → endpoint →/);
    expect(body).toMatch(/"Roll signing secret"\. This invalidates the old secret instantly;/);
    expect(body).toMatch(/2\. SSH-write the new secret to the prod \.env\./);
    expect(body).toMatch(/3\. Restart the server \(or send SIGHUP if hot-reload is wired\)\./);
    expect(body).toMatch(/4\. Audit the period the old secret was live for any unauthorized/);
    expect(body).toMatch(/webhook deliveries/);
    expect(body).toMatch(/## Standing observability/);
    expect(body).toMatch(/- Log line per webhook delivery: `verifyStripeSignature` reason/);
    expect(body).toMatch(/emitted on every 401\. Set up a Sentry alert for sustained/);
    expect(body).toMatch(/`invalid_signature` \(would indicate either a misconfigured Stripe/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
