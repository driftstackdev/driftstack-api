// Behavioural coverage for the resources no test ever called.
//
// `client.mfa`, `client.legal` and `client.emailPreferences` had zero usages in
// any test — measured, not assumed, by scanning every `.test.ts` in the repo for
// the symbols and for `client.<name>.`.
//
// V-1419 — `client.auth` joined them. Coverage over the packages tree (which the
// gate's `include` does not reach — see V-1407) reported ten of its eleven methods
// as never EXECUTED: everything except `login`, which `auth-login-union` drives.
// Signup, email verification, both magic-link halves, both password-reset halves,
// refresh, logout, and both MFA exchanges — the whole authentication surface a
// customer's own app calls — were reached by nothing.
//
// They were not unguarded: content-parity pins hold each method's verb, path and
// JSDoc, and they are strong. Three mutations confirmed it — dropping the request
// body, flipping DELETE to POST, and even hiding the whole request inside a
// branch that never runs while leaving every pinned string verbatim in the file.
// All three reds.
//
// What a source-text pin cannot show is that calling the method actually issues
// that request. It reads the file; it never runs the code. So this file drives
// each resource through the real class with a recording transport.
//
// Being exact about what that buys, because the tempting claim is wrong: for
// every mutation tried here, the existing pins ALSO red. Swapping the opt-out
// polarity — a one-character edit — reds two pin cases with this file deleted,
// because they hold the `opted_in: false` / `opted_in: true` literals. So these
// are not catching something nothing else catches, and saying so would misread
// the suite.
//
// What they are is a second, independent kind of evidence, and the value shows
// up when the first kind moves. A pin is matched against source text, so any
// refactor that changes formatting forces someone to update it — and updating a
// pin to match new text is not the same as re-verifying the behaviour. Eight
// tests in this repo were found skipped rather than updated when page copy was
// rewritten, and five of them had silently stopped checking anything. A
// behavioural test does not need editing when the source is reformatted, and it
// keeps holding if a pin is ever relaxed or retired.

import { describe, expect, it, vi } from 'vitest';
import { MfaResource } from '../../src/resources/mfa.js';
import { LegalResource } from '../../src/resources/legal.js';
import { EmailPreferencesResource } from '../../src/resources/email-preferences.js';
import { AccountResource } from '../../src/resources/account.js';
import { AuthResource } from '../../src/resources/auth.js';
import { ProfilesResource } from '../../src/resources/profiles.js';
import { BillingResource } from '../../src/resources/billing.js';
import { UsageResource } from '../../src/resources/usage.js';
import { SessionsResource } from '../../src/resources/sessions.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

/** A transport that records what the resource asked it to send. */
function recorder<T>(reply: T): { http: HttpClient; calls: RequestOpts[] } {
  const calls: RequestOpts[] = [];
  const request = vi.fn((opts: RequestOpts) => {
    calls.push(opts);
    return Promise.resolve(reply);
  });
  return { http: { request } as unknown as HttpClient, calls };
}

describe('MfaResource — driven, not read', () => {
  it('status() issues GET /v1/account/mfa with no body', async () => {
    const { http, calls } = recorder({ enrolled: false });
    await new MfaResource(http).status();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/v1/account/mfa');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('enroll() POSTs an empty body rather than omitting it, so the server sees a JSON object', async () => {
    const { http, calls } = recorder({ otpauth_uri: 'otpauth://x', secret: 's' });
    await new MfaResource(http).enroll();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/account/mfa/enroll');
    expect(calls[0]!.body).toEqual({});
  });

  it("CRITICAL verify() forwards the caller's code verbatim. Dropping or rewriting the body here would make every enrollment fail with a correct code, and the failure would look like the customer mistyping.", async () => {
    const { http, calls } = recorder({ recovery_codes: ['a', 'b'] });
    const result = await new MfaResource(http).verify({ code: '123456' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/account/mfa/verify');
    expect(calls[0]!.body).toEqual({ code: '123456' });
    expect(result.recovery_codes).toEqual(['a', 'b']);
  });

  it("CRITICAL disable() uses DELETE and forwards the literal confirmation phrase. The body is `{ confirm: 'disable-mfa' }` — a deliberate speed bump, not an MFA code — so a client that drops or rewrites it turns a two-step teardown of the customer's second factor into a one-step one.", async () => {
    const { http, calls } = recorder(undefined);
    await new MfaResource(http).disable({ confirm: 'disable-mfa' });
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.path).toBe('/v1/account/mfa');
    expect(calls[0]!.body).toEqual({ confirm: 'disable-mfa' });
  });

  it('regenerateRecoveryCodes() POSTs to the regenerate path with an empty body', async () => {
    const { http, calls } = recorder({ recovery_codes: [] });
    await new MfaResource(http).regenerateRecoveryCodes();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/account/mfa/recovery-codes/regenerate');
    expect(calls[0]!.body).toEqual({});
  });
});

describe('AccountResource web-session revocation — the bug this caught', () => {
  it('CRITICAL revokeAllOtherWebSessions sends ?keep=current. The endpoint REFUSES a bulk revoke without it — "Bulk revoke requires `?keep=current`. Pass it explicitly to confirm intent." — so omitting it made this method a guaranteed 400 in all three SDKs while the dashboard, which always sent it, worked. Nothing caught that, because every guard pinned the method signature and none asserted the URL.', async () => {
    const { http, calls } = recorder(undefined);
    await new AccountResource(http).revokeAllOtherWebSessions();
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.path).toBe('/v1/account/web-sessions');
    expect(
      (calls[0] as { query?: Record<string, unknown> }).query,
      'the confirm-intent query the server requires',
    ).toEqual({ keep: 'current' });
  });

  it('revokeWebSession targets one id on the item path, so the single and bulk revocations cannot be confused for each other.', async () => {
    const { http, calls } = recorder(undefined);
    await new AccountResource(http).revokeWebSession('wsess_abc');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.path).toBe('/v1/account/web-sessions/wsess_abc');
  });
});

describe('LegalResource — driven, not read', () => {
  it('documents() and required() are DISTINCT reads. They differ by one path segment and return different sets — the catalogue versus what this account still owes — so a copy-paste between them would silently tell a customer they have nothing to accept.', async () => {
    const docs = recorder({ data: [] });
    await new LegalResource(docs.http).documents();
    expect(docs.calls[0]!.method).toBe('GET');
    expect(docs.calls[0]!.path).toBe('/v1/legal/documents');

    const req = recorder({ data: [] });
    await new LegalResource(req.http).required();
    expect(req.calls[0]!.method).toBe('GET');
    expect(req.calls[0]!.path).toBe('/v1/legal/required');

    expect(docs.calls[0]!.path).not.toBe(req.calls[0]!.path);
  });

  it('accept() POSTs the acceptance tuple verbatim. The content_hash is what binds the acceptance to an exact document version, so a body that drops it records consent to nothing in particular.', async () => {
    const { http, calls } = recorder({ accepted_at: '2026-08-01T00:00:00Z' });
    const body = { document_key: 'tos', version: '2026-01', content_hash: 'abc123' };
    await new LegalResource(http).accept(body);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/legal/accept');
    expect(calls[0]!.body).toEqual(body);
  });
});

describe('EmailPreferencesResource — driven, not read', () => {
  it('list() issues GET /v1/account/email-preferences', async () => {
    const { http, calls } = recorder({ data: [] });
    await new EmailPreferencesResource(http).list();
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/v1/account/email-preferences');
  });

  it('set() PUTs the preference. PUT rather than POST matters: the server treats this as an idempotent upsert of one event type, so a POST would be a different contract.', async () => {
    const { http, calls } = recorder(undefined);
    await new EmailPreferencesResource(http).set({
      event_type: 'billing-receipt',
      opted_in: true,
    });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe('/v1/account/email-preferences');
    expect(calls[0]!.body).toEqual({ event_type: 'billing-receipt', opted_in: true });
  });

  it('CRITICAL optOut sends opted_in:false and optIn sends opted_in:true. They delegate to the same set() one boolean apart, so swapping them opts a customer back IN to mail they asked to stop — a consent defect rather than a UI bug. The content-parity pin holds these literals too; this asserts the delegation actually happens, which reading the file cannot show.', async () => {
    const out = recorder(undefined);
    await new EmailPreferencesResource(out.http).optOut('billing-receipt');
    expect(out.calls[0]!.body).toEqual({ event_type: 'billing-receipt', opted_in: false });

    const back = recorder(undefined);
    await new EmailPreferencesResource(back.http).optIn('billing-receipt');
    expect(back.calls[0]!.body).toEqual({ event_type: 'billing-receipt', opted_in: true });

    // Asserted against each other too: identical polarity in both would satisfy
    // neither expectation above only by accident of which literal was wrong.
    expect(out.calls[0]!.body).not.toEqual(back.calls[0]!.body);
  });

  it('optOut forwards the event type it was given rather than a fixed one, so opting out of one email does not silence a different one.', async () => {
    const { http, calls } = recorder(undefined);
    await new EmailPreferencesResource(http).optOut('tier-changed');
    expect(calls[0]!.body).toEqual({ event_type: 'tier-changed', opted_in: false });
  });
});

// V-1419 — the auth resource. Each entry was cross-checked against the SERVER's
// routes before being pinned here, not merely copied out of the SDK: a table that
// records whatever the client currently sends would freeze a wrong path as
// correct, which is exactly the defect the `?keep=current` arm above found. All
// ten paths exist on the server with the same verb, so these arms are regression
// evidence rather than a fix — the second, independent kind this file argues for.
describe('AuthResource — the whole surface, none of it previously executed', () => {
  const TOKEN = 'tok_abc123';
  const CASES: ReadonlyArray<
    readonly [
      name: string,
      path: string,
      invoke: (r: AuthResource) => Promise<unknown>,
      body: unknown,
    ]
  > = [
    [
      'signup',
      '/v1/auth/signup',
      (r) => r.signup({ email: 'a@b.test', password: 'pw' }),
      { email: 'a@b.test', password: 'pw' },
    ],
    [
      'verifyEmail',
      '/v1/auth/verify-email',
      (r) => r.verifyEmail({ token: TOKEN }),
      { token: TOKEN },
    ],
    [
      'requestMagicLink',
      '/v1/auth/magic-link/request',
      (r) => r.requestMagicLink({ email: 'a@b.test' }),
      { email: 'a@b.test' },
    ],
    [
      'consumeMagicLink',
      '/v1/auth/magic-link/consume',
      (r) => r.consumeMagicLink({ token: TOKEN }),
      { token: TOKEN },
    ],
    [
      'requestPasswordReset',
      '/v1/auth/password-reset/request',
      (r) => r.requestPasswordReset({ email: 'a@b.test' }),
      { email: 'a@b.test' },
    ],
    [
      'confirmPasswordReset',
      '/v1/auth/password-reset/confirm',
      (r) => r.confirmPasswordReset({ token: TOKEN, password: 'pw2' } as never),
      { token: TOKEN, password: 'pw2' },
    ],
    [
      'refresh',
      '/v1/auth/refresh',
      (r) => r.refresh({ refresh_token: TOKEN } as never),
      { refresh_token: TOKEN },
    ],
    [
      'logout',
      '/v1/auth/logout',
      (r) => r.logout({ session_token: TOKEN } as never),
      { session_token: TOKEN },
    ],
    [
      'mfaChallenge',
      '/v1/auth/mfa/challenge',
      (r) => r.mfaChallenge({ challenge_token: TOKEN, code: '123456' }),
      { challenge_token: TOKEN, code: '123456' },
    ],
    [
      'mfaStepUp',
      '/v1/auth/mfa/step-up',
      (r) => r.mfaStepUp({ code: '123456' }),
      { code: '123456' },
    ],
  ];

  it.each(CASES)(
    'CRITICAL %s POSTs %s and forwards its body verbatim. A wrong path or verb here fails an authentication call in every application built on this SDK, and a dropped body turns a valid credential into a rejected one that reads to the customer as their own mistake.',
    async (_name, path, invoke, body) => {
      const { http, calls } = recorder({});

      await invoke(new AuthResource(http));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.method, 'every auth write is a POST').toBe('POST');
      expect(calls[0]?.path).toBe(path);
      expect(
        calls[0]?.body,
        'the credential the caller supplied must reach the wire unchanged',
      ).toEqual(body);
    },
  );

  it('CRITICAL the ten paths are DISTINCT. They differ by one segment in three pairs — magic-link request/consume, password-reset request/confirm, mfa challenge/step-up — and a copy-paste between halves of a pair would send a consume to the request endpoint, which fails in a way that looks like an expired token.', () => {
    const paths = CASES.map(([, p]) => p);
    expect(new Set(paths).size, 'two auth methods share a path').toBe(paths.length);
  });
});

// V-1420 — the profile lifecycle. Eight of this resource's methods had never
// executed; `create`, `list`, `get`, `delete`, `clone` and `trim` had. Paths were
// cross-checked against the server's `/v1/profiles` routes first, same as V-1419,
// and all eight match.
//
// The pairing that matters is `delete` and `purge`. Both are DELETE and they differ
// by one trailing segment: `/v1/profiles/:id` moves a profile to trash and
// `/v1/profiles/:id/purge` destroys it. A client that confused them would answer a
// customer asking to tidy up by permanently deleting the profile instead, and the
// verb is identical so nothing about the call would look wrong.
describe('ProfilesResource — the lifecycle half nothing executed', () => {
  const ID = 'prof_abc';

  it('CRITICAL purge targets the /purge sub-path, NOT the bare item path. Both are DELETE, so the only thing separating "move to trash" from "destroy permanently" is that segment — and the recoverable operation is the one that shares its shape with the unrecoverable one.', async () => {
    const { http, calls } = recorder(undefined);
    await new ProfilesResource(http).purge(ID);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe(`/v1/profiles/${ID}/purge`);
  });

  it('CRITICAL delete and purge do not share a path. Pinned as a comparison rather than two separate literals, because the failure is that one becomes the other and two independent assertions can both be updated to agree on the wrong value.', async () => {
    const a = recorder(undefined);
    await new ProfilesResource(a.http).delete(ID);
    const b = recorder(undefined);
    await new ProfilesResource(b.http).purge(ID);
    expect(a.calls[0]?.path).not.toBe(b.calls[0]?.path);
    expect(
      b.calls[0]?.path.startsWith(`${a.calls[0]?.path ?? ''}/`),
      'purge is the deeper path',
    ).toBe(true);
  });

  it.each([
    [
      'update',
      'PATCH',
      `/v1/profiles/${ID}`,
      (r: ProfilesResource) => r.update(ID, { label: 'L' } as never),
    ],
    [
      'launch',
      'POST',
      `/v1/profiles/${ID}/launch`,
      (r: ProfilesResource) => r.launch(ID, { label: 'L' }),
    ],
    ['restore', 'POST', `/v1/profiles/${ID}/restore`, (r: ProfilesResource) => r.restore(ID)],
    ['export', 'GET', `/v1/profiles/${ID}/export`, (r: ProfilesResource) => r.export(ID)],
    ['listTrash', 'GET', '/v1/profiles/trash', (r: ProfilesResource) => r.listTrash()],
    [
      'import',
      'POST',
      '/v1/profiles/import',
      (r: ProfilesResource) => r.import({ envelope: {} } as never),
    ],
  ])('%s issues %s %s', async (_n, method, path, invoke) => {
    const { http, calls } = recorder({ data: [] });
    await invoke(new ProfilesResource(http));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(method);
    expect(calls[0]?.path).toBe(path);
  });

  it('CRITICAL transfer forwards the recipient account verbatim on the item path. This hands a profile to a different account — the one operation here that moves data ACROSS a tenant boundary — so a dropped or rewritten body would either fail or, worse, transfer to whatever the server defaulted to.', async () => {
    const { http, calls } = recorder({});
    await new ProfilesResource(http).transfer(ID, { recipient_account_id: 'acc_other' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`/v1/profiles/${ID}/transfer`);
    expect(calls[0]?.body).toEqual({ recipient_account_id: 'acc_other' });
  });

  it('CRITICAL an id is percent-encoded into its path segment. Ids reach these methods from customer code; one carrying a slash would otherwise re-point the request at a different route entirely — `purge` on `a/b` would address `/v1/profiles/a/b/purge`, which is a path nobody audited.', async () => {
    const { http, calls } = recorder(undefined);
    await new ProfilesResource(http).purge('a/b c');
    expect(calls[0]?.path).toBe('/v1/profiles/a%2Fb%20c/purge');
  });
});

// V-1421 — the account resource's remaining thirteen. Paths cross-checked against
// the server's `/v1/account` routes first; all thirteen match.
//
// The shape here is a VERB-multiplexed endpoint. `/v1/account/me/byok-anthropic-key`
// serves three different operations that differ only by method — read, set, clear —
// on the customer's own Anthropic credential. A GET that became a DELETE reads as a
// harmless inspection and destroys the stored key; there is no path segment to make
// the difference visible, which is what makes this worth a comparison rather than
// three isolated literals.
describe('AccountResource — the thirteen methods nothing executed', () => {
  it("CRITICAL the three BYOK operations on the shared path are distinguished ONLY by verb, and all three differ. Read, set and clear address the same URL, so a verb that drifts turns an inspection into a deletion of the customer's own API credential with nothing in the request to show it.", async () => {
    const seen: Array<{ method: string; path: string }> = [];
    for (const invoke of [
      (r: AccountResource) => r.getByokAnthropicKey(),
      (r: AccountResource) => r.setByokAnthropicKey('sk-ant-x'),
      (r: AccountResource) => r.clearByokAnthropicKey(),
    ]) {
      const { http, calls } = recorder({});
      await invoke(new AccountResource(http));
      seen.push({ method: calls[0]?.method ?? '', path: calls[0]?.path ?? '' });
    }

    expect(new Set(seen.map((c) => c.path)).size, 'the three share one path by design').toBe(1);
    expect(
      seen.map((c) => c.method),
      'and are separated by verb alone',
    ).toEqual(['GET', 'PUT', 'DELETE']);
  });

  it('CRITICAL the plaintext key travels in the BODY and appears nowhere in the path. A credential moved into the URL is written to every access log, proxy log and browser history along the way — a leak that no response shape would reveal and that this is the only layer able to prevent.', async () => {
    const { http, calls } = recorder({});
    const KEY = 'sk-ant-super-secret-value';

    await new AccountResource(http).setByokAnthropicKey(KEY);

    expect(calls[0]?.body).toEqual({ api_key: KEY });
    expect(calls[0]?.path, 'the key must not be interpolated into the URL').not.toContain(KEY);
    expect(calls[0]?.path).toBe('/v1/account/me/byok-anthropic-key');
  });

  it('CRITICAL the connection test is its own sub-path, not another verb on the shared one. It is the one BYOK call that reaches out to Anthropic, so collapsing it onto the shared path would make a test-connection indistinguishable from a read or a clear.', async () => {
    const { http, calls } = recorder({});
    await new AccountResource(http).testByokAnthropicKey();
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/account/me/byok-anthropic-key/test');
  });

  it.each([
    ['me', 'GET', '/v1/account/me', (r: AccountResource) => r.me()],
    ['updateMe', 'PATCH', '/v1/account/me', (r: AccountResource) => r.updateMe({ name: 'N' })],
    [
      'uploadAvatar',
      'POST',
      '/v1/account/me/avatar',
      (r: AccountResource) =>
        r.uploadAvatar({ content_type: 'image/png', data_base64: 'AA==' } as never),
    ],
    ['clearAvatar', 'DELETE', '/v1/account/me/avatar', (r: AccountResource) => r.clearAvatar()],
    [
      'listWebSessions',
      'GET',
      '/v1/account/web-sessions',
      (r: AccountResource) => r.listWebSessions(),
    ],
    ['rateLimits', 'GET', '/v1/account/rate-limits', (r: AccountResource) => r.rateLimits()],
    [
      'getBundledLlmSettings',
      'GET',
      '/v1/account/me/bundled-llm-settings',
      (r: AccountResource) => r.getBundledLlmSettings(),
    ],
    [
      'updateBundledLlmSettings',
      'PATCH',
      '/v1/account/me/bundled-llm-settings',
      (r: AccountResource) => r.updateBundledLlmSettings({ enabled: true } as never),
    ],
    [
      'getBundledLlmStatus',
      'GET',
      '/v1/account/me/bundled-llm-status',
      (r: AccountResource) => r.getBundledLlmStatus(),
    ],
  ])('%s issues %s %s', async (_n, method, path, invoke) => {
    const { http, calls } = recorder({});
    await invoke(new AccountResource(http));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(method);
    expect(calls[0]?.path).toBe(path);
  });

  it('CRITICAL the bundled-LLM settings read and its STATUS are different endpoints. They differ by one word in the last segment and return different things — what the customer configured versus what the platform currently reports — so a copy-paste between them would show a customer their own settings as though they were live status.', async () => {
    const a = recorder({});
    await new AccountResource(a.http).getBundledLlmSettings();
    const b = recorder({});
    await new AccountResource(b.http).getBundledLlmStatus();
    expect(a.calls[0]?.path).not.toBe(b.calls[0]?.path);
  });
});

// V-1423 — the session operations nothing had called: interact, wait, get, extract,
// plus usage.series and billing.createPortalSession. Paths cross-checked against the
// server first, as in V-1419..V-1421; all match.
//
// The structural hazard repeats the BYOK one from V-1421, on a costlier resource:
// `get` and `destroy` address the SAME path and differ only by verb. Here the
// destructive side ends a live browser session the customer is paying for, and a
// read that became a delete would look, from the call site, exactly like a read.
describe('SessionsResource — the operations nothing executed', () => {
  const SID = 'ses_abc';

  it('CRITICAL reading a session and destroying one share a path and differ only by verb. GET and DELETE against `/v1/sessions/:id` are an inspection and the end of a running browser session; there is no segment to tell them apart, so the pair is pinned as a shape rather than as two literals.', async () => {
    const r = recorder({});
    await new SessionsResource(r.http).get(SID);
    const d = recorder(undefined);
    await new SessionsResource(d.http).destroy(SID);

    expect(r.calls[0]?.path, 'the two address one URL by design').toBe(d.calls[0]?.path);
    expect([r.calls[0]?.method, d.calls[0]?.method], 'and are separated by verb alone').toEqual([
      'GET',
      'DELETE',
    ]);
  });

  it.each([
    [
      'interact',
      `/v1/sessions/${SID}/interact`,
      (x: SessionsResource) => x.interact(SID, { action: 'tap', selector: '#a' } as never),
      { action: 'tap', selector: '#a' },
    ],
    [
      'wait',
      `/v1/sessions/${SID}/wait`,
      (x: SessionsResource) => x.wait(SID, { until: 'load' } as never),
      { until: 'load' },
    ],
    [
      'extract',
      `/v1/sessions/${SID}/extract`,
      (x: SessionsResource) =>
        x.extract(SID, { extractions: [{ name: 'n', selector: 's', type: 'text' }] } as never),
      { extractions: [{ name: 'n', selector: 's', type: 'text' }] },
    ],
  ])(
    'CRITICAL %s POSTs to %s and forwards its body verbatim. The three are sibling sub-paths of one session, so a copy-paste between them sends a wait to the interact endpoint — which fails as a schema error and reads to the customer as a malformed request of their own making.',
    async (_n, path, invoke, body) => {
      const { http, calls } = recorder({});
      await invoke(new SessionsResource(http));
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.path).toBe(path);
      expect(calls[0]?.body).toEqual(body);
    },
  );

  it('CRITICAL the four session sub-paths are distinct. navigate, interact, wait and extract differ by one segment each, and this asserts the SET rather than four literals so that two collapsing onto one cannot be satisfied by updating both.', async () => {
    const paths: string[] = [];
    for (const invoke of [
      (x: SessionsResource) => x.navigate(SID, { url: 'https://e.test' }),
      (x: SessionsResource) => x.interact(SID, { action: 'tap', selector: '#a' } as never),
      (x: SessionsResource) => x.wait(SID, { until: 'load' } as never),
      (x: SessionsResource) =>
        x.extract(SID, { extractions: [{ name: 'n', selector: 's', type: 'text' }] } as never),
    ]) {
      const { http, calls } = recorder({});
      await invoke(new SessionsResource(http));
      paths.push(calls[0]?.path ?? '');
    }
    expect(new Set(paths).size, 'two session operations share a path').toBe(paths.length);
  });
});

describe('UsageResource / BillingResource — three more nothing executed', () => {
  it('CRITICAL series() OMITS the query key entirely when no window is given, rather than sending days=undefined. A serialised undefined becomes the literal string in most clients, and the server would read it as a malformed window instead of the default.', async () => {
    const bare = recorder({});
    await new UsageResource(bare.http).series();
    const bareQuery = (bare.calls[0] as { query?: Record<string, unknown> }).query ?? {};
    // `toEqual({})` would PASS against `{ days: undefined }` — it ignores undefined
    // members — so the key's absence is asserted directly. Mutation caught this: the
    // first draft of this arm stayed green with the conditional removed.
    expect(
      Object.keys(bareQuery),
      'no window means the key is absent, not present-and-undefined',
    ).toEqual([]);

    const windowed = recorder({});
    await new UsageResource(windowed.http).series({ days: 30 });
    expect((windowed.calls[0] as { query?: unknown }).query).toEqual({ days: 30 });
  });

  it('currentPeriod() and series() are distinct reads on the usage resource', async () => {
    const a = recorder({});
    await new UsageResource(a.http).currentPeriod();
    const b = recorder({});
    await new UsageResource(b.http).series();
    expect(a.calls[0]?.path).not.toBe(b.calls[0]?.path);
  });

  it('createPortalSession() POSTs to the billing portal path with no body, since the account is identified by the key', async () => {
    const { http, calls } = recorder({});
    await new BillingResource(http).createPortalSession();
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/billing/portal-session');
  });
});
