// W541.B — drift guard for /.github/workflows/dependabot-auto-merge.yml.
// V-148 patch-only Dependabot auto-merge. Drift here either widens
// the auto-merge scope beyond patch (would auto-merge a minor that
// introduces subtle behaviour changes), drops the branch-protection
// reliance (would let unreviewed Dependabot PRs land before CI
// completes), or weakens the actor check (would let a malicious actor
// pretend to be dependabot[bot] and auto-merge anything).
//
//   • V-148 anchor + patch-only-auto-merge rationale.
//   • Workflow-not-Dependabot-builtin rationale (cleaner state
//     machine, avoids "merged on green" confusion).
//   • Activation prereq: gh CLI auth via GITHUB_TOKEN + Repo
//     settings "Allow auto-merge" enabled.
//   • on: pull_request: types [opened, synchronize, reopened].
//   • permissions: contents:write + pull-requests:write.
//   • if: github.actor == 'dependabot[bot]' actor-check.
//   • dependabot/fetch-metadata@v2.
//   • Approve + auto-merge for semver-patch.
//   • Comment-only for minor / major bumps.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/dependabot-auto-merge.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W541.B /.github/workflows/dependabot-auto-merge.yml content parity', () => {
  const body = read(LIB);

  it("V-148 anchor + patch-only-rationale framing pinned: '# V-148 — Dependabot auto-merge for patch updates.' + 'Auto-approves + auto-merges Dependabot PRs that:' + 'Are PATCH version bumps (not minor / not major)' + 'Pass the existing CI suite (the workflow can't merge until checks pass; GitHub enforces branch protection)' + 'Why patch-only auto-merge:' + 'Patch bumps are by SemVer convention bug-fix only — low blast radius.' + 'Minor bumps occasionally introduce subtle behavior changes (Sentry SDK 8.x → 8.1.0 changed default sample rate semantics, etc.). Worth a human eye.' + 'Major bumps are always API-breaking; never auto-merge.' — pinned so the V-148 patch-only + bug-fix-low-blast-radius + Sentry-SDK-8.x-real-example + major-always-API-breaking-never-auto-merge commitment survives (drift to widening past patch would let a minor-bump with subtle behaviour change auto-merge)", () => {
    expect(body).toMatch(/# V-148 — Dependabot auto-merge for patch updates\./);
    expect(body).toMatch(/# Auto-approves \+ auto-merges Dependabot PRs that:/);
    expect(body).toMatch(/#\s+- Are PATCH version bumps \(not minor \/ not major\)/);
    expect(body).toMatch(
      /#\s+- Pass the existing CI suite \(the workflow can't merge until checks/,
    );
    expect(body).toMatch(/#\s+pass; GitHub enforces branch protection\)/);
    expect(body).toMatch(/# Why patch-only auto-merge:/);
    expect(body).toMatch(
      /#\s+- Patch bumps are by SemVer convention bug-fix only — low blast radius\./,
    );
    expect(body).toMatch(
      /#\s+- Minor bumps occasionally introduce subtle behavior changes \(Sentry/,
    );
    expect(body).toMatch(
      /#\s+SDK 8\.x → 8\.1\.0 changed default sample rate semantics, etc\.\)\. Worth a/,
    );
    expect(body).toMatch(/#\s+- Major bumps are always API-breaking; never auto-merge\./);
  });

  it("Workflow-not-Dependabot-builtin + activation-prereq framing pinned: '# Why a workflow + not Dependabot's built-in auto-merge:' + 'Dependabot's auto-merge config triggers AS SOON AS a PR is opened, before CI completes. Branch protection rules would block the merge, but the PR sits in a confusing \"merged on green\" state.' + 'The workflow approach reads the Dependabot metadata + waits for CI to pass + then enables GitHub's PR auto-merge feature, which is a cleaner state machine.' + 'Activation: requires `gh` CLI auth (provided automatically by the GitHub Actions environment via GITHUB_TOKEN with the right scopes).' + 'Repo settings → \"Allow auto-merge\" must be enabled' + 'if disabled the workflow logs a clear error and the PR stays open for manual review.' — pinned so the workflow-cleaner-state-machine + GITHUB_TOKEN-via-Actions-environment + Allow-auto-merge-repo-setting + graceful-failure-on-disabled commitment survives", () => {
    expect(body).toMatch(/# Why a workflow \+ not Dependabot's built-in auto-merge:/);
    expect(body).toMatch(
      /#\s+- Dependabot's auto-merge config triggers AS SOON AS a PR is opened,/,
    );
    expect(body).toMatch(
      /#\s+before CI completes\. Branch protection rules would block the merge,/,
    );
    expect(body).toMatch(/#\s+but the PR sits in a confusing "merged on green" state\./);
    expect(body).toMatch(/#\s+- The workflow approach reads the Dependabot metadata \+ waits for/);
    expect(body).toMatch(/#\s+CI to pass \+ then enables GitHub's PR auto-merge feature, which is/);
    expect(body).toMatch(/#\s+a cleaner state machine\./);
    expect(body).toMatch(/# Activation: requires `gh` CLI auth \(provided automatically by the/);
    expect(body).toMatch(/# GitHub Actions environment via GITHUB_TOKEN with the right scopes\)\./);
    expect(body).toMatch(/# Repo settings → "Allow auto-merge" must be enabled/);
    expect(body).toMatch(/# stays open for manual review\./);
  });

  it("Trigger + permissions framing pinned: 'name: Dependabot auto-merge' + 'on: pull_request: types: [opened, synchronize, reopened]' + 'permissions: contents: write + pull-requests: write' — pinned so the PR-trigger-on-3-events (opened + synchronize + reopened) + 2-permission-grant (contents-write + pull-requests-write — needed for gh pr review + gh pr merge --auto) commitment survives (drift to dropping pull-requests: write would break gh pr review --approve)", () => {
    expect(body).toMatch(/^name: Dependabot auto-merge$/m);
    expect(body).toMatch(
      /on:\s*\n\s*pull_request:\s*\n\s*types: \[opened, synchronize, reopened\]/,
    );
    expect(body).toMatch(/permissions:\s*\n\s*contents: write\s*\n\s*pull-requests: write/);
  });

  it("dependabot-actor-check + fetch-metadata framing pinned: 'if: github.actor == \\'dependabot[bot]\\'' + 'uses: dependabot/fetch-metadata@v2' + 'with: github-token: \\'${{ secrets.GITHUB_TOKEN }}\\'' — pinned so the dependabot-only-actor-gate + v2-metadata-fetch + GITHUB_TOKEN-secret commitment survives (drift to dropping the actor-check would let any PR trigger the auto-merge logic; drift to fetch-metadata@v1 would break against newer Dependabot metadata schemas)", () => {
    expect(body).toMatch(/if: github\.actor == 'dependabot\[bot\]'/);
    expect(body).toMatch(/uses: dependabot\/fetch-metadata@v2/);
    expect(body).toMatch(/github-token: '\$\{\{ secrets\.GITHUB_TOKEN \}\}'/);
  });

  it("semver-patch approve + auto-merge framing pinned: 'if: steps.metadata.outputs.update-type == \\'version-update:semver-patch\\'' (used twice — once for approve, once for enable-auto-merge) + 'gh pr review --approve \"$PR_URL\"' + 'gh pr merge --auto --squash \"$PR_URL\"' + env passthrough 'PR_URL: ${{ github.event.pull_request.html_url }} + GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}' — pinned so the semver-patch-conditional + approve-then-enable-auto-merge sequence + squash-merge (not merge-commit, not rebase) commitment survives (drift to --merge would clutter main with dependabot merge commits)", () => {
    expect(body).toMatch(
      /if: steps\.metadata\.outputs\.update-type == 'version-update:semver-patch'/,
    );
    expect(body).toMatch(/run: gh pr review --approve "\$PR_URL"/);
    expect(body).toMatch(/run: gh pr merge --auto --squash "\$PR_URL"/);
    expect(body).toMatch(/PR_URL: \$\{\{ github\.event\.pull_request\.html_url \}\}/);
    expect(body).toMatch(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  });

  it("Comment-on-minor/major framing pinned: 'if: steps.metadata.outputs.update-type != \\'version-update:semver-patch\\'' + 'gh pr comment \"$PR_URL\" --body \"Dependabot bump type: `${{ steps.metadata.outputs.update-type }}`. Auto-merge applies to patch bumps only — this needs manual review.\"' — pinned so the non-patch-gets-a-comment-not-an-approval + clear-manual-review-prompt commitment survives (drift to dropping this would leave minor/major PRs silent and confusing for reviewers)", () => {
    expect(body).toMatch(
      /if: steps\.metadata\.outputs\.update-type != 'version-update:semver-patch'/,
    );
    expect(body).toMatch(
      /gh pr comment "\$PR_URL" --body "Dependabot bump type: \\`\$\{\{ steps\.metadata\.outputs\.update-type \}\}\\`\. Auto-merge applies to patch bumps only — this needs manual review\."/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
