// Cross-source pin for the OVPN "unresolvable external file reference" rule.
//
// TWO implementations enforce this rule — A3's Swift parse-time reject
// (harness ProxyChain VPNProxyConfig :: openvpnExternalFileReference) and this
// repo's TS upload-time reject (findUnresolvableOpenvpnFileReferences). They were
// built to one stated rule and reported to "agree by construction". They did not:
// a 2026-09-08 line-by-line diff found three divergences (tab separator + `--`
// prefix bypasses on the Swift side; case-insensitive matching on this side).
// Two implementations in two languages never agree by construction — they agree
// until they drift, and nothing was measuring it.
//
// THIS is the measurement. The shared fixture (canonical in
// driftstack/operations/contracts/openvpn-file-reference-fixtures.json, A3
// 031fcfae4) carries the rows + the rule PARAMETERS as data. Both suites read it;
// a drift on EITHER side reds BOTH. Add a row there, never only in one language's
// tests.
//
// We read the in-repo MIRROR (scripts/sync-ovpn-fixtures.mjs copies the canonical
// here) because driftstack-api's CI checks out this repo ALONE — a cross-repo
// path would resolve to nothing and read as a silent pass. The drift guard below
// closes the mirror-vs-canonical gap where both repos are present (the pre-push
// gate), and says so LOUDLY where they are not (isolated CI) rather than skipping.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findUnresolvableOpenvpnFileReferences,
  OPENVPN_INLINE_REQUIRED_DIRECTIVES,
} from '../src/openvpn-directives.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIRROR = resolve(here, 'fixtures/openvpn-file-reference-fixtures.json');
// Canonical in the sibling driftstack repo: present on the dev mac / combined
// pre-push gate (where pushes originate), absent in driftstack-api's isolated CI.
const CANON = resolve(
  here,
  '../../../../driftstack/operations/contracts/openvpn-file-reference-fixtures.json',
);

// The rows that encode MEASURED defects — floored BY NAME so the pin cannot be
// neutered by deleting the cases that make it load-bearing (A3's floor set;
// `crlf_config_must_still_split` over the happy-path `bare_ca` deliberately —
// floor the defect, not the case every impl passes by accident).
const REQUIRED_ROWS = [
  'tab_separated_reference_W3098',
  'double_dash_prefixed_reference_W3098',
  'crlf_config_must_still_split',
  'inline_block_wins_over_stray_file_line',
  'uppercase_inline_tag_does_not_satisfy_the_reference',
];

// A MISSING mirror throws HERE, at load — a loud failure, never a silent skip.
// (`npm run sync:ovpn-fixtures` regenerates it from the canonical.)
if (!existsSync(MIRROR)) {
  throw new Error(`OVPN contract mirror missing at ${MIRROR} — run: npm run sync:ovpn-fixtures`);
}
interface ContractCase {
  name: string;
  blob: string;
  expect: 'accept' | 'reject';
  directive?: string;
}
interface Contract {
  cases: ContractCase[];
  inline_required_directives: string[];
  case_sensitive: boolean;
  token_separators: string[];
  double_dash_strip_min_length: number;
}
const contract = JSON.parse(readFileSync(MIRROR, 'utf8')) as Contract;

describe('OVPN file-reference shared contract (cross-source pin with node 8a03a3929)', () => {
  it('FLOOR: at least 18 cases and every defect-encoding row present by name — a truncated or gutted fixture reds instead of passing on absence', () => {
    expect(Array.isArray(contract.cases)).toBe(true);
    expect(contract.cases.length).toBeGreaterThanOrEqual(18);
    const names = new Set(contract.cases.map((c) => c.name));
    for (const r of REQUIRED_ROWS) {
      expect(names.has(r), `required floor row missing: ${r}`).toBe(true);
    }
  });

  it('my implementation matches EVERY contract row (accept/reject + directive) — the measurement that replaces "agree by construction"', () => {
    for (const c of contract.cases) {
      const hits = findUnresolvableOpenvpnFileReferences(c.blob);
      const got = hits.length > 0 ? 'reject' : 'accept';
      expect(got, `row "${c.name}" expected ${c.expect}`).toBe(c.expect);
      if (c.expect === 'reject' && c.directive !== undefined) {
        expect(hits[0]?.directive, `row "${c.name}" directive`).toBe(c.directive);
      }
    }
  });

  it('the declared RULE PARAMETERS match my constants — so a drift in the rule itself (not just the examples) reds', () => {
    expect([...OPENVPN_INLINE_REQUIRED_DIRECTIVES].sort()).toEqual(
      [...contract.inline_required_directives].sort(),
    );
    expect(contract.case_sensitive).toBe(true);
    expect(contract.double_dash_strip_min_length).toBe(3);
    expect(contract.token_separators).toEqual([' ', '\t']);
    // ⚠️ HONEST LABELLING (measured 2026-09-08, A2+A3). The contract also declares
    // `comment_prefixes: ['#', ';']`, but no fixture exercises it and this block does
    // not assert it against a constant — on purpose. The comment guard is SUBSUMED by
    // token-equality: `# ca ca.crt` tokenises to ['#','ca','ca.crt'], so tokens[0] is
    // '#', never the directive 'ca', and the line is accepted with OR without the guard.
    // Proven by mutation: deleting the `startsWith('#')/startsWith(';')` branch from
    // findUnresolvableOpenvpnFileReferences leaves this whole suite GREEN (A3 measured
    // the same on the Swift parser). So the two `*_commented_reference_is_inert` rows
    // pin the accept-OUTCOME (a restructure that REJECTED a commented line would red
    // them) but pass via subsumption — they do NOT protect the `comment_prefixes`
    // parameter or the guard. Do not read "18 rows, all passing" as covering comment
    // handling. (Also: this block is not a full inventory of the rule — token-equality-
    // not-prefix is a real clause the parameter set does not declare.)
  });

  it('DRIFT GUARD: mirror equals the driftstack canonical BYTE-FOR-BYTE when the sibling repo is present; LOUD "unverified" (never a silent skip) when absent', () => {
    if (!existsSync(CANON)) {
      // The "could not look" state, kept DISTINCT from "looked and matched" — the
      // false-green shape (a check whose can't-run state reads as green) that bit
      // three gates elsewhere today. The primary row-match above still ran against
      // the committed mirror, so impl-vs-contract is enforced regardless; only the
      // mirror-vs-canonical drift check is skipped here, and it announces that.
      console.warn(
        `[OVPN-CONTRACT PARITY UNVERIFIED] sibling driftstack canonical not found at ${CANON}; ` +
          `mirror-vs-canonical byte-equality NOT checked this run (expected in driftstack-api isolated CI). ` +
          `Drift is caught at the pre-push gate where both repos are present.`,
      );
      return;
    }
    // Assert CONTENT, not presence: a guard that degrades to existsSync reports a
    // parity it is no longer measuring (A3, learned the hard way today).
    const mirrorBytes = readFileSync(MIRROR);
    const canonBytes = readFileSync(CANON);
    expect(
      mirrorBytes.equals(canonBytes),
      'mirror has drifted from the driftstack canonical — run: npm run sync:ovpn-fixtures',
    ).toBe(true);
  });
});
