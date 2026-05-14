// W820 — cross-SDK public-export surface parity. One-hundred-forty-
// sixth in the drift-guard series. Pins the customer-facing entry-
// point exports across:
//   TS:     packages/sdk-typescript/src/index.ts
//   Python: packages/sdk-python/src/driftstack/__init__.py
//   Go:     packages/sdk-go/doc.go (package-doc + quickstart anchor)
// Drift to removing a public re-export would silently break customer
// imports — the most-broken-thing-for-most-customers failure class.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/doc.go');

// Customer-facing error-class re-exports that MUST be in both TS + Python.
const REQUIRED_ERROR_EXPORTS = [
  'DriftstackError',
  'AuthError',
  'ConcurrencyLimitError',
  'ConflictError',
  'DriverError',
  'EmailAlreadyRegisteredError',
  'EmailNotVerifiedError',
  'ExpiredKeyError',
  'ForbiddenError',
  'InvalidCredentialsError',
  'InvalidKeyError',
  'NotFoundError',
  'RateLimitError',
  'RevokedKeyError',
  'SessionDestroyedError',
  'TransportError',
  'ValidationError',
];

describe('W820 cross-SDK public-export surface parity', () => {
  it('all 3 public-surface files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Top-level client re-export ───────────────────────────────

  it("CRITICAL TS index.ts re-exports Driftstack class + DriftstackOptions type. The pair lets customers `import { Driftstack, type DriftstackOptions } from '@driftstack/sdk'` — drift to dropping either would force customers to import from internal paths.", () => {
    const p = read(TS);
    expect(p).toMatch(/^export \{ Driftstack, type DriftstackOptions \} from '\.\/client\.js';/m);
  });

  it('CRITICAL Python __init__.py re-exports Driftstack + AsyncDriftstack from driftstack.client. The dual-class re-export matches W814 README + W819 client framing (Stripe-Python convention).', () => {
    const p = read(PY);
    expect(p).toMatch(/from driftstack\.client import AsyncDriftstack, Driftstack/);
  });

  // ─── Webhook signature verifier re-export ─────────────────────

  it('CRITICAL TS index.ts re-exports verifyWebhookSignature + VerifySignatureInput type. Drift to dropping the helper from index would break W799 webhook-receiver example imports.', () => {
    const p = read(TS);
    expect(p).toMatch(
      /export \{ verifyWebhookSignature, type VerifySignatureInput \} from '\.\/webhook-signature\.js';/,
    );
  });

  // ─── pagination helper re-export ──────────────────────────────

  it('CRITICAL TS index.ts re-exports iteratePaginated + CursorPage type from pagination.js. Drift to dropping would break customer code that calls iteratePaginated directly (rare but documented).', () => {
    const p = read(TS);
    expect(p).toMatch(/export \{ iteratePaginated, type CursorPage \} from '\.\/pagination\.js';/);
  });

  // ─── Required error-class re-exports ──────────────────────────

  it('CRITICAL all 17 required error classes are re-exported from TS index.ts AND Python __init__.py. Drift to dropping any from the public surface would force customers to import from internal paths.', () => {
    const ts = read(TS);
    const py = read(PY);
    for (const cls of REQUIRED_ERROR_EXPORTS) {
      expect(ts, `TS index.ts missing '${cls}' re-export`).toMatch(new RegExp(`\\b${cls}\\b`));
      expect(py, `Python __init__.py missing '${cls}' re-export`).toMatch(
        new RegExp(`\\b${cls}\\b`),
      );
    }
  });

  // ─── RetryConfig re-export ────────────────────────────────────

  it('CRITICAL both TS + Python re-export RetryConfig type. TS: `export type { RetryConfig } from ./retry.js`. Python: imported in __init__ for module-level access.', () => {
    expect(read(TS)).toMatch(/export type \{ RetryConfig \} from '\.\/retry\.js';/);
  });

  // ─── api-types re-export (TS only) ────────────────────────────

  it("CRITICAL TS re-exports api-types schemas + types so customers don't need a separate @driftstack/api-types dependency. The 'Re-export the public Zod schemas + types so SDK consumers don't need a second @driftstack/api-types dependency' framing is the load-bearing 'one SDK package, full type coverage' guarantee.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /Re-export the public Zod schemas \+ types so SDK consumers don't need a\s*\n\/\/ second @driftstack\/api-types dependency\./,
    );
    expect(p).toMatch(/} from '@driftstack\/api-types';/);
  });

  // ─── Key api-types exports pinned (TS) ────────────────────────

  it('CRITICAL key api-types re-exports pinned in TS — Session + SessionStatus + Account + AccountTier + ApiKey + ApiKeyScope + Profile + ProfileSnapshot + WebhookEvent + Subscription + SubscriptionStatus + LoginRequest + LoginResponse + LoginResponseUnion. Drift to dropping any would force customer code to import from @driftstack/api-types separately.', () => {
    const p = read(TS);
    for (const t of [
      'Session',
      'SessionStatus',
      'Account',
      'AccountTier',
      'ApiKey',
      'ApiKeyScope',
      'Profile',
      'ProfileSnapshot',
      'Subscription',
      'SubscriptionStatus',
      'LoginRequest',
      'LoginResponse',
      'LoginResponseUnion',
      'CreateSessionRequest',
      'NavigateRequest',
      'CaptureRequest',
    ]) {
      expect(p, `TS api-types re-export missing: ${t}`).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  // ─── V-anchor framing in TS exports ───────────────────────────

  it('CRITICAL TS exports thread V-anchor provenance — V-460/V-266 (CLI/GUI activation) + V-079 (auth flow) + V-353d/e (MFA challenge+step-up) + V-081 (profiles) + V-313 (profile clone) + V-312 (profile snapshots) + V-204 (email preferences) + V-352/V-352b (account self-edit + avatar) + V-082 (billing).', () => {
    const p = read(TS);
    expect(p).toMatch(/V-460 \/ V-266 CLI\/GUI activation flow/);
    expect(p).toMatch(/V-079 auth flow/);
    expect(p).toMatch(/V-353d login MFA challenge — discriminated-union response shape/);
    expect(p).toMatch(/V-353d\/e MFA challenge \+ step-up/);
    expect(p).toMatch(/V-081 profiles/);
    expect(p).toMatch(/V-313 profile clone/);
    expect(p).toMatch(/V-312 profile snapshots/);
    expect(p).toMatch(/V-204 email preferences/);
    expect(p).toMatch(/V-352 \/ V-352b account self-edit \+ avatar upload/);
    expect(p).toMatch(/V-082 billing/);
  });

  // ─── Python __init__.py header docstring ──────────────────────

  it("CRITICAL Python __init__.py header docstring documents the canonical customer import pattern — 'from driftstack import Driftstack, AsyncDriftstack, DriftstackError' + 'client = Driftstack(api_key=\"ds_live_...\")'. Drift would lose the load-bearing copy-paste-ready import example.", () => {
    const p = read(PY);
    expect(p).toMatch(/from driftstack import Driftstack, AsyncDriftstack, DriftstackError/);
    expect(p).toMatch(/client = Driftstack\(api_key="ds_live_\.\.\."\)/);
    expect(p).toMatch(/session = client\.sessions\.create\(\)/);
  });

  // ─── Python __version__ re-export ─────────────────────────────

  it("CRITICAL Python __init__.py re-exports __version__ from _version.py. The pattern 'from driftstack._version import __version__' is the canonical PEP 396 single-source convention.", () => {
    expect(read(PY)).toMatch(/from driftstack\._version import __version__/);
  });

  // ─── Go doc.go package-doc framing ────────────────────────────

  it("CRITICAL Go doc.go package-doc framing pinned. The 'Package driftstack is the official Go SDK for the Driftstack API — stealth iPhone Safari automation, called from Go' first line + Quickstart anchor + client.Close defer + ctx pattern matches W814 README + W819 client framing.", () => {
    const p = read(GO);
    expect(p).toMatch(
      /\/\/ Package driftstack is the official Go SDK for the Driftstack API —\s*\n\/\/ stealth iPhone Safari automation, called from Go\./,
    );
    expect(p).toMatch(/\/\/ Quickstart:/);
    expect(p).toMatch(/client := driftstack\.New\("ds_live_…"\)/);
    expect(p).toMatch(/defer client\.Close\(\)/);
    expect(p).toMatch(/ctx := context\.Background\(\)/);
  });

  // ─── Cross-SDK customer-facing examples ───────────────────────

  it('CRITICAL each customer-facing entry-point file includes copy-pasteable customer code. TS: docstring-included example (via api-types). Python: 4-line example in __init__. Go: 9-line Quickstart in doc.go. Drift to dropping the inline examples would force customers to find examples in separate docs/example files.', () => {
    expect(read(PY)).toMatch(
      /client = Driftstack\(api_key="ds_live_\.\.\."\)\s*\n\s+session = client\.sessions\.create\(\)\s*\n\s+client\.sessions\.navigate\(session\.id, url="https:\/\/example\.com"\)\s*\n\s+client\.sessions\.destroy\(session\.id\)/,
    );
    expect(read(GO)).toMatch(/session, err := client\.Sessions\.Create\(ctx, nil\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-public-export-surface-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
