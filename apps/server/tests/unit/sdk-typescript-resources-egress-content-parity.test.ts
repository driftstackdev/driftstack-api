// Drift guard for packages/sdk-typescript/src/resources/egress.ts.
// Pins the egress surface: per-session proxy attach + the saved-proxy
// library riding the LIVE account-proxies API (/v1/account/me/proxies),
// plus the write-only-secret contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/egress.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-typescript resources/egress content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('header documents the LIVE account-proxies API (the saved-proxy surface) + the write-only-secret contract; no stale /v1/proxies-stub framing', () => {
    expect(body).toMatch(/\/v1\/account\/me\/proxies/);
    expect(body).toMatch(/the same backend the[\s\S]{0,12}desktop app \+ dashboard use/);
    expect(body).toMatch(/WRITE-ONLY/);
    // The old planning-133 503-stub framing is gone.
    expect(body).not.toMatch(/503\s*\/\/ FeatureUnavailable stubs/);
  });

  it('SessionProxyAttachResponse 3-safeguard catalog pinned (per-session attach surface unchanged)', () => {
    expect(body).toMatch(
      /export interface SessionProxyAttachResponse \{\s*type: ProxyType;\s*safeguards: \{\s*block_direct_internet: boolean;\s*block_unproxied_dns: boolean;\s*block_webrtc_stun_leakage: boolean;\s*\};\s*\}/,
    );
  });

  it('imports the live account-proxies types from @driftstack/api-types (single source of truth) — AccountProxyCreate / List / Metadata / TestResult / Update + ProxyType + SessionEgressConfig', () => {
    for (const t of [
      'AccountProxyCreate',
      'AccountProxyList',
      'AccountProxyMetadata',
      'AccountProxyTestResult',
      'AccountProxyUpdate',
      'ProxyType',
      'SessionEgressConfig',
    ]) {
      expect(body, t).toMatch(new RegExp(`\\b${t}\\b`));
    }
    expect(body).toMatch(/from '@driftstack\/api-types';/);
  });

  it('EgressResource 7-method surface: attachToSession + getSessionProxy + listProxies + createProxy + updateProxy + deleteProxy + testProxy', () => {
    expect(body).toMatch(/export class EgressResource \{/);
    expect(body).toMatch(/attachToSession\(/);
    expect(body).toMatch(
      /getSessionProxy\(sessionId: string\): Promise<SessionProxyAttachResponse>/,
    );
    expect(body).toMatch(/listProxies\(\): Promise<AccountProxyList>/);
    expect(body).toMatch(/createProxy\(body: AccountProxyCreate\): Promise<AccountProxyMetadata>/);
    expect(body).toMatch(
      /updateProxy\(id: string, body: AccountProxyUpdate\): Promise<AccountProxyMetadata>/,
    );
    expect(body).toMatch(/deleteProxy\(id: string\): Promise<void>/);
    expect(body).toMatch(/testProxy\(id: string\): Promise<AccountProxyTestResult>/);
    // The legacy saved-proxy method names are gone.
    expect(body).not.toMatch(/saveProxy|listSavedProxies|deleteSavedProxy/);
  });

  it('account-proxies routes pinned: GET/POST /v1/account/me/proxies + PUT/DELETE /:id + POST /:id/test', () => {
    expect(body).toMatch(/path: '\/v1\/account\/me\/proxies'/);
    expect(body).toMatch(/`\/v1\/account\/me\/proxies\/\$\{encodeURIComponent\(id\)\}`/);
    expect(body).toMatch(/`\/v1\/account\/me\/proxies\/\$\{encodeURIComponent\(id\)\}\/test`/);
    expect(body).not.toMatch(/'\/v1\/proxies'/);
  });

  it('Path encodeURIComponent pinned on all id-bearing routes (sessionId + the account-proxy id)', () => {
    expect(body).toMatch(/`\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/proxy`/);
    expect(body).toMatch(/encodeURIComponent\(id\)/);
  });
});
