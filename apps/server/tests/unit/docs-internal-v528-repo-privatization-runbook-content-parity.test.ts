// W569.A — drift guard for /docs/internal/v528-repo-privatization-runbook.md.
// V-528 STAGED doc 2026-05-10 Wave-17. Drift here either re-orders the
// 7-step privatization sequence, drops the V-656 pre-stage fast path,
// or unsets the Step-4 irreversibility framing.
//
//   • V-528. STAGED. Manual trigger by Driftstack team tomorrow.
//   • 7 steps: LICENSE → adjust → 3-repos → flip-private →
//     V-205 scrub → redirect → SDK CI+publish.
//   • Pre-flight: V-656 fast path (~30s) OR manual legacy path.
//   • Step 4 is first irreversible step (private flip).
//   • Step 5 force-push gated on Step 4 being done.
//   • Estimated 30-40 min total with V-656 (down from 2-3 hours).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v528-repo-privatization-runbook.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W569.A /docs/internal/v528-repo-privatization-runbook.md content parity', () => {
  const body = read(LIB);

  it('Header + V-528-STAGED-Wave-17 + Do-NOT-execute-overnight + first-irreversible + V-656 pre-stage + manual-legacy framing pinned', () => {
    expect(body).toMatch(/^# V-528 — driftstack-api repo privatization runbook$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-10/);
    expect(body).toMatch(/\*\*Wave:\*\* 17/);
    expect(body).toMatch(
      /\*\*Status:\*\* STAGED — manual trigger by the Driftstack team tomorrow\. \*\*Do NOT/,
    );
    expect(body).toMatch(/execute overnight\.\*\*/);
    expect(body).toMatch(
      /Flip `driftstackdev\/driftstack-api` from public to private \+ push 3 standalone/,
    );
    expect(body).toMatch(/public SDK repos \+ redirect any external links\./);
    expect(body).toMatch(/The flip is the first \*\*irreversible\*\* Track E step\./);
    expect(body).toMatch(
      /After this runs, the public-repo posture has changed materially and a revert/,
    );
    expect(body).toMatch(
      /requires re-creating the public repo \+ force-pushing the original history\./,
    );
    expect(body).toMatch(/### Fast path \(V-656 pre-stage script — recommended\)/);
    expect(body).toMatch(/scripts\/v528-prestage\.sh/);
    expect(body).toMatch(/- Clean working tree/);
    expect(body).toMatch(/- On `main`/);
    expect(body).toMatch(
      /- `LICENSE` present \+ copied to `\/tmp\/driftstack-api-LICENSE` \(Step 1 input\)/,
    );
    expect(body).toMatch(/- `gh auth status` is good/);
    expect(body).toMatch(/- V-527 commit-msg hook installed/);
    expect(body).toMatch(
      /- All 3 `sdk-extract\/<lang>` branches exist \(re-runs extract idempotently\)/,
    );
    expect(body).toMatch(/- `cleanup\/v526-sanitize` state reported \(commits ahead\/behind\)/);
    expect(body).toMatch(/- V-205 violator commits audited \(`63a20c1`, `ef649a1`\)/);
    expect(body).toMatch(/- Per-SDK adjustment scripts present \+ executable/);
    expect(body).toMatch(/Exit 0 only when every check passes\. Total wall-clock ≈ 30s\./);
    expect(body).toMatch(/### Manual path \(legacy — kept for reference\)/);
  });

  it('Step 1-2-3 LICENSE + per-SDK adjustments + 3-repo creation framing pinned', () => {
    expect(body).toMatch(/### Step 1 — extract LICENSE to per-SDK branches/);
    expect(body).toMatch(/for LANG in typescript python go; do/);
    expect(body).toMatch(/git checkout "sdk-extract\/\$\{LANG\}"/);
    expect(body).toMatch(/cp \/tmp\/driftstack-api-LICENSE LICENSE/);
    expect(body).toMatch(/git commit -m "Add LICENSE \(MIT\)"/);
    expect(body).toMatch(/Per the V-527 commit-msg hook regex, these commit messages must contain/);
    expect(body).toMatch(
      /zero banned strings — `"Add LICENSE \(MIT\)"` passes \(verified by dry-run\)\./,
    );
    expect(body).toMatch(/### Step 2 — apply per-SDK adjustments \(V-525 design doc\)/);
    expect(body).toMatch(/V-656 pre-wrote three adjustment scripts that apply every V-525 change/);
    expect(body).toMatch(
      /git checkout sdk-extract\/typescript && scripts\/v528-adjust-typescript\.sh/,
    );
    expect(body).toMatch(/git checkout sdk-extract\/python\s+&& scripts\/v528-adjust-python\.sh/);
    expect(body).toMatch(/git checkout sdk-extract\/go\s+&& scripts\/v528-adjust-go\.sh/);
    expect(body).toMatch(/Each script is idempotent \(re-running on an already-adjusted branch/);
    expect(body).toMatch(/no-ops\) and refuses to run on the wrong branch\./);
    expect(body).toMatch(
      /- \*\*TS\*\* \(`scripts\/v528-adjust-typescript\.sh`\): adds LICENSE, rewrites/,
    );
    expect(body).toMatch(/`package\.json` repository\.url, drops the `@driftstack\/api-types`/);
    expect(body).toMatch(/dependency, copies api-types source into `src\/_generated\/`, rewrites/);
    expect(body).toMatch(
      /- \*\*Py\*\* \(`scripts\/v528-adjust-python\.sh`\): adds LICENSE, rewrites/,
    );
    expect(body).toMatch(/`pyproject\.toml` `\[project\.urls\]` Repository URL, adds CI workflow/);
    expect(body).toMatch(
      /\(Python 3\.10\/3\.11\/3\.12 matrix; ruff \+ mypy \+ pytest\), adds publish/,
    );
    expect(body).toMatch(/workflow \(`python -m build` \+ `twine upload` on tag\)\./);
    expect(body).toMatch(/- \*\*Go\*\* \(`scripts\/v528-adjust-go\.sh`\): adds LICENSE, rewrites/);
    expect(body).toMatch(/workflow \(Go 1\.21\/1\.22 matrix; vet \+ build \+ test\)\. No publish/);
    expect(body).toMatch(/workflow needed — Go modules publish via tag push\./);
    expect(body).toMatch(/### Step 3 — create 3 new GitHub repos \+ push branches/);
    expect(body).toMatch(/gh repo create driftstackdev\/driftstack-typescript-sdk --public/);
    expect(body).toMatch(/--description "Official TypeScript SDK for the Driftstack API"/);
    expect(body).toMatch(/--homepage "https:\/\/driftstack\.io"/);
    expect(body).toMatch(/gh repo create driftstackdev\/driftstack-python-sdk --public/);
    expect(body).toMatch(/--description "Official Python SDK for the Driftstack API"/);
    expect(body).toMatch(/gh repo create driftstackdev\/driftstack-go-sdk --public/);
    expect(body).toMatch(/--description "Official Go SDK for the Driftstack API"/);
  });

  it('Step 4-5-6-7 + Rollback + estimated-wall-clock + open-questions framing pinned', () => {
    expect(body).toMatch(/### Step 4 — flip driftstack-api private/);
    expect(body).toMatch(/gh repo edit driftstackdev\/driftstack-api --visibility private/);
    expect(body).toMatch(/--accept-visibility-change-consequences/);
    expect(body).toMatch(/- driftstack-api is private\. 911 files stop being public\./);
    expect(body).toMatch(
      /- Existing forks \(if any\) remain public; GitHub keeps forks even after the/,
    );
    expect(body).toMatch(
      /upstream goes private\. Audit forks via `gh api repos\/driftstackdev\/driftstack-api\/forks`\./,
    );
    expect(body).toMatch(/### Step 5 — run V-205 historical scrub \(NOW SAFE on private repo\)/);
    expect(body).toMatch(/The two V-205 violator commits \(`63a20c1`, `ef649a1`\) remain in/);
    expect(body).toMatch(/driftstack-api's history\. Now that the repo is private, the force-push/);
    expect(body).toMatch(/scrub is safe — no public-visible blast radius\./);
    expect(body).toMatch(/scripts\/v528-scrub-violators\.sh/);
    expect(body).toMatch(/scripts\/v528-scrub-violators\.sh --confirm/);
    expect(body).toMatch(/git push --force origin main/);
    expect(body).toMatch(/A pre-scrub backup bundle is created automatically at/);
    expect(body).toMatch(/`\/tmp\/pre-v528-scrub-<timestamp>\.bundle`/);
    expect(body).toMatch(/`git clone <bundle> <dir>` if the rewrite is wrong; delete the bundle/);
    expect(body).toMatch(/⚠️ \*\*Run Step 5 ONLY AFTER Step 3\*\*/);
    expect(body).toMatch(/### Step 6 — redirect external links/);
    expect(body).toMatch(
      /- npm package badges in marketing site \(if any\) — point at SDK repos\./,
    );
    expect(body).toMatch(
      /- "View source" links in docs\.driftstack\.io → SDK repos for SDK source,/,
    );
    expect(body).toMatch(/no link for control-plane source \(now private\)\./);
    expect(body).toMatch(/- Status page references — none expected\./);
    expect(body).toMatch(/### Step 7 — enable SDK CI \+ publish workflows/);
    expect(body).toMatch(/gh secret set NPM_TOKEN --repo driftstackdev\/driftstack-typescript-sdk/);
    expect(body).toMatch(
      /gh secret set PYPI_API_TOKEN --repo driftstackdev\/driftstack-python-sdk/,
    );
    expect(body).toMatch(/# Go publishes via tag push; no registry secret needed\./);
    expect(body).toMatch(/git tag v0\.1\.7 {2}# TS — bump from 0\.1\.6/);
    expect(body).toMatch(/git tag v0\.1\.6 {2}# Py — bump from 0\.1\.5/);
    expect(body).toMatch(/git tag v0\.1\.0 {2}# Go — first tagged release/);
    expect(body).toMatch(/## Rollback \(Step 4 onwards is hard-to-reverse\)/);
    expect(body).toMatch(/- \*\*Pre-Step-4 \(private flip not yet run\):\*\*/);
    expect(body).toMatch(
      /- \*\*Post-Step-4 \(private flip done\) but pre-publish:\*\* flip driftstack-api/,
    );
    expect(body).toMatch(/back to public \(`gh repo edit --visibility public`\)\./);
    expect(body).toMatch(/- \*\*Post-publish \(Step 7 tags pushed\):\*\* npm \/ PyPI versions are/);
    expect(body).toMatch(/immutable on those registries \(npm allows unpublishing within 24h \//);
    expect(body).toMatch(/72h depending on age \+ downloads; PyPI does not allow unpublishing\)\./);
    expect(body).toMatch(/## Estimated wall-clock time/);
    expect(body).toMatch(/- Pre-flight: 30 sec \(`scripts\/v528-prestage\.sh`\)/);
    expect(body).toMatch(/- Step 1 \(LICENSE staging\): handled by pre-stage script \(0 min\)/);
    expect(body).toMatch(
      /- Step 2 \(per-SDK adjustments\): 1-2 min per SDK via adjustment scripts/,
    );
    expect(body).toMatch(/- Step 3 \(repo creation \+ push\): 10 min/);
    expect(body).toMatch(/- Step 4 \(private flip\): 1 min/);
    expect(body).toMatch(/- Step 5 \(V-205 scrub \+ force push\): 5 min \(script-driven\)/);
    expect(body).toMatch(/- Step 6 \(external link redirect\): 15 min/);
    expect(body).toMatch(/- Step 7 \(CI secrets \+ first publish\): 30 min/);
    expect(body).toMatch(/Total: ~30-40 min for a careful run \(down from 2-3 hours pre-V-656\)\./);
    expect(body).toMatch(/## Open questions for the team/);
    expect(body).toMatch(
      /1\. Do we want NPM \/ PyPI publishes to be manual-tag or automated on every/,
    );
    expect(body).toMatch(/merge to `main` of each SDK repo\?/);
    expect(body).toMatch(
      /2\. Bundle `@driftstack\/api-types` into `@driftstack\/sdk` \(V-525 plan/,
    );
    expect(body).toMatch(/option a\) OR publish it as a separate npm package first \(option b\)\?/);
    expect(body).toMatch(/3\. Should the privatization announcement go anywhere external \(a blog/);
    expect(body).toMatch(/post, status-site banner, etc\.\) or is silent the right posture\?/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
