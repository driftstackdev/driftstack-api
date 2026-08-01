// A WireGuard config value must not be able to add a line to wg0.conf.
//
// `allowed_ips`, `address` and `dns` were the only fields in
// `WireGuardProxyConfigSchema` with no format check — length caps only, while
// `private_key`, `peer_public_key` and `endpoint` were each regex-validated.
//
// All three are written as the right-hand side of a `wg0.conf` line
// (`AllowedIPs = …`, `Address = …`, `DNS = …`). A value carrying a NEWLINE
// therefore appends a line to that file, and WireGuard's `PostUp`, `PreUp`,
// `PostDown` and `PreDown` directives run shell commands via `wg-quick`.
//
// Scope, stated plainly: the config is assembled outside this repository, so
// whether a newline actually reaches a generated file is not visible from here
// and is NOT claimed. What is claimed is narrower and sufficient — this package
// is the ingress boundary for customer input, every sibling field is already
// validated here, and these three were the exception. Making the injection
// impossible at the boundary does not depend on knowing what the consumer does
// with it.
//
// This is the WireGuard analogue of the OpenVPN directive rejection, which
// exists because a customer `config_blob` with `up /path/script` once ran as
// root on the egress host. WireGuard has no blob — the schema is structured,
// which is the better design — so the equivalent exposure is not a directive to
// reject but a newline to refuse.

import { describe, expect, it } from 'vitest';
import { WireGuardProxyConfigSchema } from '../src/egress.js';

const VALID = {
  private_key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0=',
  peer_public_key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0=',
  endpoint: 'vpn.example.com:51820',
};

const parse = (over: Record<string, unknown>) =>
  WireGuardProxyConfigSchema.safeParse({ ...VALID, ...over });

describe('WireGuard config values cannot inject a wg0.conf line', () => {
  it('POSITIVE CONTROL the ordinary config parses. Without this, a schema that rejected everything would satisfy every rejection case below and look like perfect security while breaking every customer.', () => {
    const ok = parse({ allowed_ips: '0.0.0.0/0', address: '10.7.0.2/32', dns: '1.1.1.1' });
    expect(ok.success, ok.success ? '' : JSON.stringify(ok.error.issues)).toBe(true);
  });

  it('POSITIVE CONTROL the realistic shapes all parse — multi-entry lists, IPv6, and the default. Being stricter than customers actually are is the failure mode that gets a validator reverted rather than fixed.', () => {
    for (const allowed_ips of [
      '0.0.0.0/0',
      '10.0.0.0/8, 192.168.0.0/16',
      '::/0',
      '0.0.0.0/0, ::/0',
    ]) {
      expect(parse({ allowed_ips }).success, `allowed_ips=${allowed_ips}`).toBe(true);
    }
    expect(parse({ dns: '2606:4700:4700::1111, 1.1.1.1' }).success, 'IPv6 + IPv4 DNS').toBe(true);
    // Omitted entirely — allowed_ips defaults, address and dns are optional.
    expect(parse({}).success, 'all three omitted').toBe(true);
  });

  it('CRITICAL allowed_ips carrying a newline is rejected. `AllowedIPs = 0.0.0.0/0\\nPostUp = …` is one line in wg0.conf and one shell command in wg-quick.', () => {
    expect(parse({ allowed_ips: '0.0.0.0/0\nPostUp = curl attacker' }).success).toBe(false);
  });

  it('CRITICAL a TRAILING newline alone is rejected too. This is the case the first draft of the pattern let through: `\\s` matches `\\n`, so `^\\s*…\\s*$` accepted it — and a value that may carry one newline may carry two.', () => {
    expect(parse({ allowed_ips: '0.0.0.0/0\n' }).success).toBe(false);
  });

  it('CRITICAL a newline BETWEEN list entries is rejected. A comma-separated list is the shape an author naturally allows whitespace around, which is exactly where a permissive \\s slips a line break in.', () => {
    expect(parse({ allowed_ips: '0.0.0.0/0,\n10.0.0.0/8' }).success).toBe(false);
    expect(parse({ allowed_ips: '0.0.0.0/0\n,10.0.0.0/8' }).success).toBe(false);
  });

  it('CRITICAL address and dns are held to the same rule, not just allowed_ips. All three land in wg0.conf, so guarding one and leaving the others is guarding none.', () => {
    expect(parse({ address: '10.7.0.2/32\nPostUp = x' }).success, 'address').toBe(false);
    expect(parse({ dns: '1.1.1.1\nPostUp = x' }).success, 'dns').toBe(false);
  });

  it('CRITICAL a value that is only a directive is rejected outright, and so is a comment-suffixed one. `0.0.0.0/0 ; PostUp = x` reads as a valid CIDR followed by an INI comment, which is the shape that survives a naive prefix check.', () => {
    expect(parse({ allowed_ips: 'PostUp = curl attacker' }).success).toBe(false);
    expect(parse({ allowed_ips: '0.0.0.0/0 ; PostUp = x' }).success).toBe(false);
  });

  it('allowed_ips still requires the CIDR suffix, so a bare address is refused rather than silently meaning /32.', () => {
    expect(parse({ allowed_ips: '0.0.0.0' }).success).toBe(false);
  });
});
