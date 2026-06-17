// Pure-function tests for validateDraft (proxies.ts).
//
// validateDraft governs the SOCKS5-proxy-form Save-button enabled
// state in the GUI Proxies view. The validation is purely structural
// (label required, host required, port 1–65535, username/password
// optional). Drift here would either:
//   - Block legitimate saves (e.g. tightening the port range).
//   - Allow invalid saves through to disk (e.g. empty host), then
//     fail downstream when the WebKit-fork actually tries to dial.
//
// The form-level tests at empty-states.test.tsx mock this function
// to focus on rendering — they don't pin its actual behaviour. This
// fills the gap with direct unit coverage.

import { describe, expect, it } from 'vitest';
import { validateDraft, type ProxyDraft } from '../../src/lib/proxies';

function draft(over: Partial<ProxyDraft> = {}): ProxyDraft {
  return {
    label: 'team SOCKS5 — london',
    host: 'proxy.example.com',
    port: 1080,
    username: null,
    password: null,
    ...over,
  };
}

describe('validateDraft (gui-client/lib/proxies)', () => {
  describe('valid drafts', () => {
    it('accepts the canonical happy-path draft', () => {
      const result = validateDraft(draft());
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual({});
    });

    it('accepts the minimum port (1)', () => {
      expect(validateDraft(draft({ port: 1 })).ok).toBe(true);
    });

    it('accepts the maximum port (65535)', () => {
      expect(validateDraft(draft({ port: 65_535 })).ok).toBe(true);
    });

    it('accepts username/password set (auth path)', () => {
      const result = validateDraft(draft({ username: 'alice', password: 'p4ss' }));
      expect(result.ok).toBe(true);
    });

    it('accepts username-only (some SOCKS5 servers accept username-only auth)', () => {
      // Per the validateDraft comment: "if one is set the other
      // isn't required". The form-side UX makes this configurable.
      const result = validateDraft(draft({ username: 'alice' }));
      expect(result.ok).toBe(true);
    });

    it('accepts password-only (symmetric to username-only)', () => {
      const result = validateDraft(draft({ password: 'p4ss' }));
      expect(result.ok).toBe(true);
    });
  });

  describe('invalid label', () => {
    it('rejects empty label', () => {
      const result = validateDraft(draft({ label: '' }));
      expect(result.ok).toBe(false);
      expect(result.errors.label).toBe('Required.');
    });

    it('rejects whitespace-only label (trim-aware)', () => {
      const result = validateDraft(draft({ label: '   \t  ' }));
      expect(result.ok).toBe(false);
      expect(result.errors.label).toBe('Required.');
    });
  });

  describe('invalid host', () => {
    it('rejects empty host', () => {
      const result = validateDraft(draft({ host: '' }));
      expect(result.ok).toBe(false);
      expect(result.errors.host).toBe('Required.');
    });

    it('rejects whitespace-only host (trim-aware)', () => {
      const result = validateDraft(draft({ host: '  ' }));
      expect(result.ok).toBe(false);
      expect(result.errors.host).toBe('Required.');
    });
  });

  describe('invalid port', () => {
    it('rejects port 0 (below valid range)', () => {
      const result = validateDraft(draft({ port: 0 }));
      expect(result.ok).toBe(false);
      expect(result.errors.port).toBe('Port must be 1–65535.');
    });

    it('rejects port 65536 (above valid range)', () => {
      const result = validateDraft(draft({ port: 65_536 }));
      expect(result.ok).toBe(false);
      expect(result.errors.port).toBe('Port must be 1–65535.');
    });

    it('rejects negative port', () => {
      const result = validateDraft(draft({ port: -1 }));
      expect(result.ok).toBe(false);
      expect(result.errors.port).toBe('Port must be 1–65535.');
    });

    it('rejects non-integer port (e.g. parseFloat from user input)', () => {
      const result = validateDraft(draft({ port: 1080.5 }));
      expect(result.ok).toBe(false);
      expect(result.errors.port).toBe('Port must be 1–65535.');
    });

    it('rejects NaN port (parseInt("") edge)', () => {
      const result = validateDraft(draft({ port: Number.NaN }));
      expect(result.ok).toBe(false);
      expect(result.errors.port).toBe('Port must be 1–65535.');
    });
  });

  describe('aggregate error reporting', () => {
    it('reports all 3 structural errors in one pass (label + host + port)', () => {
      const result = validateDraft({
        label: '',
        host: '',
        port: 0,
        username: null,
        password: null,
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual({
        label: 'Required.',
        host: 'Required.',
        port: 'Port must be 1–65535.',
      });
    });

    it('errors object is empty {} on a fully-valid draft (caller can treat .ok as canonical)', () => {
      const result = validateDraft(draft());
      expect(Object.keys(result.errors)).toEqual([]);
    });
  });

  // OVPN/WG arc — VPN schemes require their parsed config block (the form fills
  // it from the wg0.conf/.ovpn paste); host/port are the endpoint, still validated.
  describe('VPN schemes', () => {
    it('wireguard WITHOUT a block → not ok (errors.wireguard)', () => {
      const r = validateDraft(draft({ scheme: 'wireguard', host: 'vpn.example.com', port: 51820 }));
      expect(r.ok).toBe(false);
      expect(r.errors.wireguard).toBeDefined();
    });

    it('openvpn WITHOUT a block → not ok (errors.openvpn)', () => {
      const r = validateDraft(draft({ scheme: 'openvpn', host: 'vpn.example.com', port: 1194 }));
      expect(r.ok).toBe(false);
      expect(r.errors.openvpn).toBeDefined();
    });

    it('wireguard WITH a block + valid host/port → ok', () => {
      const r = validateDraft(
        draft({
          scheme: 'wireguard',
          host: 'vpn.example.com',
          port: 51820,
          wireguard: {
            private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
            peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
            endpoint: 'vpn.example.com:51820',
            allowed_ips: '0.0.0.0/0',
          },
        }),
      );
      expect(r.ok).toBe(true);
    });
  });
});
