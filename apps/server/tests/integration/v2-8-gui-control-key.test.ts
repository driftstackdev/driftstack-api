// Arc 2 sub-slice 8.4 (v2-#8) — gui_control_key auto-mint integration.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7);

function encryptLegacyUnbound(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', TEST_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

describe('Arc 2 v2-#8 sub-slice 8.4 GET /v1/agent-sessions/:id/gui-control-key', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('first GET mints fresh — returns plaintext + ISO expires_at + minted:true', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ gui_control_key: string; expires_at: string; minted: boolean }>();
    expect(body.gui_control_key).toMatch(/^gck_[a-z2-7]+$/);
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.minted).toBe(true);
  });

  it('second GET within TTL returns the SAME plaintext + minted:false (idempotent within window)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const r1 = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const r2 = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r1.json<{ gui_control_key: string }>().gui_control_key).toBe(
      r2.json<{ gui_control_key: string }>().gui_control_key,
    );
    expect(r1.json<{ minted: boolean }>().minted).toBe(true);
    expect(r2.json<{ minted: boolean }>().minted).toBe(false);
  });

  it('closed sessions reject an existing-key echo without returning the credential', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const minted = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(minted.statusCode).toBe(200);
    expect(minted.json<{ gui_control_key: string }>().gui_control_key).toMatch(/^gck_/);

    await fx.agentSessionsRepo!.closeWithReason(id, 'customer-closed');
    const rejected = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<Record<string, unknown>>()).not.toHaveProperty('gui_control_key');
  });

  it('a close winner during mint returns 409 and never discloses or persists the generated key', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const repo = fx.agentSessionsRepo!;
    const original = repo.setGuiControlKeyIfActive.bind(repo);
    vi.spyOn(repo, 'setGuiControlKeyIfActive').mockImplementationOnce(async (args) => {
      await repo.closeWithReason(args.id, 'customer-closed');
      return original(args);
    });

    const rejected = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<Record<string, unknown>>()).not.toHaveProperty('gui_control_key');
    expect(await repo.get(id)).toMatchObject({
      status: 'closed',
      closedReason: 'customer-closed',
      guiControlKeyCiphertext: null,
      guiControlKeyExpiresAt: null,
    });
  });

  it('account-authenticated GET replaces a non-expired legacy unbound key, then remains idempotent', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const legacyPlaintext = 'gck_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await fx.agentSessionsRepo!.setGuiControlKey({
      id,
      ciphertext: encryptLegacyUnbound(legacyPlaintext),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const rejectedLegacy = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { 'x-driftstack-gui-control-key': legacyPlaintext },
    });
    expect(rejectedLegacy.statusCode).toBe(401);

    const recovered = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(recovered.statusCode).toBe(200);
    const recoveredBody = recovered.json<{
      gui_control_key: string;
      expires_at: string;
      minted: boolean;
    }>();
    expect(recoveredBody.minted).toBe(true);
    expect(recoveredBody.gui_control_key).not.toBe(legacyPlaintext);

    const echo = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(echo.statusCode).toBe(200);
    expect(echo.json<{ gui_control_key: string; minted: boolean }>()).toMatchObject({
      gui_control_key: recoveredBody.gui_control_key,
      minted: false,
    });
  });

  it('account-authenticated GET replaces a corrupt non-expired blob instead of returning 500', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    await fx.agentSessionsRepo!.setGuiControlKey({
      id,
      ciphertext: Buffer.alloc(64, 0),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const recovered = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ gui_control_key: string; minted: boolean }>()).toMatchObject({
      minted: true,
    });
    expect(recovered.json<{ gui_control_key: string }>().gui_control_key).toMatch(
      /^gck_[a-z2-7]{32}$/,
    );
  });

  it('cross-account guard — 404 when caller does not own the session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_other_account_owned/gui-control-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // V-776 — the mint is a PRIVILEGE COMPOSITION boundary, not just a write gate.
  //
  // Every controlKeyOrAccountAuth route returns on a valid control key BEFORE
  // `app.requireScope(requiredScope)` runs, so the minted key reaches its five
  // `read:sessions` routes — GET /:id, page-state, cookies, downloads, downloads/content —
  // with no scope check at all. A bare-`write` key is refused those reads directly
  // (read:sessions needs `read` or `account_owner`), so without a read gate on the mint it
  // could buy its way into the live cookie jar, page state and downloaded bytes.
  //
  // The original rationale on the route reasoned only about read→write ("a read-only key must
  // not escalate to write+destroy") and missed write→read.
  it('CRITICAL a bare-write key cannot mint — otherwise write composes into read:sessions and the key it is refused directly arrives via the control-key path', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['write'] });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode, 'write alone still creates a session').toBe(201);
    const id = create.json<{ id: string }>().id;

    // The read it is refused DIRECTLY — this is the boundary being protected.
    const direct = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(direct.statusCode, 'bare write cannot read cookies directly').toBe(403);

    // ...and it must not be able to buy a credential that reaches the same data.
    const mint = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(mint.statusCode, 'no control key to replay').toBe(403);
    expect(mint.body).not.toMatch(/gui_control_key|plaintext/);
  });

  it('a read+write key still mints — the gate is additive, not a lockout', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read', 'write'] });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const mint = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(mint.statusCode).toBe(200);
  });

  it('the desktop device key (account_owner only) still mints — it satisfies both verbs, so cli-authorize logins are unaffected', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['account_owner'] });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const mint = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(mint.statusCode).toBe(200);
  });
});

// ─── a control key is scoped to ONE session ────────────────────────────────
//
// Found by asking a different question than "which lines are cold". A census of
// guard CONDITIONS across src/ showed `guiControlKeyAuthorized !== true` at
// FOURTEEN sites, and the flag itself set at three independent ones
// (`agent-sessions.ts`, `agent-sessions-livekit-token.ts`,
// `agent-sessions-transport-report.ts`). Every one of those fourteen uses the
// flag to SKIP the account-ownership check, on the reasoning recorded in the
// source: "the key was already decrypt-matched against THIS session in the
// preHandler, so it is authorized for this one session".
//
// That reasoning is load-bearing and nothing tested it. This file covers
// minting, TTL, and the cross-ACCOUNT guard on minting — but never USING a key
// from one session against another. If the decrypt-match were keyed on anything
// but the URL's session id, one leaked control key would authorize operations on
// every session in the deployment, and fourteen routes would skip ownership for
// it.
//
// ⭐ The arms are per SITE, not per rule: three files set the flag, so the rule
// is implemented three times. That is the pattern that produced six findings in
// a day — a rule written more than once and tested in only some of its copies.
//
// LEDGER — control 13/13:
//
//   key comparison accepts ANY presented value   1 red
//   decrypt AAD drops the sessionId              1 red
//   length check dropped (prefix accepted)       SURVIVES
//
// ⚠️ The first row only reds because session B is given its OWN key. The first
// version of this fixture minted a key for A alone, and then A's key on B was
// refused by the "this session has no key" branch — the comparison was never
// reached, and a build accepting ANY presented value passed every arm. The
// fixture had to be made realistic before the assertion meant anything.
//
// The survivor is honest and expected: the plaintext format is fixed-length
// (`gck_` + 32 base32 chars), so two real keys always compare equal-length and
// the length short-circuit never discriminates here. It guards a
// differing-length presented value, which this fixture cannot produce without
// forging a header — a different test than "one session's key on another".
describe("a gui control key does not authorize another session's routes", () => {
  let fx2: TestAppFixture;

  afterEach(async () => {
    if (fx2) await fx2.cleanup();
  });

  async function twoSessionsAndAKeyForTheFirst(): Promise<{
    a: string;
    b: string;
    keyForA: string;
  }> {
    fx2 = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const auth = { authorization: `Bearer ${fx2.plaintext}` };
    const mk = async (mode: 'manual' | 'pair'): Promise<string> => {
      const res = await fx2.app.inject({
        method: 'POST',
        url: '/v1/agent-sessions',
        headers: auth,
        payload: { token_budget: 50_000, mode },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const a = await mk('pair');
    const b = await mk('pair');
    const mintFor = async (id: string): Promise<string> => {
      const res = await fx2.app.inject({
        method: 'GET',
        url: `/v1/agent-sessions/${id}/gui-control-key`,
        headers: auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ gui_control_key: string }>().gui_control_key;
    };
    const keyForA = await mintFor(a);
    // ⚠️ B gets its OWN key too, and that is not incidental. Measured: without
    // it, B has no stored ciphertext at all, so A's key is refused by the
    // "this session has no key" branch and the comparison is never reached —
    // the arms passed while a mutation that accepted ANY presented value
    // survived. Giving B a real key of its own is what makes the COMPARISON the
    // only thing that can refuse.
    await mintFor(b);
    return { a, b, keyForA };
  }

  it("CRITICAL session A's control key cannot drive session B through the shared preHandler. Fourteen routes skip the ownership check on this flag, so a key that authorized any session would bypass ownership on all of them.", async () => {
    const { b, keyForA } = await twoSessionsAndAKeyForTheFirst();
    const res = await fx2.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${b}/mode`,
      headers: { 'x-driftstack-gui-control-key': keyForA, 'content-type': 'application/json' },
      payload: { mode: 'manual' },
    });
    // No account bearer is sent, so the ONLY thing that could authorize this is
    // the key — and it belongs to a different session.
    expect(res.statusCode, `A's key on B returned ${res.statusCode}`).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("CRITICAL the same key cannot reach session B's transport-report either — a SECOND file sets the flag, with its own copy of the validation", async () => {
    const { b, keyForA } = await twoSessionsAndAKeyForTheFirst();
    const res = await fx2.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${b}/transport-report`,
      headers: { 'x-driftstack-gui-control-key': keyForA, 'content-type': 'application/json' },
      payload: { transport: 'udp', relayed: false, rtt_ms: 12, packet_loss_recent_pct: 0 },
    });
    expect(
      res.statusCode,
      `A's key on B's transport-report returned ${res.statusCode}`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('the key DOES work on its own session, so the refusals above are about scope and not a key that never worked', async () => {
    const { a, keyForA } = await twoSessionsAndAKeyForTheFirst();
    const res = await fx2.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${a}/mode`,
      headers: { 'x-driftstack-gui-control-key': keyForA, 'content-type': 'application/json' },
      payload: { mode: 'manual' },
    });
    expect(res.statusCode, `A's key on A returned ${res.statusCode}`).toBe(200);
  });
});
