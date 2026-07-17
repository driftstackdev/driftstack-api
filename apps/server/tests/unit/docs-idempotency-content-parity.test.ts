// Arc 6 docs.idempotency — `apps/docs/src/pages/reference/idempotency.md`
// content parity. Pins the page against the server's actual idempotency
// surface so route renames + endpoint drops break CI.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/idempotency.md');

describe('Arc 6 docs.idempotency — apps/docs/src/pages/reference/idempotency.md parity', () => {
  it('docs page file exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Idempotency keys/);
    expect(body).toMatch(/description: .+Idempotency-Key/i);
  });

  it('documents every endpoint that actually honours Idempotency-Key', () => {
    // The set is whichever endpoints read the `idempotency-key`
    // header in their route source. Hardcoded list:
    const endpoints: Array<{ path: string; routeFile: string }> = [
      {
        path: '/v1/agent-sessions',
        routeFile: 'apps/server/src/routes/agent-sessions.ts',
      },
      {
        path: '/v1/agent-sessions/{id}/message',
        routeFile: 'apps/server/src/routes/agent-sessions.ts',
      },
      {
        path: '/v1/billing/checkout-session',
        routeFile: 'apps/server/src/routes/billing.ts',
      },
      {
        // The idempotent crypto endpoint is the checkout create (billing-crypto.ts
        // reads the Idempotency-Key); /v1/billing/crypto-orders is a GET list and
        // does NOT honour it.
        path: '/v1/billing/crypto-checkout',
        routeFile: 'apps/server/src/routes/billing-crypto.ts',
      },
    ];
    for (const e of endpoints) {
      const src = readFileSync(resolve(REPO_ROOT, e.routeFile), 'utf8');
      // Sanity: the route source still reads the idempotency-key header.
      expect(src.toLowerCase(), `${e.routeFile} must still read idempotency-key`).toMatch(
        /idempotency-key/,
      );
      expect(body.includes(e.path), `docs page must reference ${e.path}`).toBe(true);
    }
  });

  it('documents the Stripe-pattern attribution (so readers can follow the prior art)', () => {
    expect(body).toMatch(/Stripe/);
    expect(body).toMatch(/stripe\.com\/docs\/api\/idempotent_requests/);
  });

  it('documents the per-account scope (not global)', () => {
    expect(body).toMatch(/per-account/i);
  });

  it('documents endpoint-specific lifetime: permanent resource-backed creates, durable session-owned turn receipts, and provider-managed Stripe checkout', () => {
    expect(body).toMatch(/permanent unique\s*\n?\s*index on the orders table/);
    expect(body).toMatch(/session row and replay for as long as the row exists\./);
    expect(body).toMatch(/Agent-message.*durable table/i);
    expect(body).toMatch(
      /Stripe checkout-session.*follow Stripe's\s*\n?\s*provider-side retention/i,
    );
  });

  it('documents the empty-string-treated-as-absent rule', () => {
    expect(body).toMatch(/Empty string is treated as.+absent/i);
  });

  it('documents the endpoint-specific same-key-different-body rejection/legacy replay behavior', () => {
    expect(body).toMatch(/different body/i);
    expect(body).toMatch(
      /Agent-message and crypto-checkout receipts reject a changed\s*\n?\s*request with `409`/,
    );
    expect(body).toMatch(/legacy agent-session create path replays the existing session/);
  });

  it('documents the fail-closed durable agent-turn receipt and disconnect ambiguity', () => {
    expect(body).toMatch(
      /browser work deliberately continues after an SSE viewer\s*\n?\s*disconnects/,
    );
    expect(body).toMatch(/idempotency_status: "in_progress"/);
    expect(body).toMatch(/application-encrypt the terminal response/);
  });

  it('keeps credential and control-lane churn outside completed turn identity', () => {
    expect(body).toMatch(/explicit BYOK credential.*deliberately outside receipt identity/is);
    expect(body).toMatch(/control\s+lane.*deliberately outside receipt identity/is);
    expect(body).toMatch(/session later closes/);
    expect(body).toMatch(/control lane changes between AI and manual/);
    expect(body).toMatch(/explicit BYOKs*\n?credential rotates/);
    expect(body).toMatch(/replays\s*\n?the original terminal result/);
    expect(body).toMatch(/never starts another provider request or\s*\n?browser operation/);
    expect(body).toMatch(
      /manual transcript turn never reads or hashes an\s*\n?irrelevant BYOK header/,
    );
    expect(body).toMatch(/new `Idempotency-Key` only for an intentionally\s*\n?new AI turn/);
    expect(body).not.toMatch(/same session, message, approvals, and explicit BYOK key/i);
    expect(body).not.toMatch(/Different session\/body\/BYOK fingerprint/);
  });

  it('documents the audit-log behaviour (originals logged, replays not)', () => {
    expect(body).toMatch(/audit-log/i);
    expect(body).toMatch(/NOT the replays/);
  });

  it('linked from reference/errors.md', () => {
    const errorsPath = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');
    const errors = readFileSync(errorsPath, 'utf8');
    expect(errors).toMatch(/\/reference\/idempotency/);
  });
});
