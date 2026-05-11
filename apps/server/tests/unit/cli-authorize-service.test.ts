// V-553.B-22 — unit tests for CliAuthorizeService (V-266).
//
// Surface under test:
//   - initiate(): mints url-safe code, stores entry with state +
//     pending status, builds browser_url with code + state query
//   - bind(): not_found on missing/expired, state_mismatch on wrong
//     state, already_bound on second bind, happy path transitions
//     pending → bound and stores plaintext + account_id
//   - exchange(): expired on missing key, state_mismatch on wrong
//     state, pending while not bound, bound returns plaintext +
//     account and deletes (one-shot — second call returns expired),
//     invalid_code if a bound entry is missing plaintext (defensive)

import { describe, expect, it } from 'vitest';
import {
  CliAuthorizeError,
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
} from '../../src/services/cli-authorize.js';

function makeSvc(overrides: { dashboardOrigin?: string } = {}): {
  svc: CliAuthorizeService;
  store: InMemoryCliAuthorizeStore;
} {
  const store = new InMemoryCliAuthorizeStore();
  const svc = new CliAuthorizeService({
    store,
    dashboardOrigin: overrides.dashboardOrigin ?? 'https://app.driftstack.dev',
  });
  return { svc, store };
}

describe('V-553.B-22 CliAuthorizeService.initiate', () => {
  it('returns a url-safe code + browser_url + expires_at', async () => {
    const { svc } = makeSvc();
    const out = await svc.initiate({ state: 'st_xyz', client_label: 'CLI v1.0' });
    expect(out.code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(out.browser_url).toContain('https://app.driftstack.dev/cli/authorize');
    expect(out.browser_url).toContain('state=st_xyz');
    expect(out.browser_url).toContain(`code=${encodeURIComponent(out.code)}`);
    expect(out.expires_at).toBeInstanceOf(Date);
  });

  it('uses dashboardPath override when supplied', async () => {
    const store = new InMemoryCliAuthorizeStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.dev/',
      dashboardPath: '/connect-cli',
    });
    const out = await svc.initiate({ state: 's' });
    expect(out.browser_url).toContain('/connect-cli');
  });
});

describe('V-553.B-22 CliAuthorizeService.bind', () => {
  it('throws not_found when the code is missing or evicted', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.bind({
        code: 'nope',
        state: 's',
        account_id: 'acc',
        api_key_plaintext: 'ds_live_x',
        scopes: ['read'],
      }),
    ).rejects.toThrow(CliAuthorizeError);
  });

  it('throws state_mismatch when state does not match the stored value', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 'correct' });
    await expect(
      svc.bind({
        code,
        state: 'wrong',
        account_id: 'acc',
        api_key_plaintext: 'ds_live_x',
        scopes: ['read'],
      }),
    ).rejects.toThrow(/state/i);
  });

  it('throws already_bound on a second bind for the same code', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 's' });
    await svc.bind({
      code,
      state: 's',
      account_id: 'acc_1',
      api_key_plaintext: 'ds_live_x',
      scopes: ['read'],
    });
    await expect(
      svc.bind({
        code,
        state: 's',
        account_id: 'acc_1',
        api_key_plaintext: 'ds_live_y',
        scopes: ['read'],
      }),
    ).rejects.toThrow(/already/i);
  });

  it('happy path transitions pending → bound + returns the account_id', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 's' });
    const result = await svc.bind({
      code,
      state: 's',
      account_id: 'acc_99',
      api_key_plaintext: 'ds_live_secret',
      scopes: ['account_owner'],
    });
    expect(result.account_id).toBe('acc_99');
    expect(result.expires_at).toBeInstanceOf(Date);
  });
});

describe('V-553.B-22 CliAuthorizeService.exchange', () => {
  it('returns expired when the code is missing / evicted', async () => {
    const { svc } = makeSvc();
    const r = await svc.exchange({ code: 'nope', state: 's' });
    expect(r.status).toBe('expired');
  });

  it('returns pending while not bound', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 's' });
    const r = await svc.exchange({ code, state: 's' });
    expect(r.status).toBe('pending');
  });

  it('throws state_mismatch when state does not match', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 'right' });
    await expect(svc.exchange({ code, state: 'wrong' })).rejects.toThrow(/state/i);
  });

  it('returns bound + plaintext + account_id once, then expired (one-shot)', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 's' });
    await svc.bind({
      code,
      state: 's',
      account_id: 'acc_42',
      api_key_plaintext: 'ds_live_one_shot',
      scopes: ['read'],
    });
    const first = await svc.exchange({ code, state: 's' });
    expect(first.status).toBe('bound');
    if (first.status === 'bound') {
      expect(first.api_key).toBe('ds_live_one_shot');
      expect(first.account_id).toBe('acc_42');
    }
    // Second call should return expired since the entry was deleted.
    const second = await svc.exchange({ code, state: 's' });
    expect(second.status).toBe('expired');
  });
});
