// A local or allowlist-only proxy is warned about at entry.
//
// Owner: "People that attempt to use a local proxy, or not have IP access
// permissions might have problems running profiles for us; clearly describe
// this limitation, they should use user/pass auth and avoid IP permissions; do
// not confuse a customer that they could add a local proxy and later find out
// it doesn't work."
//
// MEASURED: the desktop app's proxy test is the native `proxy_test` command in
// apps/gui-client/src-tauri/src/lib.rs — "Test a saved SOCKS5 proxy from the
// desktop host". It runs on the customer's own Mac. A proxy on 127.0.0.1 or a
// 192.168.x address, or one that authenticates by IP allowlist with no
// username/password, therefore tests GREEN — and the profile, which runs on
// Driftstack's servers from a different machine and a different IP, cannot use
// it. `validateDraft` (src/lib/proxies.ts) checked label/host/port only, with
// username/password explicitly optional, so nothing in the form said a word.
// The server refuses a private host only at upload (`assertSafeProxyHost` in
// apps/server/src/routes/account-me.ts over `classifyUnsafeHost`) and cannot
// see an allowlist at all.
//
// The fix adds non-blocking `warnings` to validateDraft — `ok` and `errors` are
// untouched, so nothing that saves today is refused — and the form shows them
// beside the field. This file pins the pure function; the rendered half is
// a-local-or-allowlist-proxy-is-warned-in-the-form.test.tsx.

import { describe, expect, it } from 'vitest';
import { isPrivateOrLocalHost, validateDraft, type ProxyDraft } from '../../src/lib/proxies';

const HOST_WARNING =
  "This proxy is on your own machine or private network. Profiles run on Driftstack's servers, which cannot reach it. Use a proxy with a public address.";
const AUTH_WARNING =
  "This proxy has no username or password. IP-allowlist access won't work: profiles run from Driftstack's servers, not from your IP. Ask your provider for user/pass credentials.";

/** A draft that is valid AND public AND credentialed — the shape that must
 *  produce nothing. Every arm overrides exactly the field it is about. */
function draft(overrides: Partial<ProxyDraft> = {}): ProxyDraft {
  return {
    label: 'eu-1',
    host: '203.0.113.9',
    port: 1080,
    username: 'alice',
    password: 'p4ss',
    ...overrides,
  };
}

describe('a local or allowlist-only proxy is warned about at entry', () => {
  it('CRITICAL VACUITY CONTROL — a public host with a username and password produces NO warning and validates exactly as before. Every other arm asserts a warning appears; a validator that warned about everything would satisfy them all, and this is the arm it cannot satisfy.', () => {
    const r = validateDraft(draft());
    expect(r.ok, 'a valid public credentialed draft no longer validates').toBe(true);
    expect(r.errors, 'errors appeared on a valid draft').toEqual({});
    expect(r.warnings, 'a public credentialed proxy was warned about').toEqual({});
  });

  it('CRITICAL 127.0.0.1 is warned about under host: the local probe reaches it and the server never will.', () => {
    const r = validateDraft(draft({ host: '127.0.0.1' }));
    expect(r.warnings?.host, 'a loopback proxy drew no host warning').toBe(HOST_WARNING);
  });

  it("CRITICAL 192.168.1.5 is warned about under host: a proxy on the office network is not a proxy Driftstack's servers can dial.", () => {
    const r = validateDraft(draft({ host: '192.168.1.5' }));
    expect(r.warnings?.host, 'a private-network proxy drew no host warning').toBe(HOST_WARNING);
  });

  it('CRITICAL localhost is warned about under host — the name, not only the address.', () => {
    const r = validateDraft(draft({ host: 'localhost' }));
    expect(r.warnings?.host, 'localhost drew no host warning').toBe(HOST_WARNING);
  });

  it("CRITICAL a proxy with neither username nor password is warned about under auth: with nothing to authenticate, the provider is admitting the customer's IP — and the profile does not come from it.", () => {
    expect(
      validateDraft(draft({ username: null, password: null })).warnings?.auth,
      'null/null drew no auth warning',
    ).toBe(AUTH_WARNING);
    expect(
      validateDraft(draft({ username: '', password: '' })).warnings?.auth,
      'empty strings drew no auth warning',
    ).toBe(AUTH_WARNING);
    expect(
      validateDraft(draft({ username: '   ', password: null })).warnings?.auth,
      'a whitespace-only username counted as a credential',
    ).toBe(AUTH_WARNING);
  });

  it('CRITICAL the two warnings are independent, and each is about its own field. A public host with no credentials warns about auth only; a private host with credentials warns about host only.', () => {
    const noCreds = validateDraft(draft({ username: null, password: null })).warnings;
    expect(noCreds?.host, 'a public host drew a host warning').toBeUndefined();
    expect(noCreds?.auth).toBe(AUTH_WARNING);
    const privateHost = validateDraft(draft({ host: '10.0.0.7' })).warnings;
    expect(privateHost?.host).toBe(HOST_WARNING);
    expect(privateHost?.auth, 'a credentialed proxy drew an auth warning').toBeUndefined();
  });

  it('CRITICAL warnings never block. A local, credential-less draft still validates (ok: true, errors: {}) — the owner asked for a clear description of the limitation, not a refusal that strands a customer whose provider only does allowlists.', () => {
    const r = validateDraft(draft({ host: '127.0.0.1', username: null, password: null }));
    expect(r.ok, 'a warned draft was refused').toBe(true);
    expect(r.errors, 'a warning leaked into errors').toEqual({});
    expect(r.warnings).toEqual({ host: HOST_WARNING, auth: AUTH_WARNING });
  });

  it('CRITICAL errors are unaffected by warnings in the other direction too: an invalid draft (blank label) on a private host still reports its error AND its warning, so neither surface hides the other.', () => {
    const r = validateDraft(draft({ label: '', host: '192.168.0.1' }));
    expect(r.ok).toBe(false);
    expect(r.errors.label, 'the blank-label error vanished when a warning was present').toBe(
      'Required.',
    );
    expect(r.warnings?.host).toBe(HOST_WARNING);
  });

  it('CRITICAL a username-only proxy is NOT an allowlist proxy. Some SOCKS5 servers authenticate on the username alone; the warning is about the absence of ANY client credential.', () => {
    expect(validateDraft(draft({ password: null })).warnings?.auth).toBeUndefined();
    expect(
      validateDraft(draft({ username: null, password: 'p4ss' })).warnings?.auth,
    ).toBeUndefined();
  });

  it('CRITICAL the auth warning is only for schemes that authenticate with a username/password. WireGuard is key-based and OpenVPN carries its credentials in the config block, so an empty pair there is the normal shape — while the HOST warning still applies to a VPN endpoint on a private network.', () => {
    const wg = validateDraft(
      draft({
        scheme: 'wireguard',
        host: '192.168.50.1',
        username: null,
        password: null,
        wireguard: {
          private_key: 'k',
          peer_public_key: 'p',
          endpoint: '192.168.50.1:51820',
          allowed_ips: '0.0.0.0/0',
          address: '10.7.0.2/32',
        },
      }),
    ).warnings;
    expect(wg?.auth, 'a key-based WireGuard proxy was told to add a password').toBeUndefined();
    expect(wg?.host, 'a VPN endpoint on the office network drew no host warning').toBe(
      HOST_WARNING,
    );
    const ovpn = validateDraft(
      draft({
        scheme: 'openvpn',
        username: null,
        password: null,
        openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
      }),
    ).warnings;
    expect(ovpn, 'a public OpenVPN proxy was warned about').toEqual({});
    expect(
      validateDraft(draft({ scheme: 'http', username: null, password: null })).warnings?.auth,
      'an HTTP proxy with no credentials drew no auth warning',
    ).toBe(AUTH_WARNING);
  });

  describe('isPrivateOrLocalHost mirrors the "yours, not public" classes the server refuses at upload', () => {
    it.each([
      'localhost',
      'LOCALHOST',
      'localhost.',
      'proxy.localhost',
      'my-mac.local',
      '0.0.0.0',
      '10.0.0.7',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '127.255.0.9',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.5',
      '::1',
      '[::1]',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fe80::1%en0',
      '::ffff:10.0.0.5',
      '::ffff:192.168.1.2',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::127.0.0.1',
      ' 127.0.0.1 ',
    ])('%s is local or private', (host) => {
      expect(isPrivateOrLocalHost(host)).toBe(true);
    });

    it.each([
      'proxy.example.com',
      'gate.nodemaven.com',
      '203.0.113.9',
      '8.8.8.8',
      '1.1.1.1',
      '9.255.255.255', // one below 10/8
      '11.0.0.1', // one above 10/8
      '100.63.255.255', // one below 100.64/10
      '100.128.0.1', // one above 100.64/10
      '126.255.255.255', // one below 127/8
      '128.0.0.1', // one above 127/8
      '169.253.0.1',
      '169.255.0.1',
      '172.15.255.255', // one below 172.16/12
      '172.32.0.1', // one above 172.16/12
      '192.167.255.255',
      '192.169.0.1',
      '2001:4860:4860::8888',
      '2606:4700::1111',
      '::ffff:8.8.8.8', // mapped PUBLIC IPv4 stays public
      'fb00::1', // one below fc00::/7
      'fe00::1', // one above fc00::/7
      'fec0::1', // one above fe80::/10
      'localhost.example.com', // a public name that merely starts with localhost
      'mylocal.example.com',
      '',
    ])('%s is NOT local or private (vacuity control for the matrix above)', (host) => {
      expect(isPrivateOrLocalHost(host)).toBe(false);
    });

    it('CRITICAL a non-address string is not classified by accident: garbage that looks like an IP is neither parsed as one nor warned about.', () => {
      expect(isPrivateOrLocalHost('127.0.0.256')).toBe(false);
      expect(isPrivateOrLocalHost('127.0.0')).toBe(false);
      expect(isPrivateOrLocalHost('::1::2')).toBe(false);
      expect(isPrivateOrLocalHost('fe80:::1')).toBe(false);
      expect(isPrivateOrLocalHost('1:2:3:4:5:6:7:8:9')).toBe(false);
    });
  });
});
