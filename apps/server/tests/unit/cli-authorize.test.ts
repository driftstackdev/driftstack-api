// V-553.B-2 — unit tests for the V-266 CliAuthorizeService class.
//
// Integration tests at apps/server/tests/integration/cli-authorize.test.ts
// cover the Fastify routes end-to-end. These unit tests pin the service
// state machine directly against the in-memory store, so a regression
// in initiate/bind/exchange semantics is visible without spinning up
// the full HTTP layer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CliAuthorizeError,
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
} from '../../src/services/cli-authorize.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

function makeService(dashboardOrigin = 'https://app.driftstack.local'): {
  svc: CliAuthorizeService;
  store: InMemoryCliAuthorizeStore;
} {
  const store = new InMemoryCliAuthorizeStore();
  const svc = new CliAuthorizeService({
    store,
    dashboardOrigin,
    secretEncryptionKeyBase64: TEST_ENCRYPTION_KEY,
  });
  return { svc, store };
}

describe('V-553.B-2 CliAuthorizeService — initiate', () => {
  it('returns a base64url code, browser_url, and 5-min expires_at', async () => {
    const { svc } = makeService();
    const start = Date.now();
    const r = await svc.initiate({ state: 'st_' + 'x'.repeat(20) });
    expect(r.code).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(r.code.length).toBeGreaterThanOrEqual(40);
    const url = new URL(r.browser_url);
    expect(url.origin).toBe('https://app.driftstack.local');
    expect(url.pathname).toBe('/cli/authorize');
    expect(url.searchParams.get('code')).toBe(r.code);
    expect(url.searchParams.get('state')).toBe('st_' + 'x'.repeat(20));
    expect(r.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(r.browser_url).not.toContain(r.user_code);
    expect(r.expires_at.getTime() - start).toBeGreaterThanOrEqual(5 * 60 * 1000 - 10);
    expect(r.expires_at.getTime() - start).toBeLessThanOrEqual(5 * 60 * 1000 + 100);
  });

  it('honours custom dashboardPath', async () => {
    const store = new InMemoryCliAuthorizeStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.local',
      dashboardPath: '/custom/cli-bind',
      secretEncryptionKeyBase64: TEST_ENCRYPTION_KEY,
    });
    const r = await svc.initiate({ state: 'st_' + 'x'.repeat(20) });
    expect(new URL(r.browser_url).pathname).toBe('/custom/cli-bind');
  });

  it('strips trailing slashes from dashboardOrigin', async () => {
    const { svc } = makeService('https://app.driftstack.local///');
    const r = await svc.initiate({ state: 'st_' + 'x'.repeat(20) });
    // Base URL is normalised — no `///` carried into browser_url.
    expect(r.browser_url.startsWith('https://app.driftstack.local/cli/authorize')).toBe(true);
  });

  it('throws when neither redis nor store is provided', () => {
    expect(
      () =>
        new CliAuthorizeService({
          dashboardOrigin: 'https://app.driftstack.local',
          secretEncryptionKeyBase64: TEST_ENCRYPTION_KEY,
        }),
    ).toThrow(/either `store` or `redis`/);
  });
});

describe('V-553.B-2 CliAuthorizeService — bind', () => {
  it('happy path: pending → bound stores plaintext + account_id', async () => {
    const { svc } = makeService();
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    const r = await svc.bind({
      code: init.code,
      state: 'st_' + 'a'.repeat(20),
      user_code: init.user_code,
      account_id: 'acc_1',
      api_key_plaintext: 'sk_test_plain_v553',
    });
    expect(r.account_id).toBe('acc_1');
    // Exchange should now return the plaintext.
    const ex = await svc.exchange({ code: init.code, state: 'st_' + 'a'.repeat(20) });
    expect(ex).toEqual({ status: 'bound', api_key: 'sk_test_plain_v553', account_id: 'acc_1' });
  });

  it('throws not_found when the code does not exist', async () => {
    const { svc } = makeService();
    await expect(
      svc.bind({
        code: 'made_up_code_' + 'x'.repeat(30),
        state: 'st_' + 'a'.repeat(20),
        user_code: 'ABCD-EFGH',
        account_id: 'acc_1',
        api_key_plaintext: 'sk_test',
      }),
    ).rejects.toBeInstanceOf(CliAuthorizeError);
  });

  it('throws state_mismatch when bind state ≠ initiate state', async () => {
    const { svc } = makeService();
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    await expect(
      svc.bind({
        code: init.code,
        state: 'st_' + 'b'.repeat(20),
        user_code: init.user_code,
        account_id: 'acc_1',
        api_key_plaintext: 'sk',
      }),
    ).rejects.toMatchObject({ code: 'state_mismatch' });
  });

  it('throws already_bound when the same code is bound twice', async () => {
    const { svc } = makeService();
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    await svc.bind({
      code: init.code,
      state: 'st_' + 'a'.repeat(20),
      user_code: init.user_code,
      account_id: 'acc_1',
      api_key_plaintext: 'sk_first',
    });
    await expect(
      svc.bind({
        code: init.code,
        state: 'st_' + 'a'.repeat(20),
        user_code: init.user_code,
        account_id: 'acc_2',
        api_key_plaintext: 'sk_second',
      }),
    ).rejects.toMatchObject({ code: 'already_bound' });
  });

  // ─── losing the compare-and-set, and the error split that follows ────────
  //
  // Two devices can race to bind one authorization code. The loser's CAS fails,
  // and `bind` then RE-READS to say precisely what happened rather than
  // collapsing every loss into one error. The arm above covers only the last of
  // those four outcomes (`already_bound`); the three before it were cold —
  // measured, by neutralizing each against 112 cli-authorize tests.
  //
  // ⚠️ The split is the point, and `state_mismatch` is why. `already_bound`
  // tells a legitimate second device "someone already claimed this code", which
  // is a normal thing to see in a real flow. `state_mismatch` means the winner
  // carried a DIFFERENT state — the code was claimed by a request that was never
  // part of this flow. Collapsing the two would report an attacker's claim as
  // ordinary contention, on the one endpoint that turns a browser session into a
  // device credential.
  //
  // The store is what the test controls: a real interleaving cannot be forced,
  // and the CAS losing is the precondition for every branch here.
  //
  // LEDGER — control 17/17:
  //
  //   :455 lost-CAS not_found neutralized          1 red
  //   :460 lost-CAS invalid_code neutralized       1 red
  //   :463 lost-CAS state_mismatch neutralized     1 red
  //   state_mismatch COLLAPSED into already_bound  1 red
  //
  // The last row is the failure worth guarding: it does not remove a refusal, it
  // deletes the branch so a foreign-state winner is reported as ordinary
  // contention. Every request is still refused, the status is unchanged, and the
  // only thing lost is the operator's ability to tell a race from a claim that
  // was never part of this flow.
  //
  // ⚠️ Two of these arms were retargeted while being written, both because an
  // EARLIER branch answered first: an unparseable payload is caught by
  // invalid_code before state is ever compared, and `user_code_hash` must be 64
  // HEX characters or the parse fails there too. The fixture had to be made
  // valid in the ways the test is not about, so the one thing it IS about is
  // what refuses it.
  function storeLosingCas(latest: string | null): InMemoryCliAuthorizeStore {
    const store = new InMemoryCliAuthorizeStore();
    const realGet = store.get.bind(store);
    let casAttempted = false;
    // `initiate` writes with setEx, so the ONLY compare-and-set in this flow is
    // the bind's — failing it unconditionally is exactly "another bind won".
    store.compareAndSetEx = () => {
      casAttempted = true;
      return Promise.resolve(false);
    };
    // Before the CAS, reads must be real so bind gets past its own preconditions;
    // after it, the re-read is what the branch under test interprets.
    store.get = (key: string) => (casAttempted ? Promise.resolve(latest) : realGet(key));
    return store;
  }

  async function bindLosingCasWith(latest: string | null): Promise<unknown> {
    const store = storeLosingCas(latest);
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.local',
      secretEncryptionKeyBase64: TEST_ENCRYPTION_KEY,
    });
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    return svc.bind({
      code: init.code,
      state: 'st_' + 'a'.repeat(20),
      user_code: init.user_code,
      account_id: 'acc_1',
      api_key_plaintext: 'sk_first',
    });
  }

  it('CRITICAL the loser gets not_found when the code EXPIRED rather than being taken. Both mean "you cannot have it", and only one means "try again with a fresh code".', async () => {
    await expect(bindLosingCasWith(null)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('CRITICAL the loser gets invalid_code when the stored value no longer parses — a corrupted entry must not be reported as ordinary contention', async () => {
    await expect(bindLosingCasWith('{not json')).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('CRITICAL the loser gets state_mismatch when the winner carried a DIFFERENT state. This is the one that must not collapse into already_bound: it says the code was claimed by a request that was never part of this flow, not that a second device beat you to it.', async () => {
    // A payload that PARSES cleanly — otherwise the invalid_code branch above
    // fires first and this one is never reached. Only `state` differs.
    const foreign = JSON.stringify({
      state: 'st_' + 'z'.repeat(20),
      user_code_hash: 'a'.repeat(64), // must be 64 HEX chars or the parse fails first
      client_label: null,
      created_at: Date.now(),
      status: 'pending',
      secret_blob: null,
      encrypted: false,
      account_id: null,
    });
    await expect(bindLosingCasWith(foreign)).rejects.toMatchObject({ code: 'state_mismatch' });
  });
});

describe('V-553.B-2 CliAuthorizeService — exchange', () => {
  it('returns pending before bind', async () => {
    const { svc } = makeService();
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    expect(await svc.exchange({ code: init.code, state: 'st_' + 'a'.repeat(20) })).toEqual({
      status: 'pending',
    });
  });

  it('one-shot: second exchange after bind returns expired', async () => {
    const { svc } = makeService();
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    await svc.bind({
      code: init.code,
      state: 'st_' + 'a'.repeat(20),
      user_code: init.user_code,
      account_id: 'acc_1',
      api_key_plaintext: 'sk_one',
    });
    const first = await svc.exchange({ code: init.code, state: 'st_' + 'a'.repeat(20) });
    expect(first.status).toBe('bound');
    const second = await svc.exchange({ code: init.code, state: 'st_' + 'a'.repeat(20) });
    expect(second).toEqual({ status: 'expired' });
  });

  it('returns expired when the code was never created', async () => {
    const { svc } = makeService();
    expect(
      await svc.exchange({
        code: 'never_existed_' + 'z'.repeat(20),
        state: 'st_' + 'a'.repeat(20),
      }),
    ).toEqual({ status: 'expired' });
  });

  it('throws state_mismatch when exchange state ≠ initiate state', async () => {
    const { svc } = makeService();
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    await expect(
      svc.exchange({ code: init.code, state: 'st_' + 'b'.repeat(20) }),
    ).rejects.toMatchObject({ code: 'state_mismatch' });
  });
});

describe('V-553.B-2 CliAuthorizeService — TTL eviction', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  it('exchange returns expired after >5min, even when never bound', async () => {
    const { svc } = makeService();
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    // Advance past TTL.
    vi.setSystemTime(new Date('2026-05-11T12:06:00Z'));
    expect(await svc.exchange({ code: init.code, state: 'st_' + 'a'.repeat(20) })).toEqual({
      status: 'expired',
    });
  });

  it('bind refreshes TTL — exchange called at +5:30 from initiate succeeds when bind ran at +5:00', async () => {
    const { svc } = makeService();
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
    const init = await svc.initiate({ state: 'st_' + 'a'.repeat(20) });
    // Just before initial TTL expiry.
    vi.setSystemTime(new Date('2026-05-11T12:04:30Z'));
    await svc.bind({
      code: init.code,
      state: 'st_' + 'a'.repeat(20),
      user_code: init.user_code,
      account_id: 'acc_1',
      api_key_plaintext: 'sk_refresh',
    });
    // 5:30 past initiate — would be expired without bind-time refresh.
    vi.setSystemTime(new Date('2026-05-11T12:05:30Z'));
    const ex = await svc.exchange({ code: init.code, state: 'st_' + 'a'.repeat(20) });
    expect(ex.status).toBe('bound');
  });
});
