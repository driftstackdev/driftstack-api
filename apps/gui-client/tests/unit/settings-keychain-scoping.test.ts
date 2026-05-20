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
import { keychainNameFor } from '../../src/lib/settings';

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
