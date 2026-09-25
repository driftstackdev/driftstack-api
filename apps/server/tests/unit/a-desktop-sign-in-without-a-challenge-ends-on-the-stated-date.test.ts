// GUI audit #9 — the service half of the desktop sign-in's PKCE binding.
//
// The route test (`a-leaked-desktop-sign-in-link-cannot-collect-the-key`) proves
// the behaviour end to end. This file pins the parts only the service can show:
//
//   - the transition has an END. A flow without a challenge is accepted until the
//     stated removal date and refused from that instant, and the date the docs
//     publish is the date the code enforces;
//   - the binding survives the store. The encrypted key is sealed to the
//     challenge, so a record whose challenge was removed or swapped after
//     approval — a partial restore, an operator write, anyone with write access
//     to the store — does not turn back into a flow that needs no verifier;
//   - a pending record written by the previous server version (no challenge
//     field at all) still signs in during a rolling deploy.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as cliAuthorize from '../../src/services/cli-authorize.js';
import {
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
  cliAuthorizeRedisKey,
} from '../../src/services/cli-authorize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const KEY = Buffer.alloc(32, 5).toString('base64');
const STATE = 'state-' + 'x'.repeat(20);

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function service(nowIso?: string): {
  svc: CliAuthorizeService;
  store: InMemoryCliAuthorizeStore;
} {
  const store = new InMemoryCliAuthorizeStore();
  const svc = new CliAuthorizeService({
    store,
    dashboardOrigin: 'https://app.driftstack.local',
    secretEncryptionKeyBase64: KEY,
    ...(nowIso !== undefined ? { now: () => new Date(nowIso) } : {}),
  });
  return { svc, store };
}

/** The exported removal date, read by name so a missing export fails loudly. */
function removalDate(): Date {
  const value = (cliAuthorize as Record<string, unknown>)['LEGACY_CLI_AUTHORIZE_FLOW_ENDS_AT'];
  expect(value, 'cli-authorize.ts must export LEGACY_CLI_AUTHORIZE_FLOW_ENDS_AT').toBeInstanceOf(
    Date,
  );
  return value as Date;
}

describe('GUI audit #9 — a flow without a challenge ends on the stated date', () => {
  it('is accepted until the stated removal date and refused from that instant; a flow with a challenge is unaffected', async () => {
    const ends = removalDate();
    expect(ends.toISOString()).toBe('2027-01-31T00:00:00.000Z');

    const before = service(new Date(ends.getTime() - 1000).toISOString()).svc;
    await expect(before.initiate({ state: STATE })).resolves.toMatchObject({ flow: 'legacy' });

    const after = service(ends.toISOString()).svc;
    await expect(after.initiate({ state: STATE })).rejects.toMatchObject({
      code: 'code_challenge_required',
    });
    await expect(
      after.initiate({ state: STATE, code_challenge: pkcePair().challenge }),
    ).resolves.toMatchObject({ flow: 'pkce' });
  });

  it('the API reference publishes the same removal date the server enforces', () => {
    const doc = readFileSync(resolve(REPO, 'apps/docs/src/pages/api/auth.md'), 'utf8');
    expect(doc).toContain('31 January 2027');
    expect(removalDate().toISOString().slice(0, 10)).toBe('2027-01-31');
  });
});

describe('GUI audit #9 — a verifier the service did not receive is a refusal, never a success', () => {
  it('a flow with a challenge refuses an exchange whose verifier is missing or sent under a mistyped key (code_verifier_required), and a wrong one (code_verifier_mismatch); none of them consumes the record', async () => {
    const { svc } = service();
    const { verifier, challenge } = pkcePair();
    const started = await svc.initiate({ state: STATE, code_challenge: challenge });
    await svc.bind({
      code: started.code,
      state: STATE,
      user_code: started.user_code,
      account_id: 'acc_owner',
      api_key_plaintext: 'ds_live_owner_key',
    });

    await expect(svc.exchange({ code: started.code, state: STATE })).rejects.toMatchObject({
      code: 'code_verifier_required',
    });
    // What the route hands the service when the caller wrote `codeVerifier`:
    // zod drops the unknown key, so the service sees no verifier at all.
    const mistyped = { code: started.code, state: STATE, codeVerifier: verifier };
    const { codeVerifier: _dropped, ...asParsed } = mistyped;
    await expect(svc.exchange(asParsed)).rejects.toMatchObject({
      code: 'code_verifier_required',
    });
    await expect(
      svc.exchange({ code: started.code, state: STATE, code_verifier: pkcePair().verifier }),
    ).rejects.toMatchObject({ code: 'code_verifier_mismatch' });

    await expect(
      svc.exchange({ code: started.code, state: STATE, code_verifier: verifier }),
    ).resolves.toEqual({ status: 'bound', api_key: 'ds_live_owner_key', account_id: 'acc_owner' });
  });
});

describe('GUI audit #9 — the verifier binding survives the store', () => {
  it('CRITICAL removing the challenge from an approved record does not let a caller without the verifier collect the key', async () => {
    const { svc, store } = service();
    const { challenge } = pkcePair();
    const started = await svc.initiate({ state: STATE, code_challenge: challenge });
    await svc.bind({
      code: started.code,
      state: STATE,
      user_code: started.user_code,
      account_id: 'acc_victim',
      api_key_plaintext: 'ds_live_victim_key',
    });

    const key = cliAuthorizeRedisKey(started.code);
    const raw = await store.get(key);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(record['code_challenge']).toBe(challenge);
    // Downgrade attempt: strip the challenge, keep everything else.
    delete record['code_challenge'];
    await store.setEx(key, JSON.stringify(record), 120);

    const result = await svc.exchange({ code: started.code, state: STATE });
    expect(result).toEqual({ status: 'expired' });
    expect(JSON.stringify(result)).not.toContain('ds_live_victim_key');
  });

  it('swapping in a challenge the caller knows the verifier for does not collect the key either', async () => {
    const { svc, store } = service();
    const started = await svc.initiate({ state: STATE, code_challenge: pkcePair().challenge });
    await svc.bind({
      code: started.code,
      state: STATE,
      user_code: started.user_code,
      account_id: 'acc_victim',
      api_key_plaintext: 'ds_live_victim_key',
    });
    const attacker = pkcePair();
    const key = cliAuthorizeRedisKey(started.code);
    const record = JSON.parse((await store.get(key)) ?? '{}') as Record<string, unknown>;
    record['code_challenge'] = attacker.challenge;
    await store.setEx(key, JSON.stringify(record), 120);

    const result = await svc.exchange({
      code: started.code,
      state: STATE,
      code_verifier: attacker.verifier,
    });
    expect(result).toEqual({ status: 'expired' });
  });

  it('a pending record written by the previous server version (no challenge field) still binds and delivers during a rolling deploy', async () => {
    const { svc, store } = service();
    const started = await svc.initiate({ state: STATE });
    const key = cliAuthorizeRedisKey(started.code);
    const record = JSON.parse((await store.get(key)) ?? '{}') as Record<string, unknown>;
    // The previous version wrote exactly these fields and nothing else.
    const previous = {
      state: record['state'],
      user_code_hash: record['user_code_hash'],
      status: 'pending',
      client_label: null,
      secret_blob: null,
      encrypted: false,
      account_id: null,
      created_at: record['created_at'],
    };
    await store.setEx(key, JSON.stringify(previous), 300);

    await svc.bind({
      code: started.code,
      state: STATE,
      user_code: started.user_code,
      account_id: 'acc_old_app',
      api_key_plaintext: 'ds_live_old_app_key',
    });
    await expect(svc.exchangeWithFlow({ code: started.code, state: STATE })).resolves.toEqual({
      result: { status: 'bound', api_key: 'ds_live_old_app_key', account_id: 'acc_old_app' },
      flow: 'legacy',
    });
  });
});
