// W609 — drift guard for scripts/git-hooks/commit-msg + scripts/install-git-hooks.sh.
// V-527 — commit-msg hook canonical source + per-clone installer.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HOOK = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');
const INSTALL = resolve(REPO_ROOT, 'scripts/install-git-hooks.sh');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W609 scripts/git-hooks + install-git-hooks content parity', () => {
  it('commit-msg: V-527 framing + V-205 attribution rejection (Claude/anthropic/GPT/Copilot/robot-emoji/Generated-with-Claude/noreply tooling) + V-211 anonymity rejection (founder/Joel/Theunissen/Joeltheunissen standalone-token regex) + set -euo pipefail + fail-with-pattern+policy reporter pinned', () => {
    const body = read(HOOK);
    expect(body).toMatch(/^#!\/usr\/bin\/env bash$/m);
    expect(body).toMatch(
      /^# V-527 — commit-msg hook \(rejects attribution \+ anonymity leaks\)\./m,
    );
    expect(body).toMatch(
      /^# Extends the V-205-CLEANUP\.C pattern from driftstack \+ webkit-driftstack$/m,
    );
    expect(body).toMatch(
      /^# with V-211 anonymity-policy regex \(no founder \/ personal-name strings in$/m,
    );
    expect(body).toMatch(/^# any commit attributed to Driftstack <dev@driftstack\.dev>\)\.$/m);
    expect(body).toMatch(/^# Policies enforced:$/m);
    expect(body).toMatch(
      /^#\s+- V-205 attribution — Driftstack-only commit attribution\. ZERO third-$/m,
    );
    expect(body).toMatch(
      /^#\s+party tooling trailers, ZERO "Generated with" footers, ZERO robot$/m,
    );
    expect(body).toMatch(/^#\s+emoji markers, ZERO noreply@<tool>\.com addresses\.$/m);
    expect(body).toMatch(/^#\s+- V-211 anonymity\s+— ZERO founder framing, ZERO personal-name$/m);
    expect(body).toMatch(/^#\s+references \(currently: Joel, Joeltheunissen, Theunissen\) in$/m);
    expect(body).toMatch(/^#\s+commit subject or body\.$/m);
    expect(body).toMatch(/^# Canonical source — version-controlled\. Install per-clone with$/m);
    expect(body).toMatch(
      /^# `scripts\/install-git-hooks\.sh` \(copies this file to \.git\/hooks\/\)\.$/m,
    );
    expect(body).toMatch(/^set -euo pipefail$/m);
    expect(body).toMatch(/^MSG_FILE="\$\{1:\?commit-msg hook needs message file\}"$/m);
    expect(body).toMatch(/^MSG=\$\(cat "\$MSG_FILE"\)$/m);
    expect(body).toMatch(/^# V-205 attribution patterns \(case-insensitive\)\.$/m);
    expect(body).toMatch(/^REJECT_PATTERNS_V205=\($/m);
    expect(body).toMatch(/^\s+'Co-Authored-By: Claude'$/m);
    expect(body).toMatch(/^\s+'Co-Authored-By:\.\*claude'$/m);
    expect(body).toMatch(/^\s+'Co-Authored-By:\.\*anthropic'$/m);
    expect(body).toMatch(/^\s+'Co-Authored-By:\.\*GPT'$/m);
    expect(body).toMatch(/^\s+'Co-Authored-By:\.\*Copilot'$/m);
    expect(body).toMatch(/^\s+'🤖'$/m);
    expect(body).toMatch(/^\s+'Generated with \\\[Claude'$/m);
    expect(body).toMatch(/^\s+'noreply@anthropic\\\.com'$/m);
    expect(body).toMatch(/^\s+'noreply@github\\\.com'$/m);
    expect(body).toMatch(/^# V-211 anonymity patterns\. Match standalone tokens — avoid biting$/m);
    expect(body).toMatch(/^# "foundered" \/ "foundation" \/ "Joeline" inside larger words\.$/m);
    expect(body).toMatch(/^REJECT_PATTERNS_V211=\($/m);
    expect(body).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Ff\]ounder\(\[\^\[:alpha:\]\]\|\$\)'/);
    expect(body).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Jj\]oel\(\[\^\[:alpha:\]\]\|\$\)'/);
    expect(body).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Tt\]heunissen\(\[\^\[:alpha:\]\]\|\$\)'/);
    expect(body).toMatch(/'\(\^\|\[\^\[:alnum:\]\]\)\[Jj\]oeltheunissen\(\[\^\[:alpha:\]\]\|\$\)'/);
    expect(body).toMatch(/^fail\(\) \{$/m);
    expect(body).toMatch(/echo "✗ commit-msg HOOK REJECTED: contains banned pattern" >&2/);
    expect(body).toMatch(/grep -iqE "\$PATTERN"; then/);
    expect(body).toMatch(
      /fail "\$PATTERN" "V-205 attribution — Driftstack-only commit attribution"/,
    );
    expect(body).toMatch(
      /fail "\$PATTERN" "V-211 anonymity — no founder\/personal-name in commits"/,
    );
    expect(body).toMatch(/^exit 0$/m);
    expect(existsSync(HOOK)).toBe(true);
  });

  it('install-git-hooks.sh: V-527 + .git/hooks/ per-clone framing + git-rev-parse REPO_ROOT discovery + copy + chmod +x + idempotent overwrite + zero-hooks fallback + INSTALLED counter pinned', () => {
    const body = read(INSTALL);
    expect(body).toMatch(/^#!\/usr\/bin\/env bash$/m);
    expect(body).toMatch(/^# V-527 — install git hooks from canonical source\./m);
    expect(body).toMatch(
      /^# \.git\/hooks\/ is per-clone \(not tracked\)\. This script copies the$/m,
    );
    expect(body).toMatch(/^# canonical, version-controlled hooks from scripts\/git-hooks\/ into$/m);
    expect(body).toMatch(
      /^# the active clone's \.git\/hooks\/ directory and marks them executable\.$/m,
    );
    expect(body).toMatch(/^# Run once after cloning, and again whenever scripts\/git-hooks\/$/m);
    expect(body).toMatch(/^# changes\. Idempotent: overwrites existing hooks of the same name\.$/m);
    expect(body).toMatch(/^set -euo pipefail$/m);
    expect(body).toMatch(/^REPO_ROOT="\$\(git rev-parse --show-toplevel\)"$/m);
    expect(body).toMatch(/^SRC="\$REPO_ROOT\/scripts\/git-hooks"$/m);
    expect(body).toMatch(/^DST="\$REPO_ROOT\/\.git\/hooks"$/m);
    expect(body).toMatch(/echo "✗ destination dir not found: \$DST \(run from a git clone\)" >&2/);
    expect(body).toMatch(/^shopt -s nullglob$/m);
    expect(body).toMatch(/^INSTALLED=0$/m);
    expect(body).toMatch(/cp "\$HOOK" "\$DST\/\$NAME"/);
    expect(body).toMatch(/chmod \+x "\$DST\/\$NAME"/);
    expect(body).toMatch(/echo "✓ installed: \$NAME"/);
    expect(body).toMatch(/INSTALLED=\$\(\(INSTALLED \+ 1\)\)/);
    expect(body).toMatch(/echo "\(no hooks found in \$SRC\)"/);
    expect(body).toMatch(/echo "✓ \$INSTALLED hook\(s\) installed into \$DST"/);
    expect(existsSync(INSTALL)).toBe(true);
  });
});
