// Drift guard for packages/sdk-go/egress.go.
// Pins the planning 133 EGRESS Phase 1+ Go surface — mirrors TS +
// Python egress resources. Load-bearing pieces: the 'raw secrets
// NEVER echoed' SECURITY contract + the 5-method shape + the
// ListSavedProxies-stays-200-across-postures cross-SDK behavior.

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

  it("Module-level EgressResource framing pinned: 'EgressResource handles /v1/sessions/{id}/proxy + /v1/proxies (planning 133 EGRESS Phase 1+). Mirrors the TypeScript + Python SDK egress resources.' — pinned so the cross-SDK mirror reference + planning 133 anchor survive (drift would orphan the Go egress surface from its cross-SDK parity contract)", () => {
    expect(body).toMatch(
      /\/\/ EgressResource handles \/v1\/sessions\/\{id\}\/proxy \+ \/v1\/proxies\s*\n?\s*\/\/ \(planning 133 EGRESS Phase 1\+\)\. Mirrors the TypeScript \+\s*\n?\s*\/\/ Python SDK egress resources\./,
    );
  });

  it("503 activation-gate framing pinned: 'Server registers these endpoints as 503 FeatureUnavailable stubs until a concrete SOCKS5 backend is wired. The SDK surface is stable so consumers can compile ahead of time.' — pinned so the stub-until-SOCKS5-wired + compile-ahead-of-time pattern stays uniform across SDKs", () => {
    expect(body).toMatch(
      /\/\/ Server registers these endpoints as 503 FeatureUnavailable stubs\s*\n?\s*\/\/ until a concrete SOCKS5 backend is wired\. The SDK surface is\s*\n?\s*\/\/ stable so consumers can compile ahead of time\./,
    );
  });

  it("SECURITY 'raw secrets NEVER echoed' framing pinned: 'list/get responses NEVER echo raw secret material (SOCKS5 password, OpenVPN .ovpn body, WireGuard private_key); re-enter to update.' — pinned so the write-only secret contract stays explicit on the Go side (parity with TS + Python; drift on one SDK would silently diverge the documented contract)", () => {
    expect(body).toMatch(
      /\/\/ SECURITY: list\/get responses NEVER echo raw secret material\s*\n?\s*\/\/ \(SOCKS5 password, OpenVPN \.ovpn body, WireGuard private_key\);\s*\n?\s*\/\/ re-enter to update\./,
    );
  });

  it("SessionEgressConfig 'loose map[string]any' framing pinned: 'Use map[string]any for nested shapes — keeping the type loose matches the existing SDK pattern for non-billing surfaces and avoids over-eager binding before EG-API-1.6 lands.' — pinned so the EG-API-1.6 dependency rationale + the deliberate-looseness contract stay explicit (drift to a strongly-typed nested shape now would force schema migrations when EG-API-1.6 lands)", () => {
    expect(body).toMatch(
      /\/\/ SessionEgressConfig is the body shape for AttachToSession\.\s*\n?\s*\/\/ Use map\[string\]any for nested shapes — keeping the type loose\s*\n?\s*\/\/ matches the existing SDK pattern for non-billing surfaces and\s*\n?\s*\/\/ avoids over-eager binding before EG-API-1\.6 lands\./,
    );
  });

  it('SessionEgressConfig Go struct 3-field shape: SessionID + Proxy (map[string]any) + EgressSafeguard (map[string]bool). Drift would break the wire shape', () => {
    expect(body).toMatch(
      /type SessionEgressConfig struct \{\s*\n?\s*SessionID\s+string\s+`json:"session_id"`\s*\n?\s*Proxy\s+map\[string\]any\s+`json:"proxy"`\s*\n?\s*EgressSafeguard map\[string\]bool\s+`json:"egress_safeguard"`\s*\n?\s*\}/,
    );
  });

  it('SessionProxyAttachResponse public-safe envelope: Type + Safeguards (map[string]bool). Drift to including the raw config would re-introduce the SECURITY leak the SDK framing explicitly forbids', () => {
    expect(body).toMatch(
      /type SessionProxyAttachResponse struct \{\s*\n?\s*Type\s+string\s+`json:"type"`\s*\n?\s*Safeguards map\[string\]bool `json:"safeguards"`\s*\n?\s*\}/,
    );
  });

  it("SessionProxyAttachResponse 'public-safe envelope' framing pinned: 'Carries only the proxy type + safeguard flags — never raw secret material.' — pinned so the no-secret-echo SECURITY contract is re-anchored on the response-type docstring (in addition to the module-level note); drift here would let drift sneak in via response-type-only contributors", () => {
    expect(body).toMatch(
      /\/\/ SessionProxyAttachResponse is the public-safe envelope returned\s*\n?\s*\/\/ by AttachToSession \+ GetSessionProxy\. Carries only the proxy type\s*\n?\s*\/\/ \+ safeguard flags — never raw secret material\./,
    );
  });

  it('SavedProxySummary 3-field public-safe envelope: ID + Label + Type. Drift to including the raw config in the summary would leak the secret on List/Save responses', () => {
    expect(body).toMatch(
      /type SavedProxySummary struct \{\s*\n?\s*ID\s+string `json:"id"`\s*\n?\s*Label string `json:"label"`\s*\n?\s*Type\s+string `json:"type"`\s*\n?\s*\}/,
    );
  });

  it('ListSavedProxiesResponse envelope: Data []SavedProxySummary. Drift to a top-level bare array would diverge from the cross-resource list-envelope convention', () => {
    expect(body).toMatch(
      /type ListSavedProxiesResponse struct \{\s*\n?\s*Data \[\]SavedProxySummary `json:"data"`\s*\n?\s*\}/,
    );
  });

  it('EgressResource 5-method surface: AttachToSession + GetSessionProxy + SaveProxy + ListSavedProxies + DeleteSavedProxy. All with context.Context-first idiom. Drift to dropping a method would break cross-SDK uniformity; drift to adding GetSavedProxy(id) would re-introduce the raw-secret-leak path the SECURITY contract forbids', () => {
    expect(body).toMatch(
      /func \(r \*EgressResource\) AttachToSession\(ctx context\.Context, sessionID string, config \*SessionEgressConfig\) \(\*SessionProxyAttachResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) GetSessionProxy\(ctx context\.Context, sessionID string\) \(\*SessionProxyAttachResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) SaveProxy\(ctx context\.Context, body \*SavedProxyConfig\) \(\*SavedProxySummary, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) ListSavedProxies\(ctx context\.Context\) \(\*ListSavedProxiesResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*EgressResource\) DeleteSavedProxy\(ctx context\.Context, proxyID string\) error/,
    );
  });

  it("AttachToSession 'session_id MUST match URL or 400' framing pinned + GetSessionProxy 404-on-no-attach framing pinned. Drift would silently break callers who depend on the documented error semantics", () => {
    expect(body).toMatch(
      /\/\/ AttachToSession sets the proxy config for a session\. The body's\s*\n?\s*\/\/ SessionID MUST match the URL sessionID or the server rejects with\s*\n?\s*\/\/ 400\./,
    );
    expect(body).toMatch(
      /\/\/ GetSessionProxy reads the session's current proxy summary\.\s*\n?\s*\/\/ Returns NotFound \(404\) if no proxy has been attached\./,
    );
  });

  it("ListSavedProxies 'stays 200 + empty-list across postures' framing pinned: 'Stays 200 + empty-list across postures (matches the TS + Python SDK behavior — read-only listing exempt from the activation-gate stub pattern).' — pinned so the read-only-listing-exempt cross-SDK contract stays explicit (drift to 503-stubbing ListSavedProxies would break the dashboard's saved-proxy library UX which depends on the empty-list-on-stub behavior)", () => {
    expect(body).toMatch(
      /\/\/ ListSavedProxies returns the calling account's saved proxy\s*\n?\s*\/\/ summaries\. Stays 200 \+ empty-list across postures \(matches the\s*\n?\s*\/\/ TS \+ Python SDK behavior — read-only listing exempt from the\s*\n?\s*\/\/ activation-gate stub pattern\)\./,
    );
  });

  it('url.PathEscape on all id-bearing routes (AttachToSession + GetSessionProxy + DeleteSavedProxy). Parity with TS encodeURIComponent + Python quote(...,safe=""). Drift would break Go consumers with reserved URI chars in session/proxy ids', () => {
    expect(body).toMatch(/"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/proxy"/);
    expect(body).toMatch(/"\/v1\/proxies\/" \+ url\.PathEscape\(proxyID\)/);
  });
});
