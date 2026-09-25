# SDK release runbook

How to publish `@driftstack/sdk` (npm), `driftstack-sdk` (PyPI) and the Go module,
and the four facts that make the order load-bearing rather than a preference.

Three registries, three permanence rules, and one shared dependency. Read the
"why" sections before the first release you cut; after that the TL;DR is enough.

## TL;DR — cutting a release

```sh
# 0. DECIDE THE VERSIONS, and prove the claim the number makes. A MINOR says
#    "nothing was removed". Diff the PUBLISHED artifact against HEAD — not the
#    git history, which does not know what was actually published:
#      npm pack @driftstack/sdk@<last>          # then read dist/index.d.ts
#      pip download driftstack-sdk==<last> --no-deps
#      git archive packages/sdk-go/v<last> packages/sdk-go | tar x -C <dir>
#    Anything REMOVED or narrowed needs a migration note in the CHANGELOG,
#    pre-1.0 included. See docs/architecture/sdk-versioning.md.

# 1. Bump every place the version lives. Each SDK has its own set:
#      TS      packages/sdk-typescript/package.json   "version"
#              package-lock.json (repo root)          packages/sdk-typescript entry
#      Python  packages/sdk-python/pyproject.toml     [project] version
#              packages/sdk-python/src/driftstack/_version.py
#      Go      packages/sdk-go/version.go             const Version
#    Then the guards that pin those numbers, and the docs that recommend them:
#      apps/server/tests/unit/sdk-python-version-content-parity.test.ts
#      apps/server/tests/unit/sdk-go-version-content-parity.test.ts
#      docs/architecture/sdk-versioning.md  +  apps/docs/src/pages/sdk/versioning.md
#      the "SDK versions" lines in the guide + the three quickstarts
#    The docs guards DERIVE their numbers from the package metadata, so a bump
#    that misses a page is red — see "Why the docs read the version" below.

# 2. CHANGELOG: turn [Unreleased] into the dated version, grouped by what a
#    customer can now DO, and leave a fresh empty [Unreleased] on top.

# 3. Commit the bump ON ITS OWN, on main. One commit per SDK, named for it
#    (docs/architecture/sdk-versioning.md, "Release process" step 3).
git commit -m "sdk-typescript v0.2.0" packages/ apps/ docs/ package-lock.json

# 4. Gate, then push. The gate is the pre-push hook plus the suite:
npm run verify
git push origin main

# 5. WAIT FOR CI GREEN on that commit. Four jobs must pass:
#      Build, typecheck, lint, unit + integration tests
#      End-to-end (Playwright against real Postgres + Redis)
#      Python SDK (lint + tests)
#      Go SDK (vet + tests + examples build)
gh run watch <run-id> --exit-status

# 6. PUBLISH @driftstack/api-types FIRST if its surface grew. It publishes on
#    its own account, for people who install it directly — the TypeScript SDK
#    no longer depends on it in any way. See "Why api-types goes first".
#    ⛔ BUILD IT FIRST, AND BUILD THE PUBLISH SHAPE. api-types has no
#    prepublishOnly/prepack script, so `npm publish` uploads whatever `dist/`
#    happens to be on disk — a stale or absent one publishes a package that is
#    wrong in a way nothing here checks. `build:publish` runs the ordinary
#    build and then withholds what npm must not get: the unreleased pricing
#    module the workspace barrel re-exports, and the barrel's own re-export of
#    it. See "Why api-types is published in a different shape".
npm run build:publish -w packages/api-types
npm pack --dry-run -w packages/api-types   # dist/ present, fresh, no ai-* file
npm publish -w packages/api-types --access public \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
# ⛔ PUT THE WORKSPACE BACK before running anything else in this repo. Until
#    you do, every server import of the pricing module is broken on disk.
npm run build -w packages/api-types

# 7. TypeScript. The token goes on the command line, never into a file in the
#    repo. Check the file list first — `--dry-run` prints exactly what ships.
#    ⛔ `npm run build` is tsup AND scripts/sdk-typescript-harden-sourcemaps.mjs.
#    Running tsup alone publishes @driftstack/api-types' own TypeScript inside
#    dist/*.map, which is not customer-facing text.
cd packages/sdk-typescript && npm run build
node -e "require('./dist/index.cjs'); import('./dist/index.js')"   # BOTH entries load
npm pack --dry-run
npm publish --access public --//registry.npmjs.org/:_authToken="$NPM_TOKEN"

# 8. Python. TWINE_USERNAME is the literal string __token__; the API token is
#    the password, and both come from the environment, never from a .pypirc.
cd packages/sdk-python && rm -rf dist && python -m build
python -m twine check dist/*
TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_TOKEN" python -m twine upload dist/*

# 9. Go. An ANNOTATED tag, on the CI-GREEN commit, named for the subdirectory.
#    --no-verify is deliberate: see "Why the Go tag is pushed with --no-verify".
git tag -a packages/sdk-go/v0.3.0 <ci-green-sha> \
  -m "Driftstack Go SDK v0.3.0 — <what changed>"
git push --no-verify origin packages/sdk-go/v0.3.0

# 10. VERIFY FROM THE REGISTRIES, not from the working tree. See "Verify".
# 11. Write the GitHub release note. See "The release note". ⛔ Pass
#     `--latest=false` on EVERY SDK or api-types release: GitHub keeps one
#     "latest" pointer per repository, the desktop updater reads
#     `releases/latest/download/latest.json`, and a fresh SDK release silently
#     takes that pointer and 404s every desktop install's update check until
#     `gh release edit gui-v<current> --latest` puts it back. After any release
#     action, confirm `curl -sIL …/releases/latest` still redirects to the
#     current `gui-v*` tag.
```

## ⛔ Why api-types is published in a different shape

`packages/api-types/src/ai-credits.ts` is an unreleased rate card, markup and
per-plan allowances — 86 exports of a feature that is not live. The barrel
re-exports it and the server imports those names through the package, so inside
the workspace the barrel must carry them. npm must not: publishing them puts
unreleased pricing into a customer's autocomplete.

One `exports["."]` is read by both audiences, so the two shapes cannot be made
to differ by configuration alone. The publish build in step 6 makes the
difference: it runs the ordinary build, then drops the module's four
emitted files, the barrel's re-export of it, and `dist/.tsbuildinfo`. It writes
nothing until every check passes, so a refusal leaves the workspace usable.

It also REFUSES while any shipped file still names the feature in prose or in a
field name. It did, twice: first `dist/admin.d.ts` (a field documented in terms
of a month's credits, moved into the withheld module), then `dist/problem.d.ts`
(the feature's own problem type sitting in the shared roster, moved into its own
roster inside the withheld module). Both are closed and 0.2.0 published clean.
Run the publish build in step 6 to see the current list; a refusal names the
file and the line.

`files` withholds the module's own files unconditionally, which is why a
tarball packed WITHOUT this step is broken at import rather than quietly
carrying the rate card. That direction is chosen: a missing file is loud on the
first `import` and step 10's install-and-run catches it; a shipped rate card is
silent and permanent.

## ⛔ Why api-types goes first

**It is no longer the SDK's problem, and the reason it stopped being one is
worth the paragraph.** `@driftstack/sdk` used to depend on
`@driftstack/api-types` and re-export from it at runtime, which made the SDK on
npm only as good as the api-types a customer's install resolved.

**Measured on 2026-09-20, preparing 0.2.0.** The SDK built and its own tests
passed, because in the workspace `@driftstack/api-types` resolves to the local
build. Installed the way a customer installs it — the packed tarball into an
empty project — it did this:

```
$ node -e "import('@driftstack/sdk')"
SyntaxError: The requested module '@driftstack/api-types' does not provide an
export named 'ARCHETYPE_DEVICES_PER_TIER'
```

and `tsc` reported 166 errors naming 110 missing types. The package would have
been dead on arrival for every customer, and nothing in the repo would have
said so: api-types had grown from 117 exports to 667 while its version stayed
at `0.1.5`, the number already on npm.

A second measurement, the same day, found the other half of the same shape:

```
$ node -e "require('@driftstack/sdk')"
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in
node_modules/@driftstack/api-types/package.json
```

`dist/index.cjs` did `require("@driftstack/api-types")` five times, and
api-types is ESM-only — its exports map offers `types` and `import` and nothing
else. Every CommonJS consumer would have broken on upgrade, and giving
api-types a `"require"` entry would not have fixed it: that package is
`type: module`, so `require()` of it throws ERR_REQUIRE_ESM on the Node 18 and
20 the SDK still supports.

**Both are closed the same way: the SDK is hermetic.** It BUNDLES
`@driftstack/api-types` into `dist/index.js` and `dist/index.cjs`
(`packages/sdk-typescript/tsup.config.ts`, `noExternal`), and INLINES its
declarations into `dist/index.d.ts` and `dist/index.d.cts` (`dts: {
resolve: true }`). A customer resolves `zod` and nothing else. Neither the
version on npm nor the publish order can reach them.

What that leaves for this step:

1. **Publish api-types before the SDK whenever its surface has moved** — for
   the people who install `@driftstack/api-types` DIRECTLY. That is the whole
   of the ordering requirement now; it no longer protects the SDK, and a
   TypeScript SDK user does not need api-types installed at all.
2. **The SDK's dependency range must require the version it needs.** It is now
   `zod: ^3.24.0`, matching api-types' own range so npm resolves one copy. One
   shared zod is what keeps `err instanceof z.ZodError` true across a boundary
   between the SDK and a customer's own api-types.
3. **`sideEffects: false` on api-types is load-bearing for the SDK's tarball.**
   It is what lets the bundler drop the api-types modules the SDK does not use.
   Without it the first bundled build carried the unreleased pricing module
   into `dist/index.cjs`. Do not remove it to "be safe"; it is a true statement
   about a package of pure declarations, and removing it publishes a feature.

The check that catches all of this is step 7 of **Verify** — install the
tarball into an empty project, then `require()` it AND `import()` it. A
workspace build proves nothing here, because the workspace is exactly where the
stale dependency is invisible, and loading one module format proves nothing
about the other.

## ⛔ Why the Go tag is pushed with `--no-verify`

`.husky/pre-push` runs the full verify chain: typecheck, lint, format check,
the Python lint, the gofmt sweep, the suite. On a tag push that is both slow and
**wrong**: it runs against the WORKING TREE, which is whatever is checked out
now, not the commit the tag points at. A green result there is a statement about
your desk, and the thing being published is the tagged commit. CI already
certified that commit in step 5 — that is the evidence, and re-deriving a worse
version of it before the push is not a second opinion.

⚠️ **But `--no-verify` also skips the annotated-tag guard, and for this tag that
guard was never going to fire anyway.** The hook's tag check matches
`refs/tags/gui-v*` and `refs/tags/server-v*` only; `packages/sdk-go/v*` falls
through the `case` and is not inspected. So for the Go SDK the annotated-tag
requirement in `docs/operations/release-policy.md` rests on this runbook and
nothing else. Use `-a`, and check before you push:

```sh
git for-each-ref refs/tags/packages/sdk-go/v0.3.0 --format='%(objecttype)'
# tag     ← annotated, correct
# commit  ← LIGHTWEIGHT: delete and re-cut it BEFORE pushing
```

A published tag is not replaced (release policy), so this is the last moment
the mistake is free.

## ⛔ Why the tag must name the CI-green commit

`git tag -a <name>` with no commit argument tags `HEAD`, and `HEAD` moves. If
anything landed on main between step 5 and step 9 — a peer's commit, your own
follow-up — the Go module served to customers is not the tree CI certified, and
the tag cannot be moved afterwards. Name the sha explicitly:

```sh
git tag -a packages/sdk-go/v0.3.0 <ci-green-sha> -m "…"
```

Go module tags carry the subdirectory prefix (`packages/sdk-go/v<version>`, not
a bare `v<version>`): that is how the module proxy finds a module that is not at
the repo root. A tag without the prefix publishes nothing and burns the version.

## ⛔ Why the docs read the version rather than spelling it

Two content-parity guards required the string `^0.1.5` in the two versioning
documents. npm had been serving 0.1.6 for four months. Both guards were green
the whole time, because a literal in a guard is a statement about the day it was
written — so the drift was not merely tolerated, it was mandatory.

Those guards now derive the number from the package that decides it
(`apps/server/tests/unit/_helpers/sdk-versions.ts`), and so does the guard on
the guide's and quickstarts' "SDK versions" lines. The consequence for you: a
version bump that does not update the docs turns the suite red in step 4, before
anything is published. Do not "fix" that by editing the guard.

## ⛔ What cannot be undone

| Registry | Can a version be replaced? | What to do instead                                                                  |
| -------- | -------------------------- | ----------------------------------------------------------------------------------- |
| npm      | No.                        | Publish a PATCH. `npm deprecate` the bad version with a message that names the fix. |
| PyPI     | No.                        | Publish a PATCH. Yank the bad version only for a security-critical defect.          |
| Go proxy | No.                        | Tag the next PATCH. The proxy caches by module@version permanently.                 |

A version number, once published, is spent — even if the upload was wrong, even
if it was seconds ago. **Fix forward, always.** There is no sequence of commands
in this runbook that recovers a bad publish, and looking for one wastes the
minutes better spent on the patch.

Corollary for step 7 and step 8: the file list is checked with `--dry-run` /
`twine check` BEFORE the upload, because after the upload it is a fact.

## Verify — from the registries, not from the tree

Everything above proves what you built. These prove what a customer gets. Run
them in a scratch directory outside the repo.

```sh
# 1. npm says the version exists, and the tarball carries what it should:
npm view @driftstack/sdk version
npm view @driftstack/sdk dist-tags
npm pack @driftstack/sdk@<version> && tar tzf driftstack-sdk-<version>.tgz
#    Expect: dist/ (js, cjs, d.ts, d.cts, maps), README.md, CHANGELOG.md,
#    LICENSE, package.json. Nothing else — no tests, no src, no .env.

# 2. PyPI says the version exists, and the wheel carries what it should:
pip index versions driftstack-sdk
pip download driftstack-sdk==<version> --no-deps -d . && unzip -l driftstack_sdk-*.whl
#    Expect: driftstack/** including py.typed, and dist-info with the licence.

# 3. The Go proxy has the tag, and `go get` resolves it in a clean module:
curl -sS "https://proxy.golang.org/github.com/driftstackdev/driftstack-api/packages/sdk-go/@v/list"
mkdir gocheck && cd gocheck && go mod init check
GOFLAGS=-mod=mod go get github.com/driftstackdev/driftstack-api/packages/sdk-go@v<version>
grep sdk-go go.mod   # the version you just published, no `replace`

# 4. The install lines in the docs are the install lines that work:
npm install @driftstack/sdk        # in an empty project
pip install driftstack-sdk         # in a clean venv

# 5. BOTH TypeScript entry points load from the INSTALLED package, on every
#    Node major the engines field claims. One format loading says nothing
#    about the other: the ESM build's inner imports resolve under the
#    `import` condition, which is why a broken CJS entry survived four lanes.
for v in 18 20 22; do
  npx -y node@$v -e "require('@driftstack/sdk'); console.log('cjs ok')"
  npx -y node@$v --input-type=module -e "import('@driftstack/sdk').then(()=>console.log('esm ok'))"
done
#    And `node_modules` should contain @driftstack/sdk and zod. If
#    @driftstack/api-types is in there, the SDK stopped bundling it.
```

Then the step that catches what the others cannot: **run the guide's programs
from the INSTALLED packages.** Copy the three complete examples out of
`apps/docs/src/pages/guides/run-ai-tasks-from-code.md` unchanged, point them at
a Driftstack account with the AI agent, and run them:

- TypeScript — `npx tsx run-invoice-task.ts`, after `npm install @driftstack/sdk`
  in an empty project with its own `package.json`. Typecheck it too
  (`tsc --noEmit`): the types are half of what ships, and a broken re-export
  shows up there before it shows up at runtime.
- Python — `python run_invoice_task.py` in a clean venv after
  `pip install driftstack-sdk`.
- Go — `go run .` in a scratch module with NO `replace` directive, so the
  module comes from the proxy.

A program that needs an edit to run is a documentation defect, and the guide is
what gets fixed. See
`apps/server/tests/integration/a-program-written-only-from-the-guide-runs-unchanged-against-the-server.test.ts`
for the same check run in CI against a stand-in.

## The release note

One GitHub release per SDK version, tagged and titled for that SDK
(`Driftstack TypeScript SDK 0.2.0`), created with `--latest=false` (see step
11: the repository's single "latest" pointer belongs to the desktop client's
update feed). The body is the CHANGELOG entry, copied, plus three things the
CHANGELOG does not carry:

1. **The install line, at this version.** `npm install @driftstack/sdk@0.2.0`.
   A reader arriving from a search result should not have to work it out.
2. **The migration, if anything broke.** What the old code looked like, what
   the new code looks like, a `sed` line when one is feasible, and any
   behavioural difference that is not a pure rename. Pre-1.0 does not excuse
   omitting it — see `docs/architecture/sdk-versioning.md`.
3. **What is NOT in this release.** A feature that landed in one SDK and not
   the others belongs here by name, so a customer on another language stops
   looking for it.

What stays out: internal identifiers, ticket numbers, and how the service is
built. The release note is customer-facing copy and is held to the same bar as
the docs pages.

## After the release

- The internal verification records — one entry naming the three versions, the
  CI-green sha, and the registry checks above that actually ran.
- If a customer is waiting on the release, tell them in the same session. The
  registry being updated is not the same event as the customer knowing.
