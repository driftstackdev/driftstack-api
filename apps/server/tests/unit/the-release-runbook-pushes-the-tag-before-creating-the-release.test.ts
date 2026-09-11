// W-27 — the ORDER in the GUI release runbook is load-bearing, and it was wrong.
//
// ⛔ `gh release create <tag>` CREATES the tag when it does not already exist —
// through the GitHub REST API, as a LIGHTWEIGHT ref. Policy forbids lightweight
// release tags and the build refuses them, so a cut in that order fails AFTER the
// tag is published; a published tag cannot be replaced, so the version number is
// burnt and the next cut skips it.
//
// The runbook listed `gh release create` BEFORE `git push origin <tag>`. That is
// not a style nit — it is the instruction that produced every lightweight tag we
// have: gui-v0.1.3, gui-v0.1.13, gui-v0.1.14 and gui-v0.1.18, the last of which
// shipped no artifacts at all on 2026-09-07.
//
// ⛔ AND THE EXISTING GUARD CANNOT COVER IT. `.husky/pre-push` inspects refs being
// pushed; the API path never pushes, so the one check in place is blind to exactly
// the sequence the runbook prescribed. Its own header claimed to be "the last
// place it can be stopped" — false, and corrected alongside this test. Ordering is
// the only thing that closes the path, which is why prose alone was never enough
// and why this asserts the order rather than trusting the sentence.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const RUNBOOK = readFileSync(resolve(REPO, 'docs/runbooks/gui-release.md'), 'utf8');
const HOOK = readFileSync(resolve(REPO, '.husky/pre-push'), 'utf8');

describe('the release runbook pushes the tag before creating the release', () => {
  it('CRITICAL `git push origin <tag>` comes BEFORE `gh release create`', () => {
    const push = RUNBOOK.indexOf('git push origin gui-v');
    const create = RUNBOOK.indexOf('gh release create gui-v');
    // Control: both commands must actually be present, or an empty/renamed
    // runbook would satisfy the ordering assertion by having neither.
    expect(push, 'the runbook must show the tag push').toBeGreaterThan(-1);
    expect(create, 'the runbook must show the release create').toBeGreaterThan(-1);
    expect(
      push,
      'gh release create BEFORE the push is what makes a lightweight tag — the ' +
        'sequence that burnt gui-v0.1.18',
    ).toBeLessThan(create);
  });

  it('CRITICAL the tag command is annotated', () => {
    expect(RUNBOOK).toMatch(/git tag -a gui-v/);
    // A bare `git tag gui-v…` anywhere in the runbook is the defect in seed form.
    expect(/git tag (?!-a)gui-v/.test(RUNBOOK), 'no lightweight tag form').toBe(false);
  });

  it('CRITICAL the runbook explains WHY the order matters, naming the API path', () => {
    // Without the reason, the next person tidying the steps reorders them back:
    // the correct order looks arbitrary, and the failure is 15 minutes downstream.
    expect(RUNBOOK).toMatch(/lightweight/i);
    expect(RUNBOOK).toMatch(/REST API|through the GitHub/i);
  });

  it('CRITICAL the pre-push guard no longer claims to be the last line of defence', () => {
    // It cannot see the API path at all. A guard that overstates its own reach is
    // how the runbook kept its wrong order through a review that saw the guard.
    expect(HOOK).toMatch(/NOT THE LAST PLACE/i);
    expect(HOOK).toMatch(/gh release create/);
  });

  it('CRITICAL the bump step names the SCRIPT and all FOUR version carriers, including Cargo.lock. The runbook used to say "ALL THREE places" and omit the lock, which is how 0.1.45 shipped a release whose builds all failed at dependency resolution — and an asset-less release becomes the "latest" one the desktop updater reads its manifest from, so every installed client 404s until it is deleted. A runbook that lists three files trains the next person to do the blanket replace again', () => {
    expect(RUNBOOK).toContain('node scripts/bump-gui-version.mjs');
    expect(RUNBOOK).toContain('apps/gui-client/src-tauri/Cargo.lock');
    expect(RUNBOOK).toMatch(/FOUR files carry it/);
    // The instruction it replaced must not come back.
    expect(RUNBOOK).not.toMatch(/ALL THREE places/);
    // Recovery order: the release comes down FIRST, because that is what restores a
    // working "latest" for clients already installed.
    expect(RUNBOOK).toMatch(/gh release delete gui-vX --cleanup-tag --yes` FIRST/);
    expect(existsSync(resolve(REPO, 'scripts/bump-gui-version.mjs'))).toBe(true);
  });

  it('CRITICAL the release is created as a DRAFT and verified before it is trusted. An asset-less published release is "latest" for every installed updater (0.1.45); a draft is not. The build workflow publishes the draft on success (measured twice), so the manual publish is the fallback, after the asset + manifest check', () => {
    expect(RUNBOOK).toMatch(/gh release create gui-v[\d.]+ --draft/);
    expect(RUNBOOK).toMatch(/gh release view gui-v[\d.]+ --json assets,isDraft/);
    expect(RUNBOOK).toMatch(/gh release edit gui-v[\d.]+ --draft=false/);
    expect(RUNBOOK).toMatch(/Why a draft: an asset-less release is "latest"/);
    // The order still holds with the draft: push the tag, THEN create.
    const push = RUNBOOK.indexOf('git push origin gui-v');
    const create = RUNBOOK.indexOf('gh release create gui-v');
    expect(push).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(push);
  });

  it('VACUITY CONTROL — the fixtures are the real files and are non-trivial', () => {
    // Proves the arms above read the runbook and the hook rather than empty
    // strings, which would satisfy several of them by absence.
    expect(RUNBOOK.length).toBeGreaterThan(500);
    expect(HOOK.length).toBeGreaterThan(500);
    expect(HOOK).toContain('refs/tags/gui-v*');
  });
});
