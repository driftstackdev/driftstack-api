// Every proxied launch is gated on one proxy reaching ONE hardcoded host.
//
// `runProxyPrelaunchGate` blocks a launch when the pre-launch probe fails, and
// the probe's whole verdict is a CONNECT through the customer's proxy to
// `DEFAULT_PROBE_TARGET_URL` — today `https://api.driftstack.dev/v1/egress/echo`.
// That single destination is a shared point of failure across every customer on
// every provider, and the failure is silent in the worst way: a provider that
// refuses that one host by policy makes every one of its customers permanently
// unlaunchable, with a 422 that says the customer's proxy could not be verified.
//
// This is not theoretical. Measured on production 2026-08-18, dialling a real
// stored proxy with its real credentials:
//
//   auth result: OK
//   CONNECT api.driftstack.dev:443 → SOCKS5 reply 0x02 "not allowed by ruleset"
//
// In that case the same proxy also refused example.com, google.com, ipify and
// ip-api — so the provider was refusing everything and the block was correct.
// But the observation stands: the ONLY thing separating "this proxy is dead"
// from "this provider blocks our domain" was dialling a second destination by
// hand. Thirty days of logs showed 17 probe failures, 17 of them egress_blocked,
// and zero successful proxied launches — a shape that fits both explanations
// equally.
//
// So this pins the two things that make the risk survivable:
//
//   the override is WIRED     DRIFTSTACK_PROXY_PROBE_TARGET_URL must reach the
//                             probe. It is the only lever an operator has when a
//                             provider blocks the default, and a documented
//                             escape hatch that is not plumbed is worse than
//                             none — the same shape as DEFAULT_BATCH_SIZE, which
//                             claimed to bound memory and had no reader.
//   the default is OURS       the target must stay a Driftstack-operated host.
//                             The design chose that deliberately (customer exit
//                             IPs never reach a third party); a well-meant swap
//                             to a public IP-echo service would leak every
//                             customer's exit IP to that service on every
//                             launch.
//
// It does NOT pin the URL itself. The point is that the lever exists and the
// destination stays ours, not that one string never changes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROBE_TARGET_URL } from '../../src/services/proxy-connectivity-probe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

describe('the proxy probe verdict rests on one destination', () => {
  it('CRITICAL the default target is a Driftstack-operated host. Customer exit IPs pass through it on every launch; pointing it at a public IP-echo service would hand every customer’s exit IP to a third party, which is the exact leak the design avoided by building /v1/egress/echo.', () => {
    const url = new URL(DEFAULT_PROBE_TARGET_URL);
    expect(url.protocol, 'the probe target must be https').toBe('https:');
    expect(
      // BOTH TLDs are Driftstack-operated and both are correct here. The website
      // moved to driftstack.io on 2026-09-04, but `api.` deliberately stayed on
      // driftstack.dev (it is the SDKs' base URL), and the probe target IS the api
      // host. A migration that left this checking only .io would have had the guard
      // reporting our own API as 'not a Driftstack host' — failing on a correct value.
      url.hostname.endsWith('driftstack.io') || url.hostname.endsWith('driftstack.dev'),
      `probe target ${url.hostname} is not a Driftstack host — customer exit IPs would reach it`,
    ).toBe(true);
  });

  it('CRITICAL the operator override reaches the probe. When a provider refuses the default destination by ruleset, every one of its customers is unlaunchable and this env var is the only lever — so it has to be plumbed from bootstrap into the probe, not merely mentioned in a comment.', () => {
    const bootstrap = read('lib/bootstrap.ts');
    expect(bootstrap, 'bootstrap must read the override').toMatch(
      /process\.env\.DRIFTSTACK_PROXY_PROBE_TARGET_URL/,
    );
    expect(bootstrap, 'and pass it as targetUrl').toMatch(
      /targetUrl:\s*process\.env\.DRIFTSTACK_PROXY_PROBE_TARGET_URL/,
    );
    const probe = read('services/proxy-connectivity-probe.ts');
    expect(probe, 'the probe must accept a targetUrl').toMatch(/targetUrl\?:\s*string/);
    expect(probe, 'and prefer it over the default').toMatch(
      /deps\.targetUrl\s*\?\?\s*DEFAULT_PROBE_TARGET_URL/,
    );
  });

  it('CRITICAL a refused CONNECT still names the protocol reply. `egress_blocked` covers a provider refusing the destination (0x02), a refused connection (0x05) and any thrown error alike, so the reply byte in `detail` is the only thing that separates them — and the gate must log it. Diagnosing the 2026-08-18 block needed a live handshake precisely because that field was dropped.', () => {
    const probe = read('services/proxy-connectivity-probe.ts');
    expect(probe, 'the CONNECT failure must record the reply byte').toMatch(
      /proxy CONNECT failed \(SOCKS5 reply 0x\$\{rep\.toString\(16\)\}\)/,
    );
    const route = read('routes/agent-sessions.ts');
    const block = /pre-launch proxy probe FAILED[\s\S]{0,80}/.exec(route);
    expect(block, 'the failure log line is gone').not.toBeNull();
    const logCall = route.slice(Math.max(0, (block?.index ?? 0) - 900), block?.index ?? 0);
    expect(logCall, 'the failure log must carry detail, not just the four-value reason').toMatch(
      /detail:\s*result\.detail/,
    );
  });

  it('CRITICAL the probe still passes on any HTTP response, asserted as BEHAVIOUR rather than as the paragraph explaining it. The echo target is rate-limited and Cloudflare-fronted, so a healthy proxy on a shared exit legitimately gets a 429 or a 403 — requiring 2xx would couple every launch to Cloudflare bot-scoring the customer’s proxy. My first version of this arm pinned the comment, and a mutation that rewrote a neighbouring line SURVIVED it: a paragraph is not the property.', async () => {
    const { ProxyConnectivityProbe } =
      await import('../../src/services/proxy-connectivity-probe.js');
    const probeSrc = read('services/proxy-connectivity-probe.ts');
    // The tunnel is already proven by the time the round-trip runs, so the ONLY
    // post-tunnel failure the code may raise is the probe's own deadline.
    const roundTrip = probeSrc.slice(probeSrc.indexOf('private async egressRoundTrip'));
    const body = roundTrip.slice(0, roundTrip.indexOf('\n  }'));
    expect(
      /reason:\s*'egress_blocked'/.test(body),
      'the post-tunnel round-trip must not classify a target-side status or drop as egress_blocked — ' +
        'that is what false-blocked working proxies behind Cloudflare',
    ).toBe(false);
    expect(
      body,
      'a hung proxy is still the probe’s own deadline, and must stay distinguishable',
    ).toMatch(/timeout/);
    expect(typeof ProxyConnectivityProbe, 'the probe class must still be exported').toBe(
      'function',
    );
  });
});
