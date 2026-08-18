// `proxy-validation-failed` carries a `reason` the SDKs are told to branch on.
// Three copies of that enum exist and none of them checked the others.
//
//   ProxyProbeReason                 services/proxy-connectivity-probe.ts — what
//                                    the probe classifies a failure as.
//   ProxyValidationFailedError       lib/errors.ts — what reaches the customer,
//                                    with a `human` sentence per member. Its own
//                                    comment says the enum exists "so an SDK can
//                                    branch".
//   the docs table                   apps/docs/src/pages/api/proxies.md — the
//                                    only place a customer can learn the values.
//
// The third copy did not exist until 2026-08-18. The enum had been contractual
// for months, the desktop client branched on it, and no customer-facing page
// named a single member — so an SDK caller receiving a 422 could read the prose
// `detail` or nothing. That is the failure this file is here to prevent
// recurring, and it is a drift that only ever appears in one direction: a fifth
// reason gets added where the failure is classified, and the page that teaches
// customers what to do about it is the one nobody remembers.
//
// So all three are DERIVED and compared as sets. Nothing here is hand-typed —
// a hand-written roster of the members would be a fourth copy with the same
// problem. The arms read the union declarations and the table rows.
//
// It deliberately does NOT pin the sentences. `detail` is prose and the docs say
// so; pinning it would freeze wording that is meant to be improved, and a pin on
// a paragraph proves nothing about the value the SDK switches on.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** Members of a TS string-literal union, given the text that follows its `=`. */
function unionMembers(declaration: string): string[] {
  const body = declaration.slice(declaration.indexOf('=') + 1);
  const end = body.indexOf(';');
  const list = end === -1 ? body : body.slice(0, end);
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

/** The `reason` column of the docs table, which is the customer-readable roster. */
function documentedReasons(markdown: string): string[] {
  const section = markdown.slice(markdown.indexOf('## Why a launch is refused'));
  const rows = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)];
  return rows.map((m) => m[1] as string).sort();
}

describe('a reason an SDK branches on must be documented', () => {
  it('CRITICAL every reason the probe can classify is one the error type can carry. These two unions are written out separately, three files apart, and the probe is the only thing that produces the value the error transports — a member in one and not the other is a value the customer receives that no branch of the error type was written for.', () => {
    const probe = /export type ProxyProbeReason =[^;]+;/.exec(
      read('apps/server/src/services/proxy-connectivity-probe.ts'),
    );
    expect(probe, 'ProxyProbeReason is gone or was reshaped').not.toBeNull();
    const errors = /reason:\s*'unreachable'[^;]+;/.exec(read('apps/server/src/lib/errors.ts'));
    expect(errors, 'ProxyValidationFailedError no longer declares a reason union').not.toBeNull();

    const fromProbe = unionMembers(probe?.[0] ?? '');
    const fromError = unionMembers(errors?.[0] ?? '');
    expect(
      fromProbe.length,
      'the probe union parsed as empty — the regex, not the code',
    ).toBeGreaterThan(0);
    expect(fromError, 'the probe and the error type disagree about the reason set').toEqual(
      fromProbe,
    );
  });

  it('CRITICAL every reason is documented, and nothing is documented that cannot occur. A customer cannot branch on a value they were never told exists, and a documented value that no code path emits is worse than an omission — they would write a branch that never runs and trust it.', () => {
    const probe = /export type ProxyProbeReason =[^;]+;/.exec(
      read('apps/server/src/services/proxy-connectivity-probe.ts'),
    );
    const fromProbe = unionMembers(probe?.[0] ?? '');
    const documented = documentedReasons(read('apps/docs/src/pages/api/proxies.md'));

    expect(
      documented.length,
      'the docs table parsed as empty — either the section was renamed or the table shape changed',
    ).toBeGreaterThan(0);
    expect(
      documented,
      'the documented reason set and the emitted reason set have drifted apart',
    ).toEqual(fromProbe);
  });

  it('CRITICAL the docs say a refused launch creates nothing. The gate runs BEFORE the session row exists, so a 422 costs the customer nothing — that is the difference between "your proxy is broken" and "you were charged for a session that never opened", and it is the first thing someone reads the page to find out.', () => {
    const md = read('apps/docs/src/pages/api/proxies.md');
    const section = md.slice(md.indexOf('## Why a launch is refused'));
    expect(section, 'the page must state that no session is created').toMatch(
      /no session is created and\s*\n?\s*nothing is billed/,
    );
  });

  it('CRITICAL the Test endpoint is not described as reachability-only. It ran a TCP probe until 2026-08-18 and now runs the launch gate’s own probe for socks5; the page said "SOCKS5 authentication is not exercised by the probe", which inverted the meaning of a red result. A proxy that authenticates and cannot route is the case customers actually hit, and the old text told them it was untested.', () => {
    const md = read('apps/docs/src/pages/api/proxies.md');
    expect(md, 'the superseded reachability-only claim is back').not.toMatch(
      /SOCKS5 authentication is not\s*\n?\s*exercised/,
    );
    const section = md.slice(md.indexOf('## Test a proxy'), md.indexOf('## Route a session'));
    expect(section, 'the page must say the test runs the launch check for socks5').toMatch(
      /same check the launch gate runs/,
    );
    expect(
      section,
      'and must keep naming the two fallbacks, or a VPN wire’s weaker result reads as the full check',
    ).toMatch(/openvpn.*wireguard|wireguard.*openvpn/s);
  });
});
