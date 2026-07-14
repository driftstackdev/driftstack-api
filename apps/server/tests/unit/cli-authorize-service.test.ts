// V-553.B-22 — unit tests for CliAuthorizeService (V-266).
//
// Surface under test:
//   - initiate(): mints url-safe code, stores entry with state +
//     pending status, builds browser_url with code + state query
//   - bind(): not_found on missing/expired, state_mismatch on wrong
//     state, already_bound on second bind, happy path transitions
//     pending → bound and stores encrypted secret + account_id
//   - exchange(): expired on missing key, state_mismatch on wrong
//     state, pending while not bound, bound returns plaintext +
//     account and deletes (one-shot — second call returns expired),
//     invalid_code + consumption for malformed external store state

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CliAuthorizeError,
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
  cliAuthorizeRedisKey,
} from '../../src/services/cli-authorize.js';
import { encryptPlatformSecret } from '../../src/lib/platform-secret-encryption.js';

const STATE = 'st_' + 'a'.repeat(20);
const ENC_KEY = randomBytes(32).toString('base64');

function makeSvc(overrides: { dashboardOrigin?: string } = {}): {
  svc: CliAuthorizeService;
  store: InMemoryCliAuthorizeStore;
} {
  const store = new InMemoryCliAuthorizeStore();
  const svc = new CliAuthorizeService({
    store,
    dashboardOrigin: overrides.dashboardOrigin ?? 'https://app.driftstack.dev',
    secretEncryptionKeyBase64: ENC_KEY,
  });
  return { svc, store };
}

class SwappingClaimStore extends InMemoryCliAuthorizeStore {
  claimedOverride: string | null = null;

  override async getDel(key: string): Promise<string | null> {
    const claimed = await super.getDel(key);
    return this.claimedOverride ?? claimed;
  }
}

describe('V-553.B-22 CliAuthorizeService.initiate', () => {
  it('returns a url-safe code + browser_url + expires_at', async () => {
    const { svc, store } = makeSvc();
    const out = await svc.initiate({ state: 'st_xyz', client_label: 'CLI v1.0' });
    expect(out.code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(out.browser_url).toContain('https://app.driftstack.dev/cli/authorize');
    expect(out.browser_url).toContain('state=st_xyz');
    expect(out.browser_url).toContain(`code=${encodeURIComponent(out.code)}`);
    expect(out.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(out.browser_url).not.toContain(out.user_code);
    expect(out.expires_at).toBeInstanceOf(Date);
    const redisKey = cliAuthorizeRedisKey(out.code);
    expect(redisKey).toMatch(/^cli-auth:code:[0-9a-f]{64}$/);
    expect(redisKey).not.toContain(out.code);
    const stored = await store.get(redisKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(out.user_code);
    const storedRecord = JSON.parse(stored ?? '{}') as Record<string, unknown>;
    expect(storedRecord).not.toHaveProperty('user_code');
    expect(storedRecord).toMatchObject({
      user_code_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(storedRecord.user_code_hash).not.toBe(
      createHash('sha256').update(out.user_code.replace('-', '')).digest('hex'),
    );
    expect(new URL(out.browser_url).searchParams.has('user_code')).toBe(false);
  });

  it('uses dashboardPath override when supplied', async () => {
    const store = new InMemoryCliAuthorizeStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.dev/',
      dashboardPath: '/connect-cli',
      secretEncryptionKeyBase64: ENC_KEY,
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
        user_code: 'ABCD-EFGH',
        account_id: 'acc',
        api_key_plaintext: 'ds_live_x',
      }),
    ).rejects.toThrow(CliAuthorizeError);
  });

  it('throws state_mismatch when state does not match the stored value', async () => {
    const { svc } = makeSvc();
    const { code, user_code } = await svc.initiate({ state: 'correct' });
    await expect(
      svc.bind({
        code,
        state: 'wrong',
        user_code,
        account_id: 'acc',
        api_key_plaintext: 'ds_live_x',
      }),
    ).rejects.toThrow(/state/i);
  });

  it('throws already_bound on a second bind for the same code', async () => {
    const { svc } = makeSvc();
    const { code, user_code } = await svc.initiate({ state: 's' });
    await svc.bind({
      code,
      state: 's',
      user_code,
      account_id: 'acc_1',
      api_key_plaintext: 'ds_live_x',
    });
    await expect(
      svc.bind({
        code,
        state: 's',
        user_code,
        account_id: 'acc_1',
        api_key_plaintext: 'ds_live_y',
      }),
    ).rejects.toThrow(/already/i);
  });

  it('happy path transitions pending → bound + returns the account_id', async () => {
    const { svc } = makeSvc();
    const { code, user_code } = await svc.initiate({ state: 's' });
    const result = await svc.bind({
      code,
      state: 's',
      user_code,
      account_id: 'acc_99',
      api_key_plaintext: 'ds_live_secret',
    });
    expect(result.account_id).toBe('acc_99');
    expect(result.expires_at).toBeInstanceOf(Date);
  });

  it('atomically permits exactly one of two overlapping binds', async () => {
    const { svc } = makeSvc();
    const { code, user_code } = await svc.initiate({ state: 's' });
    const bind = (suffix: string) =>
      svc.bind({
        code,
        state: 's',
        user_code,
        account_id: `acc_${suffix}`,
        api_key_plaintext: `ds_live_${suffix}`,
      });

    const results = await Promise.allSettled([bind('first'), bind('second')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'already_bound' }),
    });

    const exchange = await svc.exchange({ code, state: 's' });
    expect(exchange.status).toBe('bound');
    if (exchange.status === 'bound') {
      expect(['ds_live_first', 'ds_live_second']).toContain(exchange.api_key);
    }
  });

  it('requires the device-displayed user code and accepts normalized case', async () => {
    const { svc } = makeSvc();
    const initiated = await svc.initiate({ state: 's' });
    const wrongUserCode =
      (initiated.user_code.startsWith('A') ? 'B' : 'A') + initiated.user_code.slice(1);

    await expect(
      svc.bind({
        code: initiated.code,
        state: 's',
        user_code: wrongUserCode,
        account_id: 'acc_wrong',
        api_key_plaintext: 'ds_live_wrong',
      }),
    ).rejects.toMatchObject({ code: 'user_code_mismatch' });

    await expect(
      svc.bind({
        code: initiated.code,
        state: 's',
        user_code: initiated.user_code.toLowerCase(),
        account_id: 'acc_right',
        api_key_plaintext: 'ds_live_right',
      }),
    ).resolves.toMatchObject({ account_id: 'acc_right' });
  });

  it('consumes malformed JSON and returns invalid_code instead of a repeat 500', async () => {
    const { svc, store } = makeSvc();
    const { code, user_code } = await svc.initiate({ state: 's' });
    const key = cliAuthorizeRedisKey(code);
    await store.setEx(key, '{"state":', 300);

    await expect(
      svc.bind({
        code,
        state: 's',
        user_code,
        account_id: 'acc_bad',
        api_key_plaintext: 'ds_live_never_stored',
      }),
    ).rejects.toMatchObject({ code: 'invalid_code' });
    expect(await store.get(key)).toBeNull();
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

  it('returns state_mismatch for equal-character Unicode with unequal UTF-8 byte length', async () => {
    const { svc } = makeSvc();
    const { code } = await svc.initiate({ state: 'a'.repeat(16) });
    await expect(svc.exchange({ code, state: 'é'.repeat(16) })).rejects.toMatchObject({
      code: 'state_mismatch',
    });
  });

  it('returns bound + plaintext + account_id once, then expired (one-shot)', async () => {
    const { svc } = makeSvc();
    const { code, user_code } = await svc.initiate({ state: 's' });
    await svc.bind({
      code,
      state: 's',
      user_code,
      account_id: 'acc_42',
      api_key_plaintext: 'ds_live_one_shot',
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

  it.each([
    ['missing user-code verifier', { user_code_hash: undefined }],
    ['wrong pending secret shape', { secret_blob: 'plaintext' }],
    ['wrong pending encrypted flag', { encrypted: true }],
    ['wrong account type', { account_id: 42 }],
    ['non-finite creation time', { created_at: Number.POSITIVE_INFINITY }],
    ['unknown status', { status: 'approved' }],
  ])('consumes %s store corruption and then reports expired', async (_name, override) => {
    const { svc, store } = makeSvc();
    const { code } = await svc.initiate({ state: 's' });
    const key = cliAuthorizeRedisKey(code);
    const raw = await store.get(key);
    expect(raw).not.toBeNull();
    const pending = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    await store.setEx(key, JSON.stringify({ ...pending, ...override }), 300);

    await expect(svc.exchange({ code, state: 's' })).rejects.toMatchObject({
      code: 'invalid_code',
    });
    await expect(svc.exchange({ code, state: 's' })).resolves.toEqual({ status: 'expired' });
  });

  it('fails closed when the atomic claim differs from the record that passed state validation', async () => {
    const store = new SwappingClaimStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.dev',
      secretEncryptionKeyBase64: ENC_KEY,
    });
    const first = await svc.initiate({ state: STATE });
    await svc.bind({
      code: first.code,
      state: STATE,
      user_code: first.user_code,
      account_id: 'acc_first',
      api_key_plaintext: 'ds_live_first',
    });
    const second = await svc.initiate({ state: STATE });
    await svc.bind({
      code: second.code,
      state: STATE,
      user_code: second.user_code,
      account_id: 'acc_second',
      api_key_plaintext: 'ds_live_second',
    });
    store.claimedOverride = await store.get(cliAuthorizeRedisKey(second.code));
    expect(store.claimedOverride).not.toBeNull();

    await expect(svc.exchange({ code: first.code, state: STATE })).rejects.toMatchObject({
      code: 'invalid_code',
    });
    await expect(svc.exchange({ code: first.code, state: STATE })).resolves.toEqual({
      status: 'expired',
    });
  });

  it('refuses a valid encrypted key blob moved between two bound records', async () => {
    const { svc, store } = makeSvc();
    const first = await svc.initiate({ state: STATE });
    const second = await svc.initiate({ state: STATE });
    await svc.bind({
      code: first.code,
      state: STATE,
      user_code: first.user_code,
      account_id: 'acc_first',
      api_key_plaintext: 'ds_test_first',
    });
    await svc.bind({
      code: second.code,
      state: STATE,
      user_code: second.user_code,
      account_id: 'acc_second',
      api_key_plaintext: 'ds_test_second',
    });

    const firstKey = cliAuthorizeRedisKey(first.code);
    const firstRaw = await store.get(firstKey);
    const secondRaw = await store.get(cliAuthorizeRedisKey(second.code));
    expect(firstRaw).not.toBeNull();
    expect(secondRaw).not.toBeNull();
    const firstRecord = JSON.parse(firstRaw ?? '{}') as Record<string, unknown>;
    const secondRecord = JSON.parse(secondRaw ?? '{}') as Record<string, unknown>;
    await store.setEx(
      firstKey,
      JSON.stringify({ ...firstRecord, secret_blob: secondRecord.secret_blob }),
      120,
    );

    await expect(svc.exchange({ code: first.code, state: STATE })).resolves.toEqual({
      status: 'expired',
    });
  });

  it('refuses a bound record whose state is rewritten with matching caller input', async () => {
    const { svc, store } = makeSvc();
    const initiated = await svc.initiate({ state: STATE });
    await svc.bind({
      code: initiated.code,
      state: STATE,
      user_code: initiated.user_code,
      account_id: 'acc_state_bound',
      api_key_plaintext: 'ds_test_state_bound',
    });

    const key = cliAuthorizeRedisKey(initiated.code);
    const raw = await store.get(key);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    const rewrittenState = 'st_' + 'b'.repeat(20);
    await store.setEx(key, JSON.stringify({ ...record, state: rewrittenState }), 120);

    await expect(svc.exchange({ code: initiated.code, state: rewrittenState })).resolves.toEqual({
      status: 'expired',
    });
  });
});

describe('V-266 D1 — encryption of the minted key at rest', () => {
  it('does NOT store the plaintext key in the KV blob, and round-trips it back on exchange', async () => {
    const store = new InMemoryCliAuthorizeStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.dev',
      secretEncryptionKeyBase64: ENC_KEY,
    });
    const { code, user_code } = await svc.initiate({ state: STATE });
    await svc.bind({
      code,
      state: STATE,
      user_code,
      account_id: 'acc_enc',
      api_key_plaintext: 'ds_live_secret_at_rest',
    });
    // The blob that actually sits in Redis must not contain the plaintext.
    const rawStored = await store.get(cliAuthorizeRedisKey(code));
    expect(rawStored).not.toBeNull();
    expect(rawStored ?? '').not.toContain('ds_live_secret_at_rest');
    expect(rawStored ?? '').toContain('"encrypted":true');
    // Exchange decrypts and hands back the original plaintext.
    const ex = await svc.exchange({ code, state: STATE });
    expect(ex.status).toBe('bound');
    if (ex.status === 'bound') expect(ex.api_key).toBe('ds_live_secret_at_rest');
  });

  it('consumes a legacy plaintext-bound entry instead of returning the credential', async () => {
    const store = new InMemoryCliAuthorizeStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.dev',
      secretEncryptionKeyBase64: ENC_KEY,
    });
    const { code } = await svc.initiate({ state: STATE });
    const raw = await store.get(cliAuthorizeRedisKey(code));
    expect(raw).not.toBeNull();
    const pending = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    await store.setEx(
      cliAuthorizeRedisKey(code),
      JSON.stringify({
        ...pending,
        status: 'bound',
        secret_blob: 'ds_live_legacy_plaintext',
        encrypted: false,
        account_id: 'acc_plain',
      }),
      120,
    );
    await expect(svc.exchange({ code, state: STATE })).rejects.toMatchObject({
      code: 'invalid_code',
    });
    await expect(svc.exchange({ code, state: STATE })).resolves.toEqual({ status: 'expired' });
  });

  it('consumes a pre-v2 encrypted bound entry as expired', async () => {
    const { svc, store } = makeSvc();
    const { code } = await svc.initiate({ state: STATE });
    const key = cliAuthorizeRedisKey(code);
    const raw = await store.get(key);
    expect(raw).not.toBeNull();
    const pending = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    await store.setEx(
      key,
      JSON.stringify({
        ...pending,
        status: 'bound',
        secret_blob: encryptPlatformSecret('ds_test_pre_v2', ENC_KEY).toString('base64'),
        encrypted: true,
        account_id: 'acc_pre_v2',
      }),
      120,
    );

    await expect(svc.exchange({ code, state: STATE })).resolves.toEqual({ status: 'expired' });
  });
});

describe('V-266 C2 — atomic one-shot exchange (no double-delivery under concurrency)', () => {
  it('two overlapping exchanges on one bound code deliver the key exactly once', async () => {
    const store = new InMemoryCliAuthorizeStore();
    const svc = new CliAuthorizeService({
      store,
      dashboardOrigin: 'https://app.driftstack.dev',
      secretEncryptionKeyBase64: ENC_KEY,
    });
    const { code, user_code } = await svc.initiate({ state: STATE });
    await svc.bind({
      code,
      state: STATE,
      user_code,
      account_id: 'acc_race',
      api_key_plaintext: 'ds_live_race',
    });
    const [a, b] = await Promise.all([
      svc.exchange({ code, state: STATE }),
      svc.exchange({ code, state: STATE }),
    ]);
    // Exactly one poll observes 'bound'; the other loses the atomic claim
    // and gets 'expired' — never two deliveries of the one-shot key.
    expect([a.status, b.status].sort()).toEqual(['bound', 'expired']);
    const bound = [a, b].find((r) => r.status === 'bound');
    if (bound && bound.status === 'bound') expect(bound.api_key).toBe('ds_live_race');
  });
});
