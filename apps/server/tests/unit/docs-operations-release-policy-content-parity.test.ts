// W552.C — drift guard for /docs/operations/release-policy.md.
// Locked release-policy split. Drift here either weakens the
// V-283-2026-05-07 founder-locked posture (would re-permit
// approving deploy-production in deploy.yml as the canonical
// production path), drops the staging-on-main vs production-on-
// tag split (would erode the deliberate-cut audit trail), or
// weakens the 4 tag-creation rules (no-retag + no-skip-versions
// + annotated-tags-only + tag-from-main-only).
//
//   • Locked at V-283 founder direction 2026-05-07.
//   • Staging: deploy.yml on push-to-main (continuous delivery).
//   • Production: server-deploy.yml on `server-v*` tag +
//     workflow_dispatch (explicit release).
//   • deploy-production in deploy.yml is legacy backstop only.
//   • SemVer for server-v tags: patch / minor / major.
//   • 4 tag rules: no-retag + no-skip-versions + annotated-only +
//     tag-from-main-only.
//   • 3 revision triggers: founder direction + production-cut-
//     friction + material CI/deployment-stack change.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/operations/release-policy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W552.C /docs/operations/release-policy.md content parity', () => {
  const body = read(LIB);

  it("Header + V-283-locked framing pinned: '# Driftstack release policy' + 'Canonical policy for which deploy workflow handles which environment. Locked per V-283 founder direction 2026-05-07.' + 'The repo has two server-side deploy workflows (V-278). Both exist on `main` and both will continue to exist; the policy is which to use per release, not which to delete.' — pinned so the canonical-policy + V-283-founder-2026-05-07-lock + V-278-two-workflows-both-stay commitment survives", () => {
    expect(body).toMatch(/^# Driftstack release policy$/m);
    expect(body).toMatch(
      /Canonical policy for which deploy workflow handles which environment\. Locked per V-283 founder direction 2026-05-07\./,
    );
    expect(body).toMatch(
      /The repo has two server-side deploy workflows \(V-278\)\. Both exist on `main` and both will continue to exist;/,
    );
    expect(body).toMatch(/the policy is which to use per release, not which to delete\./);
  });

  it('Staging-vs-production split framing pinned: deploy.yml on main + server-deploy.yml on server-v* + live staging origin + deliberate production tags', () => {
    expect(body).toMatch(
      /\|\s*Staging\s*\|\s*`\.github\/workflows\/deploy\.yml`\s*\|\s*push to `main`\s*\|\s*Continuous delivery \(auto\)/,
    );
    expect(body).toMatch(
      /\|\s*Production\s*\|\s*`\.github\/workflows\/server-deploy\.yml`\s*\|\s*tag matching `server-v\*` \+ workflow_dispatch\s*\|\s*Explicit release \(deliberate\)/,
    );
    expect(body).toMatch(
      /- \*\*Staging on main\*\*: every commit to main is a candidate to live on `staging\.driftstack\.dev`\./,
    );
    expect(body).toMatch(
      /- \*\*Production on tag\*\*: production cuts are deliberate\. The founder reviews \+ tags `server-vX\.Y\.Z`;/,
    );
  });

  it("deploy-production legacy backstop framing pinned: '## What about the `deploy-production` job in `deploy.yml`?' + '`deploy.yml` has a legacy `deploy-production` job from before the V-283 policy lock.' + 'Per policy, this job is **not the canonical production path** — production cuts go through `server-deploy.yml` triggered on a `server-v*` tag.' + 'It should not be approved during normal operation.' + 'If you find yourself approving `deploy-production` in `deploy.yml` regularly, that's a signal the tag-pipeline isn't fitting the workflow — surface it for founder review, don't quietly normalize approving the legacy gate.' — pinned so the legacy-job-pre-V-283 + not-canonical-production-path + don't-quietly-normalize + surface-for-founder-review commitment survives", () => {
    expect(body).toMatch(/## What about the `deploy-production` job in `deploy\.yml`\?/);
    expect(body).toMatch(
      /`deploy\.yml` has a legacy `deploy-production` job from before the V-283 policy lock\./,
    );
    expect(body).toMatch(
      /Per policy, this job is \*\*not the canonical production path\*\* — production cuts go through `server-deploy\.yml` triggered on a `server-v\*` tag\./,
    );
    expect(body).toMatch(/It should not be approved during normal operation\./);
    expect(body).toMatch(
      /If you find yourself approving `deploy-production` in `deploy\.yml` regularly, that's a signal the tag-pipeline isn't fitting the workflow — surface it for founder review, don't quietly normalize approving the legacy gate\./,
    );
  });

  it("SemVer + 4-tag-rules framing pinned: '## Versioning the tags' + '`server-v` tags follow SemVer:' + '**Patch** (`server-v0.1.0` → `server-v0.1.1`): bugfix, internal refactor, no observable behaviour change.' + '**Minor** (`server-v0.1.x` → `server-v0.2.0`): additive API changes, new features, backwards-compatible.' + '**Major** (`server-v0.x.y` → `server-v1.0.0` and beyond): breaking API changes per ADR-NNN versioning policy.' + '## Tag-creation rules' + '**No retagging**: tags are immutable artefacts.' + '**No skipping versions**: `server-v0.1.0` → `server-v0.1.1` → `server-v0.1.2`.' + '**Annotated tags only**: `git tag -a server-vX.Y.Z -m \"Release X.Y.Z — <summary>\"`. Lightweight tags don't carry the message context.' + '**Tag from `main` only**: tags applied to off-main commits don't represent shipped state.' — pinned so the SemVer-patch/minor/major + ADR-NNN-versioning-policy + 4-tag-rules (no-retag + no-skip + annotated-only + main-only) commitment survives", () => {
    expect(body).toMatch(/## Versioning the tags/);
    expect(body).toMatch(/`server-v` tags follow SemVer:/);
    expect(body).toMatch(
      /- \*\*Patch\*\* \(`server-v0\.1\.0` → `server-v0\.1\.1`\): bugfix, internal refactor, no observable behaviour change\./,
    );
    expect(body).toMatch(
      /- \*\*Minor\*\* \(`server-v0\.1\.x` → `server-v0\.2\.0`\): additive API changes, new features, backwards-compatible\./,
    );
    expect(body).toMatch(
      /- \*\*Major\*\* \(`server-v0\.x\.y` → `server-v1\.0\.0` and beyond\): breaking API changes per ADR-NNN versioning policy\./,
    );
    expect(body).toMatch(/## Tag-creation rules/);
    expect(body).toMatch(/- \*\*No retagging\*\*: tags are immutable artefacts\./);
    expect(body).toMatch(
      /- \*\*No skipping versions\*\*: `server-v0\.1\.0` → `server-v0\.1\.1` → `server-v0\.1\.2`\./,
    );
    expect(body).toMatch(
      /- \*\*Annotated tags only\*\*: `git tag -a server-vX\.Y\.Z -m "Release X\.Y\.Z — <summary>"`\./,
    );
    expect(body).toMatch(/Lightweight tags don't carry the message context\./);
    expect(body).toMatch(
      /- \*\*Tag from `main` only\*\*: tags applied to off-main commits don't represent shipped state\./,
    );
  });

  it("Per-release decision tree + revision-triggers framing pinned: '## Per-release decision tree' + '**Is this a routine staging deploy after a main merge?** Nothing to do — `deploy.yml` already fired on push.' + '**Is this a production cut?**' + 'Tag: `git tag server-v0.X.Y && git push origin server-v0.X.Y`.' + '**Is this an emergency rollback to a non-tagged commit?**' + '## Policy review' + 'This policy is locked at V-283 founder direction 2026-05-07.' + 'Founder explicit direction to switch.' + 'Production-cut friction observed in practice' + 'Material change to the underlying CI / deployment stack' — pinned so the 3-step decision tree + V-283-policy-locked + 3-revision-trigger commitment survives", () => {
    expect(body).toMatch(/## Per-release decision tree/);
    expect(body).toMatch(
      /1\. \*\*Is this a routine staging deploy after a main merge\?\*\* Nothing to do — `deploy\.yml` already fired on push\./,
    );
    expect(body).toMatch(/2\. \*\*Is this a production cut\?\*\*/);
    expect(body).toMatch(/Tag: `git tag server-v0\.X\.Y && git push origin server-v0\.X\.Y`\./);
    expect(body).toMatch(
      /3\. \*\*Is this an emergency rollback to a non-tagged commit\?\*\* Two options:/,
    );
    expect(body).toMatch(/## Policy review/);
    expect(body).toMatch(/This policy is locked at V-283 founder direction 2026-05-07\./);
    expect(body).toMatch(/1\. Founder explicit direction to switch\./);
    expect(body).toMatch(/2\. Production-cut friction observed in practice/);
    expect(body).toMatch(/3\. Material change to the underlying CI \/ deployment stack/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
