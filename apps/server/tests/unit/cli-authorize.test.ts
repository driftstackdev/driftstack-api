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
