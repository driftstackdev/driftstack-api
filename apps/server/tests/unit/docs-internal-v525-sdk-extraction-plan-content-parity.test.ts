// W569.B — drift guard for /docs/internal/v525-sdk-extraction-plan.md.
// V-525 STAGED doc 2026-05-10 Wave-16. Drift here either changes the
// per-SDK target repo shape, drops the V-205 violator pre-extraction
// gate, or unsets the local-branches-only-tonight reversibility.
//
//   • V-525. STAGED. Branches materialized locally; no remote push.
//   • 3 target repos: driftstack-{typescript,python,go}-sdk.
//   • Mechanism: `git subtree split --prefix=packages/sdk-<lang>`.
//   • Wave-16 branches: TS=6980d36 (57), Py=2c9a9cb (50), Go=fdfb9cf (50).
//   • V-205 violators (`63a20c1`, `ef649a1`) gate Step-5 scrub.
//   • 5 anti-actions (no repo create + no remote push + no publish +
//     no private flip + no force-push scrub) — all tonight.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v525-sdk-extraction-plan.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W569.B /docs/internal/v525-sdk-extraction-plan.md content parity', () => {
  const body = read(LIB);

  it('Header + V-525-STAGED-Wave-16 + 5-purpose-list + target-repo-shape + per-SDK-target-table framing pinned', () => {
    expect(body).toMatch(/^# V-525 — SDK extraction plan \(standalone public repos\)$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-10/);
    expect(body).toMatch(/\*\*Wave:\*\* 16/);
    expect(body).toMatch(
      /\*\*Status:\*\* STAGED — branches materialized locally; no remote push yet\./,
    );
    expect(body).toMatch(/1\. The target shape of each new public SDK repo\./);
    expect(body).toMatch(/2\. The extraction mechanism \(`git subtree split` per SDK package\)\./);
    expect(body).toMatch(/3\. Post-extraction adjustments \(LICENSE, manifest, CI workflows\)\./);
    expect(body).toMatch(/4\. Publishing posture \(npm \/ PyPI \/ Go module registry\)\./);
    expect(body).toMatch(
      /5\. Trigger sequence \(driftstack-api private flip → push SDK branches → enable CI\)\./,
    );
    expect(body).toMatch(/## Target repo shape/);
    expect(body).toMatch(/Each of the 3 new repos has the same minimal layout\. No internal docs,/);
    expect(body).toMatch(/no V-NNN references, no AGENTS\.md, no infra\/, no apps\/, no docs\/\./);
    expect(body).toMatch(/driftstack-<lang>-sdk\//);
    expect(body).toMatch(/├── src\/\s+# SDK source \(was packages\/sdk-<lang>\/src\)/);
    expect(body).toMatch(/├── tests\/\s+# SDK tests \(was packages\/sdk-<lang>\/tests\)/);
    expect(body).toMatch(/├── examples\/\s+# SDK usage examples \(already present per-SDK\)/);
    expect(body).toMatch(/├── README\.md\s+# SDK README \(already publish-quality per-SDK\)/);
    expect(body).toMatch(/├── LICENSE\s+# MIT \(NEW — copied from repo root\)/);
    expect(body).toMatch(/├── CHANGELOG\.md\s+# Per-SDK changelog \(already present per-SDK\)/);
    expect(body).toMatch(/├── <manifest>\s+# package\.json \/ pyproject\.toml \/ go\.mod/);
    expect(body).toMatch(/├── ci\.yml\s+# typecheck \+ lint \+ test on PR \+ push/);
    expect(body).toMatch(/└── publish\.yml\s+# publish on tag push \(npm \/ PyPI \/ Go ref tag\)/);
    expect(body).toMatch(/## Per-SDK repo target/);
    expect(body).toMatch(
      /\| TS\s+\| `driftstackdev\/driftstack-typescript-sdk` \| `@driftstack\/sdk` \(npm\)\s+\| npmjs\.com\s+\| 0\.1\.6\s+\|/,
    );
    expect(body).toMatch(
      /\| Py\s+\| `driftstackdev\/driftstack-python-sdk`\s+\| `driftstack-sdk` \(PyPI\)\s+\| pypi\.org\s+\| 0\.1\.5\s+\|/,
    );
    expect(body).toMatch(
      /\| Go\s+\| `driftstackdev\/driftstack-go-sdk`\s+\| `github\.com\/driftstackdev\/driftstack-go-sdk` \| proxy\.golang\.org \(auto\) \| \(no tag yet\)\s+\|/,
    );
  });

  it('Per-SDK adjustments (TS + Py + Go) + extraction mechanism + V-205 violator warning framing pinned', () => {
    expect(body).toMatch(/### TypeScript SDK \(`@driftstack\/sdk`\)/);
    expect(body).toMatch(
      /1\. \*\*Add `LICENSE`\*\* — copy `LICENSE` from driftstack-api root \(MIT\)\./,
    );
    expect(body).toMatch(/2\. \*\*`package\.json`\*\* edits:/);
    expect(body).toMatch(
      /- `repository\.url` → `git\+https:\/\/github\.com\/driftstackdev\/driftstack-typescript-sdk\.git`/,
    );
    expect(body).toMatch(/- `repository\.directory` → remove \(it's now at root\)/);
    expect(body).toMatch(
      /- `dependencies\.@driftstack\/api-types`: currently `\^0\.1\.0` \(workspace package\)\. For standalone publication, either/,
    );
    expect(body).toMatch(
      /\(a\) inline the types \(bundle `@driftstack\/api-types` into `dist\/`\), or/,
    );
    expect(body).toMatch(
      /\(b\) publish `@driftstack\/api-types` to npm first and reference the published version\./,
    );
    expect(body).toMatch(/Recommended: \(a\) for SDK-publish simplicity/);
    expect(body).toMatch(
      /3\. \*\*Add `\.github\/workflows\/ci\.yml`\*\* — `npm install`, `npm run typecheck`, `npm test`, `npm run build`\./,
    );
    expect(body).toMatch(
      /4\. \*\*Add `\.github\/workflows\/publish\.yml`\*\* — on push of a tag matching `v\*\.\*\.\*`, publish to npm using `NPM_TOKEN` secret\./,
    );
    expect(body).toMatch(/### Python SDK \(`driftstack-sdk`\)/);
    expect(body).toMatch(/`pyproject\.toml` already declares `license = \{ text = "MIT" \}`\./);
    expect(body).toMatch(/2\. \*\*`pyproject\.toml`\*\* edits:/);
    expect(body).toMatch(
      /- `\[project\.urls\]` — point at the new repo \(`Repository = "https:\/\/github\.com\/driftstackdev\/driftstack-python-sdk"`\)\./,
    );
    expect(body).toMatch(
      /3\. \*\*Add `\.github\/workflows\/ci\.yml`\*\* — `pip install -e \.\[dev\]`, `pytest`, `ruff check`, `mypy`\./,
    );
    expect(body).toMatch(
      /4\. \*\*Add `\.github\/workflows\/publish\.yml`\*\* — on tag push, `python -m build` \+ `twine upload` with `PYPI_API_TOKEN`\./,
    );
    expect(body).toMatch(/### Go SDK \(`driftstack-go-sdk`\)/);
    expect(body).toMatch(/2\. \*\*`go\.mod`\*\* edits:/);
    expect(body).toMatch(
      /- `module github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go` → `module github\.com\/driftstackdev\/driftstack-go-sdk`/,
    );
    expect(body).toMatch(
      /3\. \*\*Add `\.github\/workflows\/ci\.yml`\*\* — `go build \.\/\.\.\.`, `go test \.\/\.\.\.`, `go vet \.\/\.\.\.`\./,
    );
    expect(body).toMatch(
      /4\. \*\*Publishing:\*\* Go modules publish via `git tag v0\.X\.Y` push to the public repo;/,
    );
    expect(body).toMatch(
      /`proxy\.golang\.org` indexes automatically\. No registry credentials needed\. No separate publish workflow required\./,
    );
    expect(body).toMatch(/## Extraction mechanism — `git subtree split`/);
    expect(body).toMatch(
      /`git subtree split --prefix=packages\/sdk-<lang> -b sdk-extract\/<lang>` rewrites/,
    );
    expect(body).toMatch(
      /the subdirectory's commit history into a standalone branch where the SDK/,
    );
    expect(body).toMatch(/files sit at the branch root\./);
    expect(body).toMatch(
      /- Each branch contains only commits that touched the SDK's `packages\/sdk-<lang>\/`/,
    );
    expect(body).toMatch(/subdirectory\./);
    expect(body).toMatch(
      /- File paths in those commits have the `packages\/sdk-<lang>\/` prefix stripped\./,
    );
    expect(body).toMatch(
      /- The branch's HEAD is a synthetic commit; its parent chain links only the/,
    );
    expect(body).toMatch(/SDK-touching commits in driftstack-api's history\./);
    expect(body).toMatch(/- ⚠️ Two historical commits in driftstack-api carry V-205 attribution/);
    expect(body).toMatch(/violators in their bodies \(`63a20c1`, `ef649a1`\)\./);
  });

  it('Script + Branch-refs + Trigger-sequence + Anti-actions + Reversibility framing pinned', () => {
    expect(body).toMatch(
      /`scripts\/extract-sdk-repos\.sh` \(NEW\) runs the 3 subtree splits and reports:/,
    );
    expect(body).toMatch(/- Source `packages\/sdk-<lang>` path/);
    expect(body).toMatch(/- Target branch ref/);
    expect(body).toMatch(/- HEAD SHA of the new branch/);
    expect(body).toMatch(/- Commit count in the branch/);
    expect(body).toMatch(
      /- Pre-extraction V-205 violator warning \(if commits in `63a20c1`\/`ef649a1`/,
    );
    expect(body).toMatch(/touched the SDK path\)/);
    expect(body).toMatch(
      /The script is idempotent: re-running deletes the old branch and re-splits\./,
    );
    expect(body).toMatch(/## Branch refs after Wave 16 extraction/);
    expect(body).toMatch(/\| TS\s+\| `sdk-extract\/typescript` \| `6980d36` \|\s+57 \|/);
    expect(body).toMatch(/\| Py\s+\| `sdk-extract\/python`\s+\| `2c9a9cb` \|\s+50 \|/);
    expect(body).toMatch(/\| Go\s+\| `sdk-extract\/go`\s+\| `fdfb9cf` \|\s+50 \|/);
    expect(body).toMatch(
      /Verified with `git ls-tree -r --name-only <branch>` — each branch's tree/,
    );
    expect(body).toMatch(
      /root contains the SDK files directly \(CHANGELOG\.md, README\.md, src\/, tests\/,/,
    );
    expect(body).toMatch(/examples\/, manifest\) with no `packages\/sdk-<lang>\/` prefix\./);
    expect(body).toMatch(/## Trigger sequence \(V-528 runbook references this\)/);
    expect(body).toMatch(/1\. Review V-524 audit \+ this plan \+ V-526 sanitization diff\./);
    expect(body).toMatch(
      /2\. Run `scripts\/extract-sdk-repos\.sh` again \(idempotent — already run/,
    );
    expect(body).toMatch(
      /tonight; re-running picks up any Wave 16-26 changes to the SDK source\)\./,
    );
    expect(body).toMatch(
      /3\. For each SDK: create the GitHub repo \(`gh repo create driftstackdev\/driftstack-<lang>-sdk --public \.\.\.`\)\./,
    );
    expect(body).toMatch(/4\. Push the local extraction branch to the new repo's `main`:/);
    expect(body).toMatch(
      /git push git@github\.com:driftstackdev\/driftstack-typescript-sdk\.git sdk-extract\/typescript:main/,
    );
    expect(body).toMatch(
      /5\. In the new repo, apply per-SDK post-extraction adjustments \(LICENSE,/,
    );
    expect(body).toMatch(/6\. Flip driftstack-api to private \(V-528 runbook step\)\./);
    expect(body).toMatch(/7\. After private flip, force-push the V-205 historical scrub on/);
    expect(body).toMatch(/driftstack-api \(now invisible to public\)\./);
    expect(body).toMatch(
      /8\. Enable the publish workflows; tag v0\.1\.x; let CI publish to registries\./,
    );
    expect(body).toMatch(/## Anti-actions \(do NOT do tonight\)/);
    expect(body).toMatch(
      /- Do NOT create the GitHub repos \(gated on the Driftstack team's manual review\)\./,
    );
    expect(body).toMatch(/- Do NOT push the extraction branches anywhere remote\./);
    expect(body).toMatch(/- Do NOT publish to npm \/ PyPI \/ Go\./);
    expect(body).toMatch(/- Do NOT flip driftstack-api private \(V-528 runbook step\)\./);
    expect(body).toMatch(/- Do NOT force-push V-205 scrub \(gated on private flip\)\./);
    expect(body).toMatch(/The branches sit locally tonight, audit-friendly, fully reversible\./);
    expect(body).toMatch(/## Reversibility/);
    expect(body).toMatch(/Every step in the overnight Track E staging is fully reversible:/);
    expect(body).toMatch(/- Branches can be deleted \(`git branch -D sdk-extract\/<lang>`\)\./);
    expect(body).toMatch(/- V-524 \/ V-525 \/ V-526 \/ V-528 docs can be deleted\./);
    expect(body).toMatch(
      /- The V-527 commit-msg hook can be removed \(`rm \.git\/hooks\/commit-msg`/,
    );
    expect(body).toMatch(
      /- The README sanitization \(V-535\) was a content edit; `git revert` works\./,
    );
    expect(body).toMatch(/The first irreversible step is the GitHub-private flip \(V-528\)\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
