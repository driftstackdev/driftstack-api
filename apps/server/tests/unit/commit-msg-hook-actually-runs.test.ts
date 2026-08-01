// The V-205 attribution hook must actually run, not merely exist.
//
// It did not. `core.hooksPath` is `.husky/_`, so git does not consult
// `.git/hooks/` at all — and `.git/hooks/commit-msg` is exactly where
// `scripts/install-git-hooks.sh` puts the canonical V-205 / V-211 hook. Husky's
// `.husky/_/commit-msg` shim delegates to `.husky/commit-msg`, which did not
// exist, so the shim did nothing and returned 0.
//
// Measured rather than argued: a message carrying
// `Co-Authored-By: Claude <noreply@anthropic.com>` was ACCEPTED (exit 0) by the
// hook git actually invokes, while the same message run through the canonical
// hook was rejected with the V-205 banner. Both CLAUDE.md and AGENTS.md state
// the hook enforces the attribution policy. It had been inert.
//
// Nothing caught it because the coverage was source-text parity, and it pinned
// the installer that copies hooks into `.git/hooks/` — describing the dead
// location as the enforcement mechanism. A pin on an installer cannot tell you
// git ever calls what it installed.
//
// The POSITIVE CONTROL below is not decoration. The first version of the
// delegation invoked the canonical hook directly; it is not marked executable,
// so it failed with "Permission denied", and because a commit-msg hook fails
// CLOSED that presented as every message being rejected — clean ones included.
// A guard that only checked "banned messages are rejected" would have called
// that a pass.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HUSKY_HOOK = resolve(REPO_ROOT, '.husky/commit-msg');
const CANONICAL = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');

/** Attribution forms V-205 forbids, each in the shape a tool actually emits. */
const BANNED_MESSAGES: [string, string][] = [
  ['a Claude co-author trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>'],
  ['a GPT co-author trailer', 'Co-Authored-By: ChatGPT <assistant@openai.example>'],
  ['a Copilot co-author trailer', 'Co-Authored-By: Copilot <copilot@github.example>'],
  ['the robot emoji marker', '\u{1F916} Generated with a code assistant'],
  ['a github noreply co-author', 'Co-Authored-By: Someone <noreply@github.com>'],
];

let dir: string;

/** Run the hook git delegates to, and return its exit status. */
function runHook(message: string): number {
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  return spawnSync('bash', [HUSKY_HOOK, file], { encoding: 'utf8' }).status ?? -1;
}

describe('the commit-msg attribution hook is reachable and enforcing', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-hook-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('POSITIVE CONTROL an ordinary commit message is accepted. A commit-msg hook fails closed, so a broken delegation rejects EVERYTHING and looks indistinguishable from strict enforcement — that is the exact state the first fix landed in.', () => {
    expect(
      runHook('chaos: an ordinary subject line\n\nA body with no attribution strings in it.\n'),
      'a clean message must commit',
    ).toBe(0);
  });

  it('CRITICAL the hook exists where git can reach it. `core.hooksPath` is `.husky/_`, whose shim delegates to `.husky/commit-msg`; the canonical hook was installed only into `.git/hooks/`, which git therefore never consulted.', () => {
    expect(existsSync(HUSKY_HOOK), '.husky/commit-msg must exist — the shim calls it').toBe(true);
    expect(existsSync(CANONICAL), 'the canonical hook it delegates to must exist').toBe(true);
  });

  it('CRITICAL the husky hook DELEGATES rather than carrying its own copy of the patterns. Two lists drift, and the one that stops matching is the one nobody is looking at.', () => {
    const hook = readFileSync(HUSKY_HOOK, 'utf8');
    expect(hook, 'delegates to the canonical hook').toMatch(/scripts\/git-hooks\/commit-msg/);
    expect(
      hook,
      'and does not restate the banned patterns — the canonical hook owns them',
    ).not.toMatch(/Co-Authored-By:\s*Claude/);
  });

  for (const [label, trailer] of BANNED_MESSAGES) {
    it(`CRITICAL ${label} is rejected. This is what the hook is for, and every one of these was accepted while it was unreachable.`, () => {
      expect(
        runHook(`feat: a subject line\n\n${trailer}\n`),
        `"${trailer}" must be refused`,
      ).not.toBe(0);
    });
  }
});
