// Drift guard for apps/docs/src/pages/webhooks/replay.md. Pins
// the 5-retries-then-DLQ contract, the account-scoped delivery
// ownership check, the response-shape envelope, and the typical
// recovery flow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs webhooks/replay content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Replaying webhook deliveries/);
    expect(body).toMatch(/description: Re-fire a failed or DLQ webhook delivery/);
  });

  it('5-retries-then-DLQ contract pinned: drift to widening/narrowing the retry budget would mismatch the server-side worker config + mislead customers about how soon a delivery lands in DLQ', () => {
    expect(body).toMatch(/retries failed webhook deliveries 5 times with exponential\s+backoff/);
    expect(body).toMatch(/parking them in the DLQ/);
  });

  it('endpoint surface pinned: POST /v1/webhook-deliveries/:deliveryId/replay with empty body (drift to a different verb/path would silently break customers who copy-paste the URL from this doc)', () => {
    expect(body).toMatch(/`POST \/v1\/webhook-deliveries\/:deliveryId\/replay`/);
    expect(body).toMatch(/Request body: `\{\}` \(empty\)/);
  });

  it("account-scoped ownership check pinned: 'delivery must belong to a webhook endpoint your account owns' — drift to cross-account replay would be a real privilege-escalation bug; pinning ensures the doc + the route stay aligned", () => {
    // Whitespace-tolerant throughout. This pin previously hardcoded single
    // spaces after one `\s+`, so it failed when the paragraph was re-wrapped
    // around a corrected sentence — a cosmetic reflow, with the pinned claim
    // completely intact. A pin that breaks on line-wrap position teaches people
    // to avoid rewrapping rather than to keep the claim true.
    expect(body).toMatch(
      /Account-scoped:\s+the\s+delivery\s+must\s+belong\s+to\s+a\s+webhook\s+endpoint\s+your\s+account\s+owns/,
    );
  });

  // This pin said "~30 seconds" from 2026-05-08 until 2026-08-15, and the
  // poller has been 60s since 2026-05-06 — the claim was never true, so this was
  // not drift the pin failed to catch. Its own title named the harm it was
  // preventing ("would mislead customers about how long to wait") while holding
  // the misleading number in place.
  //
  // The cadence is now checked against POLLER_INTERVAL_MS itself in
  // `the-documented-replay-cadence-matches-the-poller`, which reads both sides.
  // What stays here is the text, plus a negative so the old number cannot come
  // back the next time someone tidies this sentence.
  it('worker re-fire timing pinned: the next poll cycle, up to 60 seconds. Drift to a different cadence would mislead customers about how long to wait before checking delivery status', () => {
    expect(body).toMatch(
      /Resets the delivery to `pending` so the worker re-fires it on the next\s+poll cycle — up to 60 seconds/,
    );
    expect(body).not.toMatch(/within ~30 seconds/);
    expect(body).not.toMatch(/Within ~30s the worker re-fires/);
  });

  it('typical recovery flow pinned: 4-step pattern (endpoint down → DLQ → fix → list DLQ → replay each). Drift to dropping the "list DLQ first" step would mislead customers into trying to replay deliveries they can\'t enumerate', () => {
    expect(body).toMatch(/List the DLQ deliveries/);
    expect(body).toMatch(/`GET \/v1\/webhooks\/:webhookId\/deliveries\?status=dlq`/);
    expect(body).toMatch(/Replay each one: `POST \/v1\/webhook-deliveries\/:deliveryId\/replay`/);
  });
});
