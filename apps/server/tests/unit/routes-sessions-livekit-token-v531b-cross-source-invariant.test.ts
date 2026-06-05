// V-531.B — routes/sessions-livekit-token cross-source invariant.
// Pins apps/server/src/routes/sessions-livekit-token.ts:
//
//   V-531.B anchor — 'V-531.B — LiveKit access-token mint route'.
//
//   Route path — 'POST /v1/sessions/:id/livekit-token  { role:
//   "publisher" | "subscriber" }'.
//
//   Stub-until-keyed posture — 'lib/app.ts registers this route only
//   when config.livekit is fully populated (apiKey + apiSecret + wsUrl).
//   When any of the three are absent the route stays unregistered;
//   the client gets a 404 and falls back to the HTTP polling plane.
//   Same "stub-until-keyed" posture as V-487 NowPayments + V-665
//   Postmark'.
//
//   Cross-account 404 framing — 'Cross-account session ids 404
//   (anti-enumeration; same posture as the rest of the customer-facing
//   surface)'.
//
//   isSessionOwned dep — pluggable ownership check, decouples from
//   the sessions service surface.
//
//   role enum — 'publisher' | 'subscriber'.
//
//   SESSION_ID_RE shape-check — '^ses_<uuid>$' (matches the rest of
//   the prefix-id family, NOT 'sess_'); rejects junk before the db hit.
//
//   Default ttl — 600 seconds.
//
//   Response shape — { token, ws_url, room, role, ttl_seconds }.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('V-531.B routes/sessions-livekit-token cross-source invariant', () => {
  // ─── V-531.B anchor + stub-until-keyed posture ───────────────

  it("CRITICAL V-531.B anchor — 'V-531.B — LiveKit access-token mint route'. The single-anchor design ties the route to the V-531 streaming family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/V-531\.B — LiveKit access-token mint route\./);
  });

  it('CRITICAL stub-until-keyed framing — \'lib/app.ts registers this route only when config.livekit is fully populated (apiKey + apiSecret + wsUrl). When any of the three are absent the route stays unregistered; the client gets a 404 and falls back to the HTTP polling plane. Same "stub-until-keyed" posture as V-487 NowPayments + V-665 Postmark\'. The 3-way registration gate keeps the route safe under partial config.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/Posture: wire-ready\. lib\/app\.ts registers this route only when/);
    expect(p).toMatch(/config\.livekit is fully populated \(apiKey \+ apiSecret \+ wsUrl\)\./);
    expect(p).toMatch(/the route stays unregistered; the/);
    expect(p).toMatch(/client gets a 404 and falls back to the HTTP polling plane/);
    expect(p).toMatch(/Same/);
    expect(p).toMatch(/"stub-until-keyed" posture as V-487 NowPayments \+ V-665 Postmark/);
  });

  it("CRITICAL cross-account 404 framing — 'Cross-account session ids 404 (anti-enumeration; same posture as the rest of the customer-facing surface)'. The 404-not-403 design is the anti-enumeration contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/Cross-account session ids 404 \(anti-enumeration; same posture as/);
    expect(p).toMatch(/the rest of the customer-facing surface\)\./);
  });

  // ─── Route + preHandler ──────────────────────────────────────

  it('CRITICAL route path — POST /v1/sessions/:id/livekit-token, gated by requireAuth + global rate-limit. The fixed path is the surface gui-client + customer-dashboard call.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/'\/v1\/sessions\/:id\/livekit-token'/);
    expect(p).toMatch(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\]/);
  });

  // ─── role + SESSION_ID_RE ────────────────────────────────────

  it("CRITICAL role enum — 'publisher' | 'subscriber'. The 2-value enum encodes the only legitimate caller roles (mac-mini publisher / dashboard subscriber).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/role: z\.enum\(\['publisher', 'subscriber'\]\),/);
  });

  it("CRITICAL SESSION_ID_RE shape-check — '^ses_<uuid>$' (single 's' prefix matching the rest of the public-id family). Initial integration tests caught a 'sess_' typo that would have 404'd every real session id; this pin guards against the regression.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(
      /const SESSION_ID_RE = \/\^ses_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\//,
    );
    expect(p).toMatch(/if \(!SESSION_ID_RE\.test\(sessionId\)\) \{/);
  });

  it("CRITICAL prefix-strip before ownership check — sessionId.slice('ses_'.length) is passed to isSessionOwned (which forwards to the bare-uuid sessionRepo.findSession). Caught by integration test sessions-livekit-token.test.ts; drift would 404 every real session.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/const uuid = sessionId\.slice\('ses_'\.length\);/);
    expect(p).toMatch(/await deps\.isSessionOwned\(ctx\.account\.id, uuid\);/);
  });

  // ─── Default ttl + token claim wiring ────────────────────────

  it('CRITICAL default ttl — 600 seconds. Matches mintLivekitToken default; drift would diverge route + lib defaults.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/ttlSeconds: deps\.ttlSeconds \?\? 600,/);
    expect(p).toMatch(/ttl_seconds: deps\.ttlSeconds \?\? 600,/);
  });

  it('CRITICAL identity == customer-<accountId> (2026-06-05 launch-hardening, was sessionId — fixed LiveKit duplicate-identity collision); room == sessionId (1-room-per-session).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/identity: `customer-\$\{ctx\.account\.id\}`,/);
    expect(p).toMatch(/room: sessionId,/);
    // Regression guard: must NOT revert to the collision-prone identity.
    expect(p).not.toMatch(/identity: sessionId,/);
  });

  it('CRITICAL SUBSCRIBE-ONLY grant — canPublish:false + canSubscribe:true regardless of role (2026-06-05 launch-hardening). This route is customer-authed; the prior role===publisher grant let a customer mint a publisher token (capture/harness publishes host-side, not via this route).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/canPublish: false,/);
    expect(p).toMatch(/canSubscribe: true,/);
    // Regression guard: must NOT reintroduce the customer-mintable publisher grant.
    expect(p).not.toMatch(/canPublish: parsed\.data\.role === 'publisher',/);
  });

  // ─── Response envelope ───────────────────────────────────────

  it('CRITICAL response shape — { token, ws_url, room, role, ttl_seconds }. The 5-field envelope matches what gui-client + customer-dashboard expect.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(/return reply\.code\(200\)\.send\(\{/);
    expect(p).toMatch(/token,/);
    expect(p).toMatch(/ws_url: deps\.wsUrl,/);
    expect(p).toMatch(/room: sessionId,/);
    expect(p).toMatch(/role: parsed\.data\.role,/);
    expect(p).toMatch(/ttl_seconds: deps\.ttlSeconds \?\? 600,/);
  });

  // ─── isSessionOwned dep contract ─────────────────────────────

  it('CRITICAL isSessionOwned dep — pluggable callback, route stays decoupled from sessions service. The hint in the dep doc shows the canonical wiring: sessionRepo.findSession(sId, accId).then(r => r !== null).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(
      /isSessionOwned: \(accountId: string, sessionId: string\) => Promise<boolean>;/,
    );
    expect(p).toMatch(/sessionRepo\.findSession\(sessionId, accountId\)\.then\(r => r !== null\)/);
  });

  it('CRITICAL ownership-check failure → 404 (not 403). Anti-enumeration parity with the rest of the customer-facing surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts'));
    expect(p).toMatch(
      /if \(!owned\) \{\s*\n?\s*bump\([^)]+, 'not_found'\);\s*\n?\s*throw new NotFoundError\(`Session "\$\{sessionId\}" not found\.`\);\s*\n?\s*\}/,
    );
  });
});
