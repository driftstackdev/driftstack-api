// The commit policy — who a commit is attributed to, and what a commit message
// may not contain — is stated in the file that enforces it.
//
// These assertions used to read the policy from an untracked contributor-notes
// file, which a clean clone and CI do not have. They now read
// scripts/git-hooks/commit-msg, the hook every commit runs through
// (.husky/commit-msg delegates to it): its header states each policy, and its
// pattern lists and personal-name check enforce them. The pattern lists
// themselves are pinned by scripts-git-hooks-content-parity and exercised by
// commit-msg-hook-actually-runs; this file pins the POLICY STATEMENTS, so a
// rule cannot quietly lose its written form while its regex survives.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HOOK = readFileSync(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'), 'utf8');

/** The comment block at the top of the hook, before the first command. */
const HEADER = HOOK.slice(0, HOOK.indexOf('set -euo pipefail'));

describe('the commit policy is stated in the hook that enforces it', () => {
  it('CRITICAL the git identity policy: every commit is authored as `Driftstack <dev@driftstack.dev>`, set per clone with git config --local, never under a personal name or address', () => {
    expect(HEADER).toMatch(/Git identity policy: every commit is authored and committed as/);
    expect(HEADER).toMatch(/`Driftstack <dev@driftstack\.dev>`/);
    expect(HEADER).toMatch(/git config --local user\.name "Driftstack"/);
    expect(HEADER).toMatch(/git config --local user\.email "dev@driftstack\.dev"/);
    expect(HEADER).toMatch(/never under a personal name or address/);
  });

  it('CRITICAL the attribution policy: no third-party tooling trailer, no "Generated with" footer, no robot-emoji marker, no tool noreply address — and the hook rejects each of them', () => {
    expect(HEADER).toMatch(
      /V-205 attribution — Driftstack-only commit attribution\. ZERO third-\s*\n#\s+party tooling trailers, ZERO "Generated with" footers, ZERO robot\s*\n#\s+emoji markers, ZERO noreply@<tool>\.com addresses\./,
    );
    // The statement is backed by the list the hook actually applies.
    expect(HOOK).toMatch(/^REJECT_PATTERNS_V205=\($/m);
    expect(HOOK).toMatch(
      /fail "\$PATTERN" "V-205 attribution — Driftstack-only commit attribution"/,
    );
  });

  it('CRITICAL the anonymity policy: no founder framing and no personal name in a commit subject or body — and the hook applies both the founder pattern and the personal-name check', () => {
    expect(HEADER).toMatch(
      /V-211 anonymity\s+— ZERO founder framing, ZERO personal-name\s*\n#\s+references \(listed outside the repo, see scripts\/personal-names\.mjs\) in\s*\n#\s+commit subject or body\./,
    );
    expect(HOOK).toMatch(/^REJECT_PATTERNS_V211=\($/m);
    expect(HOOK).toMatch(/node "\$PERSONAL_NAMES" "\$MSG_FILE"/);
    expect(HOOK).toMatch(/V-211 anonymity — no founder\/personal-name in commits/);
  });

  it('the hook names the identity it protects in its opening description, so the attribution and anonymity rules read as one policy about that identity', () => {
    expect(HEADER).toMatch(/any commit attributed to Driftstack <dev@driftstack\.dev>\)\./);
  });
});
