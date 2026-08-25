// W721 — AGENTS.md commit-policy + V-205/V-211 classifier parity.
// Forty-eighth in the cross-SDK drift-guard series (W649 + W675-
// W721).
//
// Pins TWO files as authoritative for the commit-attribution +
// anonymity policy:
//
//   AGENTS.md — the repo-level policy doc (founder anonymity +
//     git identity + attribution-trailer ban + customer-copy ban).
//
//   scripts/git-hooks/commit-msg — the V-527 classifier hook that
//     ENFORCES both policies at commit time. Two pattern arrays:
//     V-205 (attribution-trailer/robot-emoji/Generated-with footers)
//     and V-211 (founder/personal-name tokens).
//
// CRITICAL invariants:
//   1. AGENTS.md "DO NOT include any third-party tooling attribution
//      trailer" framing matches the V-205 classifier patterns.
//   2. AGENTS.md "DO NOT include personal founder name" framing
//      matches the V-211 personal-name token patterns.
//   3. The classifier is version-controlled (scripts/git-hooks/) +
//      installed per-clone via install-git-hooks.sh (NOT a Husky
//      hook that ships in node_modules).
//   4. V-211 patterns use a LEADING `[^[:alnum:]]` and a TRAILING
//      `[^[:alpha:]]` token boundary. Both still avoid biting
//      "foundered"/"foundation"/"Joeline" inside larger words —
//      that protection only needs to exclude LETTERS. Excluding
//      digits on the trailing side as well let a name followed
//      immediately by digits through, which is the form a real
//      address takes, so the guard missed the very shape it exists
//      to catch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const AGENTS = resolve(REPO_ROOT, 'AGENTS.md');
const HOOK = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');

describe('W721 AGENTS.md commit-policy + V-205/V-211 classifier parity', () => {
  it('AGENTS.md + commit-msg hook files exist at canonical paths', () => {
    expect(existsSync(AGENTS), `missing ${AGENTS}`).toBe(true);
    expect(existsSync(HOOK), `missing ${HOOK}`).toBe(true);
  });

  it('CRITICAL AGENTS.md "Founder anonymity policy" + "Attribution policy" + "Git identity policy" + "Customer-facing copy policy" 4 sections pinned. Drift to dropping any would silently widen the policy surface.', () => {
    const a = read(AGENTS);

    expect(a).toMatch(/## ⚠️ Founder anonymity policy/);
    expect(a).toMatch(/## ⚠️ Git identity policy/);
    expect(a).toMatch(/## ⚠️ Attribution policy/);
    expect(a).toMatch(/## ⚠️ Customer-facing copy policy/);
  });

  it('CRITICAL AGENTS.md attribution-trailer ban framing pinned — "DO NOT include any third-party tooling attribution trailer (any \'co-authored-by\'-style line naming external systems)". Matches V-205 classifier intent.', () => {
    const a = read(AGENTS);
    expect(a).toMatch(/DO NOT.{0,8}include any third-party tooling attribution trailer/);
    expect(a).toMatch(/any "co-authored-by"-style line naming external systems/);
    expect(a).toMatch(/DO NOT.{0,8}include any "Generated with …" footer or robot-emoji marker/);
  });

  it('CRITICAL AGENTS.md founder-anonymity ban framing pinned — "DO NOT include personal founder name". Matches V-211 classifier intent.', () => {
    const a = read(AGENTS);
    expect(a).toMatch(/DO NOT.{0,8}include personal founder name/);
    expect(a).toMatch(/All public-facing copy refers to "Driftstack" as the entity/);
    expect(a).toMatch(/never to a personal founder name/);
  });

  it('CRITICAL AGENTS.md Driftstack git identity pinned — `Driftstack <dev@driftstack.dev>`. The branded identity is what makes every commit author/email Driftstack-only.', () => {
    const a = read(AGENTS);
    expect(a).toMatch(/git config --local user\.name "Driftstack"/);
    expect(a).toMatch(/git config --local user\.email "dev@driftstack\.dev"/);
  });

  it('CRITICAL commit-msg hook V-527 header anchor pinned + V-205-CLEANUP.C + V-211 anchors referenced. Drift to dropping the anchor chain would lose the changelog provenance for the policy enforcement.', () => {
    const h = read(HOOK);
    expect(h).toMatch(/V-527 — commit-msg hook \(rejects attribution \+ anonymity leaks\)/);
    expect(h).toMatch(/V-205-CLEANUP\.C/);
    expect(h).toMatch(/V-211 anonymity-policy regex/);
  });

  it('CRITICAL commit-msg hook uses `set -euo pipefail` strict-mode. Drift to dropping would let undefined-variable errors or pipe-failures pass through, weakening the classifier reliability.', () => {
    const h = read(HOOK);
    expect(h).toMatch(/set -euo pipefail/);
  });

  it('CRITICAL V-205 REJECT_PATTERNS roster pinned — 9 attribution patterns covering Claude/anthropic/GPT/Copilot + robot-emoji + Generated-with + noreply@anthropic + noreply@github. Drift to dropping any pattern would let a tooling trailer slip past the classifier.', () => {
    const h = read(HOOK);

    const v205Patterns = [
      "'Co-Authored-By: Claude'",
      "'Co-Authored-By:.*claude'",
      "'Co-Authored-By:.*anthropic'",
      "'Co-Authored-By:.*GPT'",
      "'Co-Authored-By:.*Copilot'",
      "'🤖'",
      "'Generated with \\[Claude'",
      "'noreply@anthropic\\.com'",
      "'noreply@github\\.com'",
    ];

    for (const pat of v205Patterns) {
      expect(h, `V-205 pattern ${pat}`).toContain(pat);
    }
  });

  it('CRITICAL V-211 REJECT_PATTERNS roster pinned — 4 anonymity patterns covering [Ff]ounder + [Jj]oel + [Tt]heunissen + [Jj]oeltheunissen. Drift to dropping any pattern would let a founder/personal-name token leak into a commit.', () => {
    const h = read(HOOK);

    const v211Patterns = [
      "'(^|[^[:alnum:]])[Ff]ounder([^[:alpha:]]|$)'",
      "'(^|[^[:alnum:]])[Jj]oel([^[:alpha:]]|$)'",
      "'(^|[^[:alnum:]])[Tt]heunissen([^[:alpha:]]|$)'",
      "'(^|[^[:alnum:]])[Jj]oeltheunissen([^[:alpha:]]|$)'",
    ];

    for (const pat of v211Patterns) {
      expect(h, `V-211 pattern ${pat}`).toContain(pat);
    }
  });

  it('CRITICAL V-211 token-boundary framing pinned — `Match standalone tokens — avoid biting "foundered" / "foundation" / "Joeline" inside larger words`. The token-boundary semantic is what prevents false-positives on legitimate words like "founded".', () => {
    const h = read(HOOK);
    expect(h).toMatch(/Match standalone tokens — avoid biting/);
    expect(h).toMatch(/"foundered" \/ "foundation" \/ "Joeline" inside larger words/);
  });

  it('CRITICAL fail() function emits 4-line diagnostic — matched pattern + policy + fix instruction + line separators. The 4-line output is what gives developers the diagnostic chain to recover from a rejection. Drift to dropping any line would mislead the developer.', () => {
    const h = read(HOOK);

    expect(h).toMatch(/✗ commit-msg HOOK REJECTED: contains banned pattern/);
    expect(h).toMatch(/matched: \$pattern/);
    expect(h).toMatch(/policy: {2}\$policy/);
    expect(h).toMatch(/fix: {5}remove the offending line\(s\) from your commit/);
  });

  it('CRITICAL fail() exits with status 1 (rejection). Drift to exit 0 or different status would silently let banned patterns through (git treats only 0 as "accept").', () => {
    const h = read(HOOK);
    expect(h).toMatch(/exit 1/);
  });

  it('CRITICAL canonical-source framing — "version-controlled. Install per-clone with `scripts/install-git-hooks.sh` (copies this file to .git/hooks/)". The install-script pattern is what avoids Husky vendoring complexity; drift to using Husky would silently break the clone-time install.', () => {
    const h = read(HOOK);
    expect(h).toMatch(/Canonical source — version-controlled/);
    expect(h).toMatch(/Install per-clone with\s*#\s*`scripts\/install-git-hooks\.sh`/);
    expect(h).toMatch(/copies this file to \.git\/hooks\//);

    // install-git-hooks.sh exists.
    const installer = resolve(REPO_ROOT, 'scripts/install-git-hooks.sh');
    expect(existsSync(installer), `missing ${installer}`).toBe(true);
  });

  it('CRITICAL V-205 grep flag pinned — `-iqE` (case-insensitive + quiet + extended-regex). Drift to dropping `-i` would let "co-authored-by: Claude" slip past with different casing.', () => {
    const h = read(HOOK);
    expect(h).toMatch(/echo "\$MSG" \| grep -iqE "\$PATTERN"/);
  });

  it('CRITICAL V-211 grep flag pinned — `-qE` WITHOUT `-i`. The case-sensitive match is what prevents false-positives on legitimate words; V-205 needs case-insensitive (tooling vendors sometimes shift case), V-211 must be case-aware ("joel" lowercase could appear in code like a variable name we want to allow).', () => {
    const h = read(HOOK);
    expect(h).toMatch(/echo "\$MSG" \| grep -qE "\$PATTERN"/);
    // 2 grep commands; V-211 uses -qE without -i.
    const greps = h.match(/echo "\$MSG" \| grep -[iq]+E/g) ?? [];
    expect(greps.length, '2 grep calls (V-205 -iqE + V-211 -qE)').toBe(2);
  });

  it('CRITICAL classifier loops through both pattern arrays in order — V-205 then V-211. The order matters because V-205 patterns are more common (every AI tool default trailer); fail-fast on the first match.', () => {
    const h = read(HOOK);

    expect(h).toMatch(
      /for PATTERN in "\$\{REJECT_PATTERNS_V205\[@\]\}"; do\s*\n\s*if echo "\$MSG" \| grep -iqE "\$PATTERN"; then\s*\n\s*fail "\$PATTERN" "V-205 attribution/,
    );
    expect(h).toMatch(
      /for PATTERN in "\$\{REJECT_PATTERNS_V211\[@\]\}"; do\s*\n\s*if echo "\$MSG" \| grep -qE "\$PATTERN"; then\s*\n\s*fail "\$PATTERN" "V-211 anonymity/,
    );
  });

  it('CRITICAL MSG_FILE bash parameter expansion pinned — `${1:?commit-msg hook needs message file}`. The error-if-unset substitution is what fails loud when git invokes the hook without the message-file argument. Drift to bare $1 would let unset $MSG silently bypass classification.', () => {
    const h = read(HOOK);
    expect(h).toMatch(/MSG_FILE="\$\{1:\?commit-msg hook needs message file\}"/);
  });

  it("CRITICAL AGENTS.md 'override the default' framing pinned — \"If a tool's default appends an attribution trailer, override the default\". The wording shifts responsibility onto agent-driven workflows to disable trailer defaults at the source.", () => {
    const a = read(AGENTS);
    expect(a).toMatch(/If a tool's default appends an attribution trailer, override the default/);
    expect(a).toMatch(/Applies to every commit going forward without exception/);
  });

  it('AGENTS+hook 5-invariant cluster — AGENTS.md 4 policy sections + V-527 hook anchor + V-205 9-pattern + V-211 4-pattern + token-boundary framing + install-via-scripts/install-git-hooks.sh.', () => {
    const a = read(AGENTS);
    const h = read(HOOK);

    // AGENTS sections.
    expect(a).toMatch(/Founder anonymity policy/);
    expect(a).toMatch(/Attribution policy/);
    expect(a).toMatch(/Git identity policy/);
    expect(a).toMatch(/Customer-facing copy policy/);

    // Hook anchors + pattern counts.
    expect(h).toMatch(/V-527/);
    expect(h).toMatch(/V-205-CLEANUP\.C/);
    expect(h).toMatch(/V-211/);

    const v205Count = (h.match(/'Co-Authored-By/g) ?? []).length;
    expect(v205Count, 'V-205 Co-Authored-By patterns').toBeGreaterThanOrEqual(5);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/agents-md-commit-policy-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
