// Drift guard for apps/server/src/services/session-egress.ts.
// Pins the V-540.E customer-configurable egress interface — E1 slice
// scaffold (concrete backends defer to EG-API-1.6 SOCKS5 propagation).
// Anchored against planning 133's cross-agent contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/session-egress.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/session-egress content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-540.E framing pinned: 'Customer-configurable egress (SOCKS5 / WireGuard / OpenVPN). E1 slice = interface + types scaffold; concrete backends land in follow-up slices (EG-API-1.6 SOCKS5 propagation, later phases for OpenVPN + WireGuard per planning 133).' — pinned so the V-540.E anchor + 3-proxy-type taxonomy + E1-scaffold-only posture + EG-API-1.6 next-step + planning 133 cross-reference all stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-540\.E — Customer-configurable egress \(SOCKS5 \/ WireGuard \/\s*\/\/ OpenVPN\)\. E1 slice = interface \+ types scaffold; concrete\s*\/\/ backends land in follow-up slices \(EG-API-1\.6 SOCKS5 propagation,\s*\/\/ later phases for OpenVPN \+ WireGuard per planning 133\)\./,
    );
  });

  it("Design SOT pointer pinned: 'docs/planning/133-egress-architecture-cross-agent.md in the driftstack repo (founder-locked 2026-05-16). The earlier docs/internal/customer-configurable-egress-design.md was SUPERSEDED by planning 133 (~56h Agent-2-only estimate was undersized; real cross-agent + harness scope is 7-12 weeks per planning 133).' — pinned so the founder-locked-2026-05-16 + superseded-design + 56h-undersize + 7-12-weeks-real-scope all stay documented (drift to dropping the superseded-pointer would let readers consult the wrong design doc)", () => {
    expect(body).toMatch(
      /\/\/ Design source of truth: `docs\/planning\/133-egress-architecture-\s*\/\/ cross-agent\.md` in the driftstack repo \(founder-locked 2026-05-16\)\.\s*\/\/ The earlier `docs\/internal\/customer-configurable-egress-design\.md`\s*\/\/ was SUPERSEDED by planning 133 \(~56h Agent-2-only estimate was\s*\/\/ undersized; real cross-agent \+ harness scope is 7-12 weeks per\s*\/\/ planning 133\)\./,
    );
  });

  it("Activation-pattern framing pinned: 'follows the same all-or-nothing posture as Postmark / LiveKit / OAuth-client — bootstrap wires sessionEgressService into AppDeps only when a concrete backend is reachable; until then the routes registered by registerSessionProxyDisabledRoutes (EG-API-1.2) return 503 FeatureUnavailable.' — pinned so the 3-feature-precedent (Postmark/LiveKit/OAuth) + bootstrap-wiring-gate + 503-stub-via-EG-API-1.2 contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Activation pattern follows the same all-or-nothing posture as\s*\/\/ Postmark \/ LiveKit \/ OAuth-client — bootstrap wires\s*\/\/ `sessionEgressService` into AppDeps only when a concrete backend\s*\/\/ is reachable; until then the routes registered by\s*\/\/ `registerSessionProxyDisabledRoutes` \(EG-API-1\.2\) return 503\s*\/\/ FeatureUnavailable\./,
    );
  });

  it("Schema-side single-source-of-truth framing pinned: 'the proxy-config DISCRIMINATED UNION + per-protocol shapes live in @driftstack/api-types/egress (EG-API-1.1, commit 555d8001). This file no longer redeclares them — it re-exports SessionEgressConfig + ProxyConfig for legacy callers and types EgressHandle against ProxyType from api-types so the cross-agent contract has one source of truth.' — pinned so the EG-API-1.1 commit 555d8001 + cross-agent-one-source-of-truth + legacy-re-export-only contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Schema-side: the proxy-config DISCRIMINATED UNION \+ per-protocol\s*\/\/ shapes live in `@driftstack\/api-types\/egress` \(EG-API-1\.1, commit\s*\/\/ 555d8001\)\. This file no longer redeclares them — it re-exports\s*\/\/ `SessionEgressConfig` \+ `ProxyConfig` for legacy callers and types\s*\/\/ `EgressHandle` against `ProxyType` from api-types so the cross-\s*\/\/ agent contract has one source of truth\./,
    );
  });

  it("Cross-package re-exports pinned: 'export type { ProxyType, SessionEgressConfig } from @driftstack/api-types;'. Drift to re-declaring locally would let server's idea of the proxy config diverge from the SDK's; the legacy-import re-export keeps pre-EG-API-1.1 callers compiling", () => {
    expect(body).toMatch(
      /import type \{ ProxyType, SessionEgressConfig \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /export type \{ ProxyType, SessionEgressConfig \} from '@driftstack\/api-types';/,
    );
  });

  it("EgressHandle shape pinned: sessionId + type (ProxyType discriminator) + cleanup { configPath? + netnsName? + envOverrides? }. + 'Backend-specific cleanup payload. Consumers MUST treat this as opaque and hand it back to releaseFromSession verbatim.' — pinned so the opaque-cleanup-payload contract + the 3-cleanup-field shape (tmpfs configPath, netns name, env overrides) stay documented", () => {
    expect(body).toMatch(/export interface EgressHandle \{/);
    expect(body).toMatch(/sessionId: string;/);
    expect(body).toMatch(/type: ProxyType;/);
    expect(body).toMatch(
      /\/\*\* Backend-specific cleanup payload\. Consumers MUST treat this\s*\*\s+as opaque and hand it back to releaseFromSession verbatim\. \*\/\s*cleanup: \{\s*\/\*\* tmpfs path to the config file \(zeroed on release\)\. \*\/\s*configPath\?: string;\s*\/\*\* Network namespace name for wireguard \/ openvpn variants\. \*\/\s*netnsName\?: string;\s*\/\*\* Env-var overrides for socks5 variant \(passed to browser spawn\)\. \*\/\s*envOverrides\?: Readonly<Record<string, string>>;\s*\};/,
    );
  });

  it("'tmpfs zeroed on release' + 'netns name for wireguard/openvpn variants' + 'env overrides for socks5 variant passed to browser spawn' framing pinned. Drift to dropping the zeroed-on-release commitment would let leaked credentials linger in tmpfs after session destroy; drift to dropping per-protocol cleanup-field associations would mismatch the concrete-backend wiring expectations", () => {
    expect(body).toMatch(/\/\*\* tmpfs path to the config file \(zeroed on release\)\. \*\//);
    expect(body).toMatch(/\/\*\* Network namespace name for wireguard \/ openvpn variants\. \*\//);
    expect(body).toMatch(
      /\/\*\* Env-var overrides for socks5 variant \(passed to browser spawn\)\. \*\//,
    );
  });

  it("SessionEgressService 2-method interface pinned: applyToSession (BEFORE-browser-spawn + throws-on-tunnel-unreachable + problem-type URI catalog) + releaseFromSession (idempotent). + 'Args shape matches the cross-agent contract from planning 133's §Per-session config schema — a SessionEgressConfig envelope with session_id + proxy discriminator + egress_safeguard.' framing — pinned so the cross-agent-config-envelope contract stays documented", () => {
    expect(body).toMatch(/export interface SessionEgressService \{/);
    expect(body).toMatch(
      /applyToSession\(args: \{ config: SessionEgressConfig \}\): Promise<EgressHandle>;/,
    );
    expect(body).toMatch(/releaseFromSession\(handle: EgressHandle\): Promise<void>;/);
    expect(body).toMatch(
      /Args shape matches the cross-agent contract from planning 133's\s*\*\s+§"Per-session config schema" — a SessionEgressConfig envelope with\s*\*\s+session_id \+ proxy discriminator \+ egress_safeguard\./,
    );
  });

  it('V-1054 applyToSession lifecycle is pinned as an INTENDED contract, not as current behaviour. The comment used to assert a customer gets a clean 4xx carrying an egress problem-type; nothing calls the method, it rejects with a plain Error rather than a Problem, and neither URI is in PROBLEM_TYPES, so the failure it describes would arrive as a 500 no SDK maps', () => {
    expect(body).toMatch(/Configure customer-supplied egress for the given session\./);
    // The intent survives…
    expect(body).toMatch(/INTENDED lifecycle: called by the session-create path AFTER/);
    expect(body).toMatch(/throwing on\s*\*\s+tunnel-unreachable \/ config-parse-error/);

    // …and each of the three reasons it is not yet true is stated. A future
    // reader who wires the edge needs all three, not just the caller.
    expect(body, 'the no-caller retraction is gone').toMatch(
      /applyToSession has no\s*\*\s+caller anywhere/,
    );
    expect(body, 'the plain-Error-not-Problem gap is gone').toMatch(
      /rejects with a\s*\*\s+plain Error, not a Problem/,
    );
    expect(body, 'the missing-from-PROBLEM_TYPES gap is gone').toMatch(
      /neither egress-tunnel-unreachable\s*\*\s+nor egress-config-invalid is in PROBLEM_TYPES/,
    );

    // And the retracted claim itself does not come back.
    expect(
      body,
      'session-egress.ts again promises a customer-facing 4xx carrying an egress problem-type; ' +
        'no caller reaches this method and neither URI is in the registry',
    ).not.toMatch(/surfaces a\s*\*\s+clean 4xx with problem-type/);
  });

  it("releaseFromSession idempotency framing pinned: 'Tear down the per-session egress resources. Called by session-end (/v1/sessions/:id/destroy, idle timeout, or fatal session error). Idempotent — releasing a handle that was never applied or has already been released is a no-op.' — pinned so the 3-trigger-source catalog (destroy/idle/fatal-error) + idempotent-on-already-released contract stay documented", () => {
    expect(body).toMatch(
      /Tear down the per-session egress resources\. Called by\s*\*\s+session-end \(`\/v1\/sessions\/:id\/destroy`, idle timeout, or\s*\*\s+fatal session error\)\. Idempotent — releasing a handle that\s*\*\s+was never applied or has already been released is a no-op\./,
    );
  });
});
