// W619 — drift guard for packages/sdk-typescript/examples/*.ts (8 files).
// Customer-facing usage examples for the TS SDK.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const E = (rel: string) => resolve(REPO_ROOT, `packages/sdk-typescript/examples/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W619 sdk-typescript/examples content parity', () => {
  it('quickstart.ts: tsx invocation + DRIFTSTACK_API_KEY env-gate + create-session(label=quickstart) → navigate(example.com, wait_until=load) → screenshot capture + destroy pinned', () => {
    const body = read(E('quickstart.ts'));
    expect(body).toMatch(/^\/\/ Quickstart: drive a Driftstack session end-to-end\.$/m);
    expect(body).toMatch(
      /Run with: DRIFTSTACK_API_KEY=ds_live_\.\.\. npx tsx examples\/quickstart\.ts/,
    );
    expect(body).toMatch(/^import \{ Driftstack \} from '@driftstack\/sdk';$/m);
    expect(body).toMatch(/const apiKey = process\.env\.DRIFTSTACK_API_KEY;/);
    expect(body).toMatch(/const client = new Driftstack\(\{ apiKey \}\);/);
    expect(body).toMatch(
      /const session = await client\.sessions\.create\(\{ label: 'quickstart' \}\);/,
    );
    expect(body).toMatch(/url: 'https:\/\/example\.com',/);
    expect(body).toMatch(/wait_until: 'load',/);
    expect(body).toMatch(
      /await client\.sessions\.capture\(session\.id, \{ kind: 'screenshot', full_page: false \}\);/,
    );
    expect(body).toMatch(/await client\.sessions\.destroy\(session\.id\);/);
    expect(existsSync(E('quickstart.ts'))).toBe(true);
  });

  it('billing-flow.ts: customer self-serve mirror of /billing page + getState branching (no-sub → createCheckoutSession api_builder monthly with success/cancel urls / has-sub → createPortalSession) pinned (trial_pack block removed 2026-05-27)', () => {
    const body = read(E('billing-flow.ts'));
    expect(body).toMatch(
      /^\/\/ Customer billing self-serve flow — mirror the customer-dashboard$/m,
    );
    expect(body).toMatch(/^\/\/ \/billing page in code form/m);
    expect(body).toMatch(/redirects to a Checkout session URL \(no subscription yet\)/);
    expect(body).toMatch(/opens the Stripe Customer Portal \(has a subscription\)/);
    expect(body).toMatch(/const state = await client\.billing\.getState\(\);/);
    expect(body).toMatch(/if \(state\.subscription === null\) \{/);
    expect(body).toMatch(/await client\.billing\.createCheckoutSession\(\{/);
    expect(body).toMatch(/tier: 'api_builder',/);
    expect(body).toMatch(/billing_period: 'monthly',/);
    expect(body).toMatch(/success_url: 'https:\/\/app\.driftstack\.dev\/billing\?ok=1',/);
    expect(body).toMatch(/cancel_url: 'https:\/\/app\.driftstack\.dev\/billing\?cancelled=1',/);
    expect(body).toMatch(/const portal = await client\.billing\.createPortalSession\(\);/);
    expect(existsSync(E('billing-flow.ts'))).toBe(true);
  });

  it('error-handling.ts: documented error-class hierarchy (ConcurrencyLimitError + DriftstackError + ExpiredKeyError + InvalidKeyError + NotFoundError + RateLimitError + RevokedKeyError + SessionDestroyedError + ValidationError) + instanceof discriminator chain pinned', () => {
    const body = read(E('error-handling.ts'));
    expect(body).toMatch(/^\/\/ Demonstrates catching every documented error class\.$/m);
    expect(body).toMatch(/ConcurrencyLimitError,/);
    expect(body).toMatch(/DriftstackError,/);
    expect(body).toMatch(/ExpiredKeyError,/);
    expect(body).toMatch(/InvalidKeyError,/);
    expect(body).toMatch(/NotFoundError,/);
    expect(body).toMatch(/RateLimitError,/);
    expect(body).toMatch(/RevokedKeyError,/);
    expect(body).toMatch(/SessionDestroyedError,/);
    expect(body).toMatch(/ValidationError,/);
    expect(body).toMatch(/if \(err instanceof NotFoundError\) \{/);
    expect(body).toMatch(/\} else if \(err instanceof SessionDestroyedError\) \{/);
    expect(body).toMatch(/\} else if \(err instanceof ConcurrencyLimitError\) \{/);
    expect(body).toMatch(
      /`tier limit hit: \$\{err\.currentSessions \?\? '\?'\}\/\$\{err\.limit \?\? '\?'\} active`/,
    );
    expect(body).toMatch(/\} else if \(err instanceof RateLimitError\) \{/);
    expect(body).toMatch(
      /`rate limited; sleep \$\{err\.retryAfterSeconds\.toString\(\)\}s before retrying`/,
    );
    expect(body).toMatch(/\} else if \(err instanceof ValidationError\) \{/);
    expect(body).toMatch(/\} else if \(err instanceof InvalidKeyError\) \{/);
    expect(body).toMatch(/\} else if \(err instanceof RevokedKeyError\) \{/);
    expect(body).toMatch(/\} else if \(err instanceof ExpiredKeyError\) \{/);
    expect(body).toMatch(/\} else if \(err instanceof DriftstackError\) \{/);
    expect(existsSync(E('error-handling.ts'))).toBe(true);
  });

  it('pagination.ts: V-118 + V-119 async-iterator + listAllSessions (limit 50) + listProfiles + dlqDeliveriesForFirstWebhook (iterateDeliveries first webhook DLQ filter) pinned', () => {
    const body = read(E('pagination.ts'));
    expect(body).toMatch(/^\/\/ Pagination: walk every session and every webhook delivery using$/m);
    expect(body).toMatch(
      /\/\/ the SDK's async iterators\. The iterators \(V-118 \+ V-119\) handle$/m,
    );
    expect(body).toMatch(/\/\/ cursor handoff automatically — consumer code reads as a normal$/m);
    expect(body).toMatch(/`for await` loop/);
    expect(body).toMatch(
      /for await \(const session of client\.sessions\.iterate\(\{ limit: 50 \}\)\) \{/,
    );
    expect(body).toMatch(/for await \(const profile of client\.profiles\.iterate\(\)\) \{/);
    expect(body).toMatch(/const endpoints = await client\.webhooks\.list\(\);/);
    expect(body).toMatch(
      /for await \(const delivery of client\.webhooks\.iterateDeliveries\(first\.id, \{/,
    );
    expect(body).toMatch(/status: 'dlq',/);
    expect(body).toMatch(/limit: 100,/);
    expect(existsSync(E('pagination.ts'))).toBe(true);
  });

  it('rate-limit-handling.ts: opt-out of automatic retries (retry: { maxAttempts: 0 }) + manual 5-attempt loop + RateLimitError catch + retryAfterSeconds × 1000 sleep pinned', () => {
    const body = read(E('rate-limit-handling.ts'));
    expect(body).toMatch(
      /^\/\/ The SDK's default retry policy already honours 429 \+ Retry-After\./m,
    );
    expect(body).toMatch(/\/\/ example shows how to opt OUT of automatic retries/);
    expect(body).toMatch(/^import \{ Driftstack, RateLimitError \} from '@driftstack\/sdk';$/m);
    expect(body).toMatch(/retry: \{ maxAttempts: 0 \}, \/\/ disable built-in retries/);
    expect(body).toMatch(/for \(let attempt = 0; attempt < 5; attempt\+\+\) \{/);
    expect(body).toMatch(/if \(err instanceof RateLimitError\) \{/);
    expect(body).toMatch(/const wait = err\.retryAfterSeconds \* 1000;/);
    expect(body).toMatch(/await new Promise\(\(resolve\) => setTimeout\(resolve, wait\)\);/);
    expect(existsSync(E('rate-limit-handling.ts'))).toBe(true);
  });

  it('webhook-receiver.ts: node:http server (dep-free) + RAW BYTES + signature verification + emitted core-event switch + 204 OK pinned', () => {
    const body = read(E('webhook-receiver.ts'));
    expect(body).toMatch(
      /^\/\/ Webhook receiver example — verify the signature before processing\.$/m,
    );
    expect(body).toMatch(/Uses Node's stdlib http server to keep the example dep-free\./);
    expect(body).toMatch(/receive RAW BYTES \(not a$/m);
    expect(body).toMatch(/parsed JSON body\), pass them to verifyWebhookSignature/);
    expect(body).toMatch(
      /import \{ createServer, type IncomingMessage, type ServerResponse \} from 'node:http';/,
    );
    expect(body).toMatch(/import \{ verifyWebhookSignature \} from '@driftstack\/sdk';/);
    expect(body).toMatch(
      /const SECRET = process\.env\.DRIFTSTACK_WEBHOOK_SECRET \?\? 'whsec_dev_only';/,
    );
    expect(body).toMatch(
      /if \(req\.method !== 'POST' \|\| req\.url !== '\/driftstack-webhook'\) \{/,
    );
    expect(body).toMatch(/const sig = req\.headers\['x-driftstack-signature'\];/);
    expect(body).toMatch(/const ok = await verifyWebhookSignature\(\{/);
    expect(body).toMatch(/header: typeof sig === 'string' \? sig : undefined,/);
    expect(body).toMatch(/secret: SECRET,/);
    expect(body).toMatch(/Customers should treat events as at-least-once\. Dedupe by event\.id\./);
    expect(body).toMatch(/case 'session\.completed':/);
    expect(body).toMatch(/case 'session\.failed':/);
    expect(body).toMatch(/case 'api_key\.revoked':/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
    expect(body).toMatch(/res\.statusCode = 204;/);
    expect(existsSync(E('webhook-receiver.ts'))).toBe(true);
  });

  it('profile-management.ts: V-073 profiles + V-136 LOCKED_ARCHETYPE_ID iPhone-16-Pro/iOS-18.7/Safari-26.4 + tier counts (Solo 10 / Team 50 / Agency 200 / API Scale 500 per ADR-004) + create → list-iterate → get → update D-032 name-unique → V-313 clone auto-copy-naming → V-312 snapshot capture → restore-into-new-profile → cleanup pinned', () => {
    const body = read(E('profile-management.ts'));
    expect(body).toMatch(/^\/\/ Profile management — V-073 profiles surface end-to-end\.$/m);
    expect(body).toMatch(/Profiles are persistent browser-state slots: cookies, localStorage,/);
    expect(body).toMatch(/Personal = 10, Team = 50, Agency/);
    expect(body).toMatch(/Manual = 200/);
    expect(body).toMatch(/the API ladder also caps profiles per ADR-004\./);
    expect(body).toMatch(/const created = await client\.profiles\.create\(\{/);
    expect(body).toMatch(/V-136 LOCKED_ARCHETYPE_ID/);
    expect(body).toMatch(
      /for await \(const profile of client\.profiles\.iterate\(\{ limit: 50 \}\)\) \{/,
    );
    expect(body).toMatch(/const fetched = await client\.profiles\.get\(created\.id\);/);
    expect(body).toMatch(/Profile-name uniqueness/);
    expect(body).toMatch(/scoped to \(account_id, name\) per D-032/);
    expect(body).toMatch(/const updated = await client\.profiles\.update\(created\.id, \{/);
    expect(body).toMatch(/\/\/ 5\. V-313 — clone the profile\./);
    expect(body).toMatch(/const cloned = await client\.profiles\.clone\(updated\.id\);/);
    expect(body).toMatch(/\/\/ 6\. V-312 — capture an immutable point-in-time snapshot of the/);
    expect(body).toMatch(
      /const snapshot = await client\.profileSnapshots\.capture\(updated\.id, \{/,
    );
    expect(body).toMatch(
      /const restored = await client\.profileSnapshots\.restore\(snapshot\.id, \{/,
    );
    expect(body).toMatch(/await client\.profileSnapshots\.delete\(snapshot\.id\);/);
    expect(existsSync(E('profile-management.ts'))).toBe(true);
  });

  it('crypto-checkout.ts: V-666 TS + node:crypto randomUUID Idempotency-Key V-666.AO + 6-step flow (quote solo_manual → createCheckout with idempotencyKey → updateNote PO-0001 → get with expires_at pay-window → receipt issued_at → listAll paid 7-day-window async-iterator) + non-refundable framing pinned', () => {
    const body = read(E('crypto-checkout.ts'));
    expect(body).toMatch(/^\/\/ Crypto-checkout self-serve flow — V-666 TypeScript example\.$/m);
    expect(body).toMatch(/\/\/ Crypto payments are non-refundable\./);
    expect(body).toMatch(/^import \{ randomUUID \} from 'node:crypto';$/m);
    expect(body).toMatch(
      /const quote = await client\.cryptoOrders\.quote\(\{ product: 'solo_manual' \}\);/,
    );
    expect(body).toMatch(/The SDK forwards/);
    expect(body).toMatch(/the key as the Idempotency-Key header \(V-666\.AO\)/);
    expect(body).toMatch(/const key = randomUUID\(\);/);
    expect(body).toMatch(/const order = await client\.cryptoOrders\.createCheckout\(/);
    expect(body).toMatch(/\{ idempotencyKey: key \},/);
    expect(body).toMatch(/await client\.cryptoOrders\.updateNote\(order\.order_id, \{/);
    expect(body).toMatch(/customer_note: 'demo PO-0001',/);
    expect(body).toMatch(/const latest = await client\.cryptoOrders\.get\(order\.order_id\);/);
    expect(body).toMatch(/Pay-window expires at:/);
    expect(body).toMatch(/const receipt = await client\.cryptoOrders\.receipt\(order\.order_id\);/);
    expect(body).toMatch(/for await \(const o of client\.cryptoOrders\.listAll\(\{/);
    expect(body).toMatch(/status: 'paid',/);
    expect(body).toMatch(/created_after: since,/);
    expect(existsSync(E('crypto-checkout.ts'))).toBe(true);
  });

  it("agent-chat.ts: tsx invocation + DRIFTSTACK_API_KEY env-gate + DRIFTSTACK_BYOK_ANTHROPIC_API_KEY optional env demo + agentSessions.create + message multi-turn (plan-executed/clarify/refuse) + FeatureUnavailableError activation-gate exit-code-2 + byokApiKey.length > 0 guard building opts only when non-empty + close — pinned so slice 139's BYOK demo survives + so a future refactor that drops the empty-string skip-guard trips the test (cross-SDK parity contract from slices 126-128)", () => {
    const body = read(E('agent-chat.ts'));
    expect(body).toMatch(/DRIFTSTACK_API_KEY=ds_live_\.\.\. npx tsx examples\/agent-chat\.ts/);
    expect(body).toMatch(/DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-\.\.\./);
    expect(body).toMatch(
      /const byokKey = process\.env\.DRIFTSTACK_BYOK_ANTHROPIC_API_KEY \?\? '';/,
    );
    expect(body).toMatch(
      /const msgOpts = byokKey\.length > 0 \? \{ byokApiKey: byokKey \} : undefined;/,
    );
    expect(body).toMatch(
      /const resp = await client\.agentSessions\.message\(session\.id, prompt, msgOpts\);/,
    );
    expect(body).toMatch(/case 'plan-executed':/);
    expect(body).toMatch(/case 'clarify':/);
    expect(body).toMatch(/case 'refuse':/);
    expect(body).toMatch(/err instanceof FeatureUnavailableError/);
    expect(body).toMatch(/process\.exit\(2\)/);
    expect(body).toMatch(/await client\.agentSessions\.close\(session\.id\)/);
    expect(existsSync(E('agent-chat.ts'))).toBe(true);
  });
});
