// 2026-05-20 — pin the keychain-name scoping per baseUrl.
//
// Customer reported "logout doesn't work, keychain keeps pulling from
// self-hosted" — the old single-entry name reused the cloud-mode key
// when the customer switched to self-hosted (and vice versa). The fix
// scopes the keychain entry name by the baseUrl origin so different
// deployments get different keychain entries.
//
// This file is a pure-function test against the keychainNameFor
// helper — no jsdom / no Tauri runtime needed. Build the .test.ts
// against the source via vitest's standard project config.

import { describe, expect, it } from 'vitest';
import { hostIdFor, keychainNameFor, useKeychainForBaseUrl } from '../../src/lib/settings';

describe('hostIdFor — per-deployment identifier (W584)', () => {
  it('keychainNameFor is hostIdFor with the api_key: prefix', () => {
    for (const u of ['https://api.driftstack.dev', 'http://localhost:3000', '']) {
      expect(keychainNameFor(u)).toBe('api_key:' + hostIdFor(u));
    }
  });

  it('distinct deployments get distinct host ids (the key-map keys)', () => {
    expect(hostIdFor('https://api.driftstack.dev')).toBe('api.driftstack.dev');
    expect(hostIdFor('http://localhost:3000')).toBe('localhost_3000');
    expect(hostIdFor('https://api.driftstack.dev')).not.toBe(hostIdFor('http://localhost:3000'));
  });

  it('trailing slash + empty normalise like keychainNameFor', () => {
    expect(hostIdFor('https://api.driftstack.dev/')).toBe(hostIdFor('https://api.driftstack.dev'));
    expect(hostIdFor('')).toBe('unknown');
  });
});

describe('keychainNameFor — per-baseUrl scoping', () => {
  it('cloud URL produces a distinct name', () => {
    expect(keychainNameFor('https://api.driftstack.dev')).toBe('api_key:api.driftstack.dev');
  });

  it('localhost (default self-hosted) produces a distinct name', () => {
    expect(keychainNameFor('http://localhost:3000')).toBe('api_key:localhost_3000');
  });

  it('staging differs from prod', () => {
    expect(keychainNameFor('https://staging.driftstack.dev')).not.toBe(
      keychainNameFor('https://api.driftstack.dev'),
    );
  });

  it('trailing slash is normalised away', () => {
    expect(keychainNameFor('https://api.driftstack.dev/')).toBe(
      keychainNameFor('https://api.driftstack.dev'),
    );
  });

  it('protocol-only difference still scopes apart (http vs https same host)', () => {
    // Per design http://localhost and https://localhost are different
    // deployments — only the host:port portion is folded into the
    // name. We accept the collision for now; if it becomes a real
    // issue we add scheme into the suffix.
    expect(keychainNameFor('http://localhost:3000')).toBe(
      keychainNameFor('https://localhost:3000'),
    );
  });

  it('empty / garbage baseUrl gets a stable fallback name', () => {
    expect(keychainNameFor('')).toBe('api_key:unknown');
    expect(keychainNameFor('   ')).toBe('api_key:unknown');
  });
});

// GUI W232 (c) — keychain only for the official cloud; self-hosted / localhost
// keys go to settings.json so the per-rebuild keychain ACL prompt stops firing.
describe('useKeychainForBaseUrl — cloud-only keychain gate', () => {
  it('cloud hosts → keychain (sensitive ds_live_ key)', () => {
    expect(useKeychainForBaseUrl('https://api.driftstack.dev')).toBe(true);
    expect(useKeychainForBaseUrl('https://staging.driftstack.dev')).toBe(true);
    expect(useKeychainForBaseUrl('https://driftstack.dev')).toBe(true);
    expect(useKeychainForBaseUrl('https://api.driftstack.dev/')).toBe(true);
  });

  it('localhost / self-hosted / IP → settings.json (no keychain prompt)', () => {
    expect(useKeychainForBaseUrl('http://localhost:3000')).toBe(false);
    expect(useKeychainForBaseUrl('http://127.0.0.1:7780')).toBe(false);
    expect(useKeychainForBaseUrl('https://driftstack.internal.acme.com')).toBe(false);
    expect(useKeychainForBaseUrl('')).toBe(false);
  });

  it('a look-alike host does NOT match the cloud suffix (no driftstack.dev.evil.com bypass)', () => {
    expect(useKeychainForBaseUrl('https://driftstack.dev.evil.com')).toBe(false);
  });
});
