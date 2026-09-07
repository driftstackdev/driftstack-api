// T-20 — the OpenVPN directive rejection has ONE source, and the server
// enforces through it.
//
// The set of script-executing directives (`up`, `down`, `route-up`, …,
// `script-security` 2+) used to be a Set literal inside
// apps/server/src/lib/webhook-target-guard.ts. That was fine while the server
// was the only reader. Then owner #6 pasted a commercial provider's .ovpn and
// was refused with a sentence that named no line, and the desktop client threw
// the sentence away — so the fix is for BOTH ends to name the same lines, which
// means both ends must read the same list. It moved to @driftstack/api-types.
//
// A shared module is only shared while every consumer actually consumes it.
// The failure this file refuses is the quiet one: somebody re-declares a local
// Set in the server lib ("just for the server's own check"), the two lists
// drift, and the client starts accepting what the server refuses. So beyond the
// behavioural arms, the server SOURCE is read as text: it must import the
// shared finder and must declare no directive set of its own.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DANGEROUS_OPENVPN_DIRECTIVES, findUnsupportedOpenvpnLines } from '@driftstack/api-types';
import {
  classifyUnsafeVpnTargets,
  unsupportedOpenvpnDirectiveDetail,
} from '../../src/lib/webhook-target-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '../../src/lib/webhook-target-guard.ts');
const source = readFileSync(GUARD, 'utf8');

/** Every `new Set([...])` literal in `text` that lists a directive from the shared set. */
function localDirectiveSets(text: string): string[] {
  const literals = [...text.matchAll(/new Set(?:<[^>]*>)?\(\s*\[[\s\S]*?\]\s*\)/g)].map(
    (m) => m[0],
  );
  const directives = [...DANGEROUS_OPENVPN_DIRECTIVES];
  return literals.filter((lit) => directives.some((d) => lit.includes(`'${d}'`)));
}

describe('T-20 the OpenVPN directive set has one source', () => {
  it('CONTROL the shared set is populated and the local-set detector fires on a planted copy. Without this, an empty set would make every membership arm below pass on nothing, and a detector that matched nothing would call any server file clean.', () => {
    expect(DANGEROUS_OPENVPN_DIRECTIVES.size).toBeGreaterThanOrEqual(14);
    expect(DANGEROUS_OPENVPN_DIRECTIVES.has('up')).toBe(true);
    const planted = "const COPY = new Set([\n  'up',\n  'down',\n  'route-up',\n]);";
    expect(localDirectiveSets(planted), 'a re-declared set must be detected').toHaveLength(1);
    expect(
      localDirectiveSets("const other = new Set(['localhost', 'ipv6']);"),
      'a Set of unrelated strings is not a directive set',
    ).toHaveLength(0);
  });

  it('CRITICAL the server lib imports the shared finder from @driftstack/api-types. This is the import the classifier is built on; without it the server is checking a list of its own.', () => {
    expect(source).toMatch(
      /^import \{[^}]*\bfindUnsupportedOpenvpnLines\b[^}]*\} from '@driftstack\/api-types';/m,
    );
    expect(source, 'the classifier delegates to the shared finder').toMatch(
      /return findUnsupportedOpenvpnLines\(configBlob\)\.length > 0;/,
    );
  });

  it('CRITICAL the server lib declares no directive set of its own. A second copy is the drift this file exists to refuse: the client would name lines against one list while the server refused against another.', () => {
    expect(localDirectiveSets(source)).toEqual([]);
    expect(source, 'the old constant must not come back under its old name').not.toMatch(
      /const DANGEROUS_OPENVPN_DIRECTIVES\b/,
    );
  });

  it('CRITICAL every directive in the SHARED set is refused by the server classifier, lower-cased and shouted. If the server consulted a narrower list of its own, the directive it lacked would pass here while the client flagged it.', () => {
    const missed = [...DANGEROUS_OPENVPN_DIRECTIVES].filter(
      (d) =>
        classifyUnsafeVpnTargets({ configBlob: `${d} /tmp/payload\n` }) !== 'unsafe-directive' ||
        classifyUnsafeVpnTargets({ configBlob: `  ${d.toUpperCase()}\t/tmp/payload\n` }) !==
          'unsafe-directive',
    );
    expect(missed).toEqual([]);
    // …and the level threshold is the shared one too: 2 refused, 1 not.
    expect(classifyUnsafeVpnTargets({ configBlob: 'script-security 2\n' })).toBe(
      'unsafe-directive',
    );
    expect(classifyUnsafeVpnTargets({ configBlob: 'script-security 1\n' })).toBeNull();
  });

  it('CRITICAL the 400 detail names the line the shared finder names, quoted, with the remedy. This is the sentence the desktop client now shows verbatim, so its shape is a contract with the launch dialog.', () => {
    const blob =
      'client\n# hooks\n\nremote vpn.example.com 1194\nup /etc/openvpn/update-resolv-conf\n';
    expect(findUnsupportedOpenvpnLines(blob)).toMatchObject([{ line: 5, directive: 'up' }]);
    expect(unsupportedOpenvpnDirectiveDetail(blob)).toBe(
      'Line 5: "up /etc/openvpn/update-resolv-conf" — Driftstack does not run scripts from ' +
        'VPN configs. Remove this line and try again.',
    );
  });

  it('T-20 further offending lines are listed by number — one for "Line N has", several for "Lines N, M have", and a long tail is counted rather than dumped — so one edit clears the file instead of one retry per line.', () => {
    expect(unsupportedOpenvpnDirectiveDetail('up /a\ndown /b\n')).toBe(
      'Line 1: "up /a" — Driftstack does not run scripts from VPN configs. Remove this line ' +
        'and try again. Line 2 has the same problem.',
    );
    expect(unsupportedOpenvpnDirectiveDetail('up /a\ndown /b\nscript-security 3\n')).toBe(
      'Line 1: "up /a" — Driftstack does not run scripts from VPN configs. Remove this line ' +
        'and try again. Lines 2, 3 have the same problem.',
    );
    const flood = Array.from({ length: 13 }, () => 'up /x').join('\n');
    expect(unsupportedOpenvpnDirectiveDetail(flood)).toBe(
      'Line 1: "up /x" — Driftstack does not run scripts from VPN configs. Remove this line ' +
        'and try again. Lines 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 2 more have the same problem.',
    );
  });

  it('T-20 a very long offending line is echoed truncated, never whole. The number is what the customer needs; a 4 KB `plugin` argument list in a problem detail is noise.', () => {
    const long = `plugin /x/evil.so ${'a'.repeat(300)}`;
    const detail = unsupportedOpenvpnDirectiveDetail(`${long}\n`);
    expect(detail).toMatch(/^Line 1: "plugin \/x\/evil\.so a+…" — /);
    expect(detail.length).toBeLessThan(long.length);
  });

  it('T-20 a config the finder passes still gets a sentence, not a throw — a refusal must never turn into a 500 because two checks disagreed.', () => {
    expect(unsupportedOpenvpnDirectiveDetail('client\nremote vpn.example.com 1194\n')).toMatch(
      /script-executing directive/,
    );
  });
});
