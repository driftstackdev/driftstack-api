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
// hook was rejected with the V-205 banner. The contributor guidelines stated
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
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARY_WORD } from '../../../../scripts/personal-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HUSKY_HOOK = resolve(REPO_ROOT, '.husky/commit-msg');
const CANONICAL = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');

/**
 * Every pattern the canonical hook rejects, read from the hook itself.
 *
 * Hand-listing samples covered 8 of its 13 patterns. The five it missed
 * included ALL of the V-211 anonymity patterns — the rule keeping personal
 * names out of commit messages had no behavioural coverage whatsoever, so
 * deleting those lines from the hook would not have failed anything.
 *
 * The personal names themselves are no longer patterns in the hook: they live
 * in a list outside the repo, matched by scripts/personal-names.mjs, which the
 * hook runs. They are probed separately below — through the canary word that is
 * always on the list, and through made-up lists supplied the way CI supplies
 * the real one.
 *
 * Parsed rather than restated so the roster cannot fall behind: a pattern added
 * to the hook is exercised here without editing this file.
 */
function hookPatterns(): { group: string; pattern: string }[] {
  const hook = readFileSync(CANONICAL, 'utf8');
  const out: { group: string; pattern: string }[] = [];
  for (const group of ['REJECT_PATTERNS_V205', 'REJECT_PATTERNS_V211']) {
    const block = new RegExp(`${group}=\\(\\n([\\s\\S]*?)\\n\\)`).exec(hook);
    if (block === null) continue;
    for (const line of block[1]!.split('\n')) {
      const m = /^\s*'(.*)'\s*$/.exec(line);
      if (m) out.push({ group, pattern: m[1]! });
    }
  }
  return out;
}

/**
 * A message body the given hook pattern must reject, built FROM the pattern.
 *
 * Deriving the probe rather than writing it out keeps the forbidden words out
 * of this file entirely — they live in the hook — and means a new pattern
 * added there is probed automatically.
 */
function probeFor(pattern: string): string {
  // `(^|[^[:alnum:]])[Ff]ounder([^[:alpha:]]|$)` — a word with a case-either
  // first letter, delimited. Take the lowercase branch and pad it.
  const word = /^\(\^\|\[\^\[:alnum:\]\]\)\[(\w)(\w)\](\w+)\(\[\^\[:alpha:\]\]\|\$\)$/.exec(
    pattern,
  );
  if (word !== null) return `context ${word[2]!}${word[3]!} context`;
  // Otherwise a near-literal: unescape and fill any `.*` with something inert.
  return pattern.replace(/\\\[/g, '[').replace(/\\\./g, '.').replace(/\.\*/g, ' probe ');
}

/**
 * Digest of the hook's declared pattern list.
 *
 * Not a value to paste over when it fails: a change here means the rules
 * governing what may appear in a commit message moved, which is exactly the
 * moment someone should look at the diff.
 */
const PATTERN_DIGEST = '450ba0bf3c354e4a';

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
function runHook(message: string, env?: NodeJS.ProcessEnv): number {
  return runHookFull(message, env).status;
}

/** Run the hook with an explicit environment and keep what it printed. */
function runHookFull(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stderr: string; stdout: string } {
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  const run = spawnSync('bash', [HUSKY_HOOK, file], { encoding: 'utf8', env });
  return { status: run.status ?? -1, stderr: run.stderr ?? '', stdout: run.stdout ?? '' };
}

/** The environment minus any real list, so a test sees only what it supplies. */
function envWithoutList(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DRIFTSTACK_PERSONAL_NAMES;
  delete env.GITHUB_ACTIONS;
  env.DRIFTSTACK_PERSONAL_NAMES_FILE = join(dir, 'no-such-list.txt');
  return { ...env, ...extra };
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

  it('CRITICAL every pattern the hook declares is exercised, and the roster is read FROM the hook. Hand-listed samples covered 8 of 13 — the five missed included every V-211 anonymity pattern, so the rule keeping personal names out of commit messages could have been deleted from the hook without failing anything.', () => {
    const declared = hookPatterns();

    // EXACT counts, not a floor. Deriving the probe list from the hook makes
    // additions self-covering, but it also makes deletion invisible: a pattern
    // removed from the hook is simply no longer in `declared`, so probing
    // everything declared stays trivially green. Measured — deleting an
    // anonymity pattern left this file passing until these two lines existed.
    // Pinning the counts is what makes removal fail; the probes below are what
    // make presence mean something.
    const v205 = declared.filter((d) => d.group === 'REJECT_PATTERNS_V205');
    const v211 = declared.filter((d) => d.group === 'REJECT_PATTERNS_V211');
    expect(v205.length, 'V-205 attribution patterns declared by the hook').toBe(12);
    expect(v211.length, 'V-211 anonymity patterns declared by the hook').toBe(1);

    // And a digest, because an EDIT changes neither count: weakening a pattern
    // in place would still be probed, by the weakened pattern, and still pass.
    // If this fails, re-read the pattern list and update the constant
    // deliberately rather than pasting the new value.
    const digest = createHash('sha256')
      .update(declared.map((d) => `${d.group}|${d.pattern}`).join('\n'))
      .digest('hex')
      .slice(0, 16);
    expect(digest, 'the hook pattern list changed — review it, then update this digest').toBe(
      PATTERN_DIGEST,
    );

    const unenforced = declared.filter(
      ({ pattern }) => runHook(`feat: a subject\n\n${probeFor(pattern)}\n`) === 0,
    );
    expect(
      unenforced.map((d) => `${d.group}: ${d.pattern}`),
      'declared pattern(s) the hook did not actually reject',
    ).toEqual([]);
  });

  it('CRITICAL a personal name is rejected, and a longer word containing one is not. The names live in a list outside the repo so no guard spells them out; the canary word is always on that list and drives the real matcher end to end, so deleting the check from the hook, or the hook losing the matcher, fails here.', () => {
    const hook = readFileSync(CANONICAL, 'utf8');
    expect(hook, 'the hook runs the shared personal-name check').toMatch(
      /node "\$PERSONAL_NAMES" "\$MSG_FILE"/,
    );
    expect(runHook(`feat: a subject\n\nThanks to ${CANARY_WORD} for the review.\n`)).not.toBe(0);
    expect(runHook(`feat: a subject\n\nhandle: ${CANARY_WORD}89@example.com\n`)).not.toBe(0);
    expect(
      runHook(`feat: a subject\n\n${CANARY_WORD}ine is a different word.\n`),
      'a longer word containing a listed name is not that name',
    ).toBe(0);
  });

  it('CRITICAL the list is read from DRIFTSTACK_PERSONAL_NAMES (how CI supplies the secret) and from the file DRIFTSTACK_PERSONAL_NAMES_FILE names. Made-up entries — a word, a handle, an address — are each rejected whatever their case, and a message naming none of them is accepted.', () => {
    const entries = 'zorbulonix\nquendrav42\nqu.endrav@example.org';
    const viaEnv = envWithoutList({ DRIFTSTACK_PERSONAL_NAMES: entries });
    for (const probe of [
      'thanks Zorbulonix',
      'ping quendrav42 today',
      'mail QU.ENDRAV@example.org',
    ]) {
      expect(runHook(`feat: a subject\n\n${probe}\n`, viaEnv), probe).not.toBe(0);
    }
    expect(runHook('feat: a subject\n\nzorbulonixes are fine\n', viaEnv)).toBe(0);

    const listFile = join(dir, 'names.txt');
    writeFileSync(listFile, '# a comment line\n\nzorbulonix\n');
    const viaFile = envWithoutList({ DRIFTSTACK_PERSONAL_NAMES_FILE: listFile });
    expect(runHook('feat: a subject\n\nzorbulonix wrote this\n', viaFile)).not.toBe(0);
    expect(runHook('feat: a subject\n\nnobody wrote this\n', viaFile)).toBe(0);
  });

  it('CRITICAL with no list configured the hook still runs — the canary only — and says so on stderr instead of passing silently. A missing list is a coverage gap to report, not a reason to reject every commit or to wave names through unannounced.', () => {
    const run = runHookFull('feat: a subject\n\nno names here\n', envWithoutList());
    expect(run.status, 'a clean message still commits').toBe(0);
    expect(run.stderr).toMatch(/no personal-name list configured/);
    expect(runHook(`feat: a subject\n\n${CANARY_WORD}\n`, envWithoutList())).not.toBe(0);
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
