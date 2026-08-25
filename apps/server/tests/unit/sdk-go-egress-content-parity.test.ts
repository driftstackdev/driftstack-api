// Drift guard for packages/sdk-go/egress.go.
// Pins the egress surface: per-session attach + the saved-proxy library on
// the LIVE account-proxies API (/v1/account/me/proxies) + the write-only-secret
// contract. Cross-SDK uniformity with TS + Python.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/egress.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-go egress content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('comment documents the LIVE account-proxies API + write-only secrets; no stale 503-stub framing', () => {
    expect(body).toMatch(/\/v1\/account\/me\/proxies/);
    expect(body).toMatch(/the same backend the[\s\S]{0,16}desktop app \+ dashboard use/);
    expect(body).toMatch(/write-only/);
    expect(body).not.toMatch(/Server registers these endpoints as 503 FeatureUnavailable stubs/);
  });

  it('SessionProxyAttachResponse public-safe envelope (Type + Safeguards) — never raw secret material', () => {
    expect(body).toMatch(
      /type SessionProxyAttachResponse struct \{\s*Type\s+string\s+`json:"type"`\s*Safeguards map\[string\]bool `json:"safeguards"`\s*\}/,
    );
  });

  it('AccountProxyMetadata public-safe envelope: id/label/scheme/host/port + has_password/has_secret (the secret itself is never returned)', () => {
    expect(body).toMatch(/type AccountProxyMetadata struct \{/);
    expect(body).toMatch(/HasPassword bool\s+`json:"has_password"`/);
    expect(body).toMatch(/HasSecret\s+bool\s+`json:"has_secret"`/);
    expect(body).toMatch(/type AccountProxyList struct \{/);
    expect(body).toMatch(/type AccountProxyTestResult struct \{/);
    expect(body).not.toMatch(/type SavedProxySummary struct/);
  });

  it('EgressResource 7-method surface (context-first): AttachToSession + GetSessionProxy + ListProxies + CreateProxy + UpdateProxy + DeleteProxy + TestProxy', () => {
    expect(body).toMatch(
      /func \(r \*EgressResource\) AttachToSession\(ctx context\.Context, sessionID string, config \*SessionEgressConfig\) \(\*SessionProxyAttachResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) GetSessionProxy\(ctx context\.Context, sessionID string\) \(\*SessionProxyAttachResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) ListProxies\(ctx context\.Context\) \(\*AccountProxyList, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) CreateProxy\(ctx context\.Context, body \*AccountProxyInput\) \(\*AccountProxyMetadata, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) UpdateProxy\(ctx context\.Context, proxyID string, body map\[string\]any\) \(\*AccountProxyMetadata, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) DeleteProxy\(ctx context\.Context, proxyID string\) error/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) TestProxy\(ctx context\.Context, proxyID string\) \(\*AccountProxyTestResult, error\)/,
    );
    expect(body).not.toMatch(/SaveProxy|ListSavedProxies|DeleteSavedProxy/);
  });

  it('account-proxies routes pinned + url.PathEscape on id-bearing routes', () => {
    expect(body).toMatch(/path:\s+"\/v1\/account\/me\/proxies"/);
    expect(body).toMatch(/"\/v1\/account\/me\/proxies\/" \+ url\.PathEscape\(proxyID\)/);
    expect(body).toMatch(
      /"\/v1\/account\/me\/proxies\/" \+ url\.PathEscape\(proxyID\) \+ "\/test"/,
    );
    expect(body).toMatch(/"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/proxy"/);
    expect(body).not.toMatch(/"\/v1\/proxies"/);
  });
});
