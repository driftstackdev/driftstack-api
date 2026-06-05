// Drift guard for apps/server/src/routes/sessions-livekit-token.ts.
// Pins V-531.B POST /v1/sessions/:id/livekit-token — HS256 JWT minter
// + WS URL response + role-derived publisher/subscriber permissions
// + anti-enumeration 404 + the ses_ prefix-to-bare-uuid strip pattern.
// Drift to leaking session ownership through 403 would break the
// rest-of-customer-surface anti-enumeration posture.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/sessions-livekit-token content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-531.B module-level framing pinned: 'LiveKit access-token mint route. POST /v1/sessions/:id/livekit-token  { role: publisher | subscriber }. The route hands a short-lived HS256 JWT + the WS URL back to the caller. The token grants connect-to-room rights scoped to the session id (one room per session). Publisher tokens are issued for the Mac-mini-side capture process; subscriber tokens for the customer-dashboard's live-preview surface.' — pinned so the V-531.B anchor + HS256-JWT + one-room-per-session + 2-role-purpose (Mac-mini capture / dashboard preview) contract all stay documented", () => {
    expect(body).toMatch(/\/\/ V-531\.B — LiveKit access-token mint route\./);
    expect(body).toMatch(
      /\/\/\s+POST \/v1\/sessions\/:id\/livekit-token\s+\{ role: 'publisher' \| 'subscriber' \}/,
    );
    // 2026-06-05 launch-hardening: header now documents the SUBSCRIBE-ONLY posture.
    expect(body).toMatch(
      /\/\/ token is SUBSCRIBE-ONLY[\s\S]*?capture\/harness process publishes\s*\n?\s*\/\/ HOST-side with its own credentials, never via this customer route\./,
    );
    expect(body).toMatch(/now mirrors canonical LK\.3\./);
  });

  it('Wire-ready stub-until-keyed posture framing pinned: \'Posture: wire-ready. lib/app.ts registers this route only when config.livekit is fully populated (apiKey + apiSecret + wsUrl). When any of the three are absent the route stays unregistered; the client gets a 404 and falls back to the HTTP polling plane. Same "stub-until-keyed" posture as V-487 NowPayments + V-665 Postmark.\' — pinned so the 3-config-field requirement + 404-fallback-to-polling + cross-feature-pattern (NowPayments / Postmark) contract stays documented', () => {
    expect(body).toMatch(
      /\/\/ Posture: wire-ready\. lib\/app\.ts registers this route only when\s*\n?\s*\/\/ config\.livekit is fully populated \(apiKey \+ apiSecret \+ wsUrl\)\. When\s*\n?\s*\/\/ any of the three are absent the route stays unregistered; the\s*\n?\s*\/\/ client gets a 404 and falls back to the HTTP polling plane\. Same\s*\n?\s*\/\/ "stub-until-keyed" posture as V-487 NowPayments \+ V-665 Postmark\./,
    );
  });

  it("Ownership-decoupling framing pinned: 'Ownership: the caller must own the session. The route delegates the ownership check to a requireSessionOwnership callback supplied by the wiring layer so this file stays decoupled from the sessions service surface (which is privileged in ways we don't need here). Cross-account session ids 404 (anti-enumeration; same posture as the rest of the customer-facing surface).' — pinned so the route-stays-decoupled + cross-account-404-not-403 contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Ownership: the caller must own the session\. The route delegates the\s*\n?\s*\/\/ ownership check to a `requireSessionOwnership` callback supplied by\s*\n?\s*\/\/ the wiring layer so this file stays decoupled from the sessions\s*\n?\s*\/\/ service surface \(which is privileged in ways we don't need here\)\.\s*\n?\s*\/\/ Cross-account session ids 404 \(anti-enumeration; same posture as\s*\n?\s*\/\/ the rest of the customer-facing surface\)\./,
    );
  });

  it("RegisterLivekitTokenRouteDeps 6-field shape pinned: apiKey + apiSecret + wsUrl + isSessionOwned (callback) + optional ttlSeconds (default 600 / 10 min; floor 60s; ceiling 1h) + optional metrics (Arc 7 obs.12). + the wiring-pattern JSDoc 'Wiring layer typically passes: (accountId, sessionId) => sessionRepo.findSession(sessionId, accountId).then(r => r !== null)' — pinned so the deps shape + canonical wiring pattern + driftstack_livekit_token_mint_total{role,outcome} metrics contract all stay documented", () => {
    expect(body).toMatch(/export interface RegisterLivekitTokenRouteDeps \{/);
    expect(body).toMatch(/apiKey: string;/);
    expect(body).toMatch(/apiSecret: string;/);
    expect(body).toMatch(/wsUrl: string;/);
    expect(body).toMatch(
      /isSessionOwned: \(accountId: string, sessionId: string\) => Promise<boolean>;/,
    );
    expect(body).toMatch(
      /\(accountId, sessionId\) => sessionRepo\.findSession\(sessionId, accountId\)\.then\(r => r !== null\)/,
    );
    expect(body).toMatch(/ttlSeconds\?: number;/);
    expect(body).toMatch(
      /\/\*\* Arc 7 obs\.12 — optional metrics registry\. When wired, the route\s*\n?\s*\*\s+increments `driftstack_livekit_token_mint_total\{role,outcome\}`\s*\n?\s*\*\s+per request \(outcome: ok \/ not_found \/ validation\)\. \*\//,
    );
  });

  it("SESSION_ID_RE customer-facing-ses_-prefix framing pinned: '/^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/' + 'Customer-facing session ids carry the `ses_` prefix (NOT `sess_`) followed by a UUID-with-dashes. Same shape as the rest of the public-id family (admin-incidents PUBLIC_ID_RE, etc.).' — pinned so the ses_ prefix (not sess_) + UUID-with-dashes shape contract stays documented (drift to allowing sess_ would mismatch the rest of the public-id family)", () => {
    expect(body).toMatch(
      /\/\/ Customer-facing session ids carry the `ses_` prefix \(NOT `sess_`\)\s*\n?\s*\/\/ followed by a UUID-with-dashes\. Same shape as the rest of the\s*\n?\s*\/\/ public-id family \(admin-incidents PUBLIC_ID_RE, etc\.\)\./,
    );
    expect(body).toMatch(
      /const SESSION_ID_RE = \/\^ses_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/;/,
    );
  });

  it("ses_-strip-before-ownership framing pinned: 'Strip the `ses_` prefix before the ownership check — the sessions repo's findSession() expects a bare uuid. The minted token + room name keep the public prefix so customer-dashboard / gui-client clients can address rooms by the same id the rest of the API uses.' + const uuid = sessionId.slice('ses_'.length) — pinned so the strip-for-db + keep-for-client contract stays documented (drift to passing the full ses_-prefixed id to findSession would 404 every legitimate session)", () => {
    expect(body).toMatch(
      /\/\/ Strip the `ses_` prefix before the ownership check — the\s*\n?\s*\/\/ sessions repo's findSession\(\) expects a bare uuid\. The minted\s*\n?\s*\/\/ token \+ room name keep the public prefix so customer-dashboard\s*\n?\s*\/\/ \/ gui-client clients can address rooms by the same id the rest\s*\n?\s*\/\/ of the API uses\./,
    );
    expect(body).toMatch(/const uuid = sessionId\.slice\('ses_'\.length\);/);
  });

  it("3-outcome metrics-bump framing pinned: bump('unknown', 'not_found') on shape-miss + bump('unknown', 'validation') on body-parse-fail + bump(parsed.data.role, 'not_found') on ownership-miss + bump(parsed.data.role, 'ok') on success. The 'unknown' role label on pre-body-parse outcomes is intentional (role-label cardinality stays bounded; drift to dropping 'unknown' would create a cardinality leak if every junk request expanded the label-space)", () => {
    expect(body).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.livekitTokenMintTotal, \{ role, outcome \}\);/,
    );
    expect(body).toMatch(/bump\('unknown', 'not_found'\);/);
    expect(body).toMatch(/bump\('unknown', 'validation'\);/);
    expect(body).toMatch(/bump\(parsed\.data\.role, 'not_found'\);/);
    expect(body).toMatch(/bump\(parsed\.data\.role, 'ok'\);/);
  });

  it('mintLivekitToken call shape pinned (2026-06-05 SUBSCRIBE-ONLY launch-hardening): identity: customer-<accountId> + ttlSeconds: deps.ttlSeconds ?? 600 + video.room: sessionId + roomJoin: true + canPublish: false + canSubscribe: true. The customer-authed route is subscribe-only — a publisher grant would let a customer inject media into the session room.', () => {
    expect(body).toMatch(
      /const token = mintLivekitToken\(\{\s*\n?\s*apiKey: deps\.apiKey,\s*\n?\s*apiSecret: deps\.apiSecret,\s*\n?\s*identity: `customer-\$\{ctx\.account\.id\}`,\s*\n?\s*ttlSeconds: deps\.ttlSeconds \?\? 600,\s*\n?\s*video: \{\s*\n?\s*room: sessionId,\s*\n?\s*roomJoin: true,\s*\n?\s*canPublish: false,\s*\n?\s*canSubscribe: true,/,
    );
  });

  it('Response 5-field shape pinned: { token, ws_url: deps.wsUrl, room: sessionId, role: parsed.data.role, ttl_seconds: deps.ttlSeconds ?? 600 }. Drift to dropping ws_url would force clients to fetch a separate config endpoint just to know where to connect; drift to dropping ttl_seconds would leave clients guessing when to mint a fresh token', () => {
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*token,\s*\n?\s*ws_url: deps\.wsUrl,\s*\n?\s*room: sessionId,\s*\n?\s*role: parsed\.data\.role,\s*\n?\s*ttl_seconds: deps\.ttlSeconds \?\? 600,\s*\n?\s*\}\);/,
    );
  });
});
