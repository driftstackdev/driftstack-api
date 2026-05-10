# V-525 — SDK extraction plan (standalone public repos)

**Date:** 2026-05-10
**Wave:** 16
**Status:** STAGED — branches materialized locally; no remote push yet.

## Purpose

Following the locked Track E architecture verdict (privatize driftstack-api +
extract 3 standalone public SDK repos), this plan defines:

1. The target shape of each new public SDK repo.
2. The extraction mechanism (`git subtree split` per SDK package).
3. Post-extraction adjustments (LICENSE, manifest, CI workflows).
4. Publishing posture (npm / PyPI / Go module registry).
5. Trigger sequence (driftstack-api private flip → push SDK branches → enable CI).

The actual GitHub remote operations are gated on the Driftstack team's
manual trigger tomorrow. This document describes what the trigger does;
the trigger itself is the V-528 runbook.

## Target repo shape

Each of the 3 new repos has the same minimal layout. No internal docs,
no V-NNN references, no AGENTS.md, no infra/, no apps/, no docs/.

```
driftstack-<lang>-sdk/
├── src/                       # SDK source (was packages/sdk-<lang>/src)
├── tests/                     # SDK tests (was packages/sdk-<lang>/tests)
├── examples/                  # SDK usage examples (already present per-SDK)
├── README.md                  # SDK README (already publish-quality per-SDK)
├── LICENSE                    # MIT (NEW — copied from repo root)
├── CHANGELOG.md               # Per-SDK changelog (already present per-SDK)
├── <manifest>                 # package.json / pyproject.toml / go.mod
└── .github/
    └── workflows/
        ├── ci.yml             # typecheck + lint + test on PR + push
        └── publish.yml        # publish on tag push (npm / PyPI / Go ref tag)
```

## Per-SDK repo target

| SDK | New repo name                             | Module/Package name                          | Registry                | Current version |
| --- | ----------------------------------------- | -------------------------------------------- | ----------------------- | --------------- |
| TS  | `driftstackdev/driftstack-typescript-sdk` | `@driftstack/sdk` (npm)                      | npmjs.com               | 0.1.6           |
| Py  | `driftstackdev/driftstack-python-sdk`     | `driftstack-sdk` (PyPI)                      | pypi.org                | 0.1.5           |
| Go  | `driftstackdev/driftstack-go-sdk`         | `github.com/driftstackdev/driftstack-go-sdk` | proxy.golang.org (auto) | (no tag yet)    |

## Post-extraction adjustments per SDK

These are the changes each SDK needs after extraction. Captured here so
the script (or the team) can apply them deterministically.

### TypeScript SDK (`@driftstack/sdk`)

1. **Add `LICENSE`** — copy `LICENSE` from driftstack-api root (MIT).
2. **`package.json`** edits:
   - `repository.url` → `git+https://github.com/driftstackdev/driftstack-typescript-sdk.git`
   - `repository.directory` → remove (it's now at root)
   - `dependencies.@driftstack/api-types`: currently `^0.1.0` (workspace package). For standalone publication, either
     (a) inline the types (bundle `@driftstack/api-types` into `dist/`), or
     (b) publish `@driftstack/api-types` to npm first and reference the published version.
     Recommended: (a) for SDK-publish simplicity — the types are pure
     interfaces, no runtime deps; bundling avoids a second public package.
3. **Add `.github/workflows/ci.yml`** — `npm install`, `npm run typecheck`, `npm test`, `npm run build`.
4. **Add `.github/workflows/publish.yml`** — on push of a tag matching `v*.*.*`, publish to npm using `NPM_TOKEN` secret.

### Python SDK (`driftstack-sdk`)

1. **Add `LICENSE`** — copy `LICENSE` from driftstack-api root (MIT). `pyproject.toml` already declares `license = { text = "MIT" }`.
2. **`pyproject.toml`** edits:
   - `[project.urls]` — point at the new repo (`Repository = "https://github.com/driftstackdev/driftstack-python-sdk"`).
3. **Add `.github/workflows/ci.yml`** — `pip install -e .[dev]`, `pytest`, `ruff check`, `mypy`.
4. **Add `.github/workflows/publish.yml`** — on tag push, `python -m build` + `twine upload` with `PYPI_API_TOKEN`.

### Go SDK (`driftstack-go-sdk`)

1. **Add `LICENSE`** — copy `LICENSE` from driftstack-api root (MIT).
2. **`go.mod`** edits:
   - `module github.com/driftstackdev/driftstack-api/packages/sdk-go` → `module github.com/driftstackdev/driftstack-go-sdk`. Every import inside the SDK that references the old module path needs updating (none currently — verified by `grep -r "driftstack-api/packages/sdk-go"` inside `packages/sdk-go/`; the SDK only imports stdlib + its own internal packages relative to module root, so the only change needed is `go.mod` itself).
3. **Add `.github/workflows/ci.yml`** — `go build ./...`, `go test ./...`, `go vet ./...`.
4. **Publishing:** Go modules publish via `git tag v0.X.Y` push to the public repo; `proxy.golang.org` indexes automatically. No registry credentials needed. No separate publish workflow required.

## Extraction mechanism — `git subtree split`

`git subtree split --prefix=packages/sdk-<lang> -b sdk-extract/<lang>` rewrites
the subdirectory's commit history into a standalone branch where the SDK
files sit at the branch root. The branch can be pushed verbatim to a fresh
remote and that remote becomes the new SDK repo.

History semantics:

- Each branch contains only commits that touched the SDK's `packages/sdk-<lang>/`
  subdirectory.
- File paths in those commits have the `packages/sdk-<lang>/` prefix stripped.
- The branch's HEAD is a synthetic commit; its parent chain links only the
  SDK-touching commits in driftstack-api's history.
- Co-authorship and historical authorship are preserved (commits stay
  attributed to `Driftstack <dev@driftstack.dev>` since the originals are
  already that identity).

History considerations:

- ⚠️ Two historical commits in driftstack-api carry V-205 attribution
  violators in their bodies (`63a20c1`, `ef649a1`). If `git subtree split`
  produces branches that include these commits AND those commits touched
  any of the SDK subdirs, the SDK branches inherit the violation. The
  V-205 force-push scrub (gated on V-528 privatization) MUST run against
  driftstack-api BEFORE the SDK extraction, OR the SDK branches must be
  inspected and rewritten before push.
- The script below makes this dependency explicit: it warns if HEAD's
  parent chain includes either offending SHA.

## Script

`scripts/extract-sdk-repos.sh` (NEW) runs the 3 subtree splits and reports:

- Source `packages/sdk-<lang>` path
- Target branch ref
- HEAD SHA of the new branch
- Commit count in the branch
- Pre-extraction V-205 violator warning (if commits in `63a20c1`/`ef649a1`
  touched the SDK path)

The script is idempotent: re-running deletes the old branch and re-splits.

## Branch refs after Wave 16 extraction

| SDK | Local branch             | HEAD SHA  | Commit count |
| --- | ------------------------ | --------- | -----------: |
| TS  | `sdk-extract/typescript` | `6980d36` |           57 |
| Py  | `sdk-extract/python`     | `2c9a9cb` |           50 |
| Go  | `sdk-extract/go`         | `fdfb9cf` |           50 |

Verified with `git ls-tree -r --name-only <branch>` — each branch's tree
root contains the SDK files directly (CHANGELOG.md, README.md, src/, tests/,
examples/, manifest) with no `packages/sdk-<lang>/` prefix.

## Trigger sequence (V-528 runbook references this)

The Driftstack team triggers this overnight-staged work tomorrow:

1. Review V-524 audit + this plan + V-526 sanitization diff.
2. Run `scripts/extract-sdk-repos.sh` again (idempotent — already run
   tonight; re-running picks up any Wave 16-26 changes to the SDK source).
3. For each SDK: create the GitHub repo (`gh repo create driftstackdev/driftstack-<lang>-sdk --public ...`).
4. Push the local extraction branch to the new repo's `main`:
   ```
   git push git@github.com:driftstackdev/driftstack-typescript-sdk.git sdk-extract/typescript:main
   ```
5. In the new repo, apply per-SDK post-extraction adjustments (LICENSE,
   manifest URLs, .github/workflows). These can be staged as a separate
   commit on the extract branch BEFORE push, OR landed as the first PR
   on the new repo.
6. Flip driftstack-api to private (V-528 runbook step).
7. After private flip, force-push the V-205 historical scrub on
   driftstack-api (now invisible to public).
8. Enable the publish workflows; tag v0.1.x; let CI publish to registries.

## Anti-actions (do NOT do tonight)

- Do NOT create the GitHub repos (gated on the Driftstack team's manual review).
- Do NOT push the extraction branches anywhere remote.
- Do NOT publish to npm / PyPI / Go.
- Do NOT flip driftstack-api private (V-528 runbook step).
- Do NOT force-push V-205 scrub (gated on private flip).

The branches sit locally tonight, audit-friendly, fully reversible.

## Reversibility

Every step in the overnight Track E staging is fully reversible:

- Branches can be deleted (`git branch -D sdk-extract/<lang>`).
- V-524 / V-525 / V-526 / V-528 docs can be deleted.
- The V-527 commit-msg hook can be removed (`rm .git/hooks/commit-msg`
  and `git rm scripts/git-hooks/ scripts/install-git-hooks.sh`).
- The README sanitization (V-535) was a content edit; `git revert` works.

The first irreversible step is the GitHub-private flip (V-528). The
Driftstack team triggers it manually after reviewing.
