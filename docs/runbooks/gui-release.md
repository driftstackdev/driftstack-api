# GUI release runbook

How to cut a Driftstack desktop client release, and the two org-level facts that make it
non-obvious.

## TL;DR — cutting a release

```sh
# 1. Bump the version. FOUR files carry it and they are guarded to agree:
#      apps/gui-client/package.json               "version"
#      apps/gui-client/src-tauri/tauri.conf.json  "version"  <- names the assets + latest.json
#      apps/gui-client/src-tauri/Cargo.toml       [package] version
#      apps/gui-client/src-tauri/Cargo.lock       the driftstack-gui [[package]] entry
#    Use the script. It edits each one by FIELD and validates the lock; see
#    "Why the bump is a script" below for the release this cost.
node scripts/bump-gui-version.mjs 0.1.1

# 2. Tag it, ANNOTATED. The tag MUST be gui-v<that exact version> — the workflow
#    refuses otherwise — and it must be `-a`; policy forbids lightweight tags.
git tag -a gui-v0.1.1 -m "Driftstack GUI v0.1.1 — <what changed>"

# 3. ⛔ PUSH THE TAG FIRST. This order is load-bearing, not a preference — see
#    "Why step 3 comes first" below. It also fires .github/workflows/gui-release.yml.
git push origin gui-v0.1.1

# 4. Create the release AGAINST THE TAG THAT NOW EXISTS, as a DRAFT. Because the tag
#    is already on origin, `gh` attaches to it instead of creating one of its own.
#    A draft is not "latest": if the builds fail, the updater keeps serving the
#    previous release instead of an asset-less one (see "Why a draft" below).
gh release create gui-v0.1.1 --draft --title "Driftstack GUI gui-v0.1.1" --notes "..."

# 5. Watch the build, then VERIFY BEFORE TRUSTING: assets non-empty, latest.json
#    carrying 9 platform keys with 0 unsigned. The build workflow publishes the
#    draft itself on success (measured on 0.1.46 and 0.1.47); publish by hand only
#    if it is still a draft after a green run.
gh run watch <run-id> --exit-status
gh release view gui-v0.1.1 --json assets,isDraft
gh release edit gui-v0.1.1 --draft=false   # only if isDraft is still true
```

## ⛔ Why step 3 comes first: `gh release create` makes a LIGHTWEIGHT tag

If the tag is not already on origin, `gh release create <tag>` **creates it** — via the
GitHub REST API, as a **lightweight** ref. Policy forbids lightweight release tags, and
the build refuses them, so the cut fails after the tag is published — and a published tag
cannot be replaced, so the version number is burnt and the next cut has to skip it.

⛔ **The `.husky/pre-push` guard cannot save you here.** It inspects refs being pushed, and
`gh release create` never pushes: it calls the API. So the one check that exists is blind
to precisely this path. Pushing the annotated tag first is what puts the guard back in the
loop — and is why the order is written as a step rather than a note.

This is not hypothetical. `gui-v0.1.3`, `gui-v0.1.13`, `gui-v0.1.14` and `gui-v0.1.18` all
shipped lightweight, and 0.1.18 produced no artifacts at all. Every one of them followed
this runbook when it listed `gh release create` ahead of the push.

Artifacts land on the release: `.exe` + `.msi` (Windows), `.dmg` (macOS), `.AppImage` +
`.deb` (Linux), each with a `.sig`, plus `latest.json` for the updater.

## ⛔ Why step 3 exists: the org forbids Actions from creating releases

`tauri-action` publishes by creating the GitHub Release itself. On this org that call
fails, and the failure is genuinely confusing because the token _looks_ correct.

The run log prints:

```
GITHUB_TOKEN Permissions
  Contents: write
```

and the REST call still answers:

```
Resource not accessible by integration
  https://docs.github.com/rest/releases/releases#create-a-release
```

The reason, confirmed against the API rather than inferred:

```sh
$ gh api -X PUT repos/driftstackdev/driftstack-api/actions/permissions/workflow \
    -f default_workflow_permissions=write
409 Conflict
"Write permissions for workflows are disabled by the organization"
```

An **organization-level** policy overrides both the repository default and the job's own
`permissions: contents: write` block. The job is granted the scope nominally; the org
blocks the write.

This cost the first release ever cut (`gui-v0.1.0`): all three platforms built, then
every artifact was discarded at the final step.

### The real fix (needs an org owner)

`https://github.com/organizations/driftstackdev/settings/actions` →
**Workflow permissions** → allow read _and write_, or allow repositories to opt in.

Nobody without `admin:org` can read or change this — `gh api orgs/driftstackdev/actions/permissions/workflow`
returns 403. Until it is changed, step 3 is mandatory for every release.

The workflow now fails fast with this instruction if the release is missing, rather than
discovering it after a ten-minute cross-platform build.

## ⛔ The tag must match the app version

`gui-v0.1.0` was tagged against an app version of `0.0.1`. The assets were named
`Driftstack_0.0.1_*` and `latest.json` advertised `0.0.1` — so every install running
`0.0.1` was told it was already current. A dead updater that looks perfectly healthy.

The workflow now derives the version from `tauri.conf.json` and refuses a mismatched tag
_before_ building. `apps/server/tests/unit/every-copy-of-the-app-version-must-agree.test.ts`
guards the four in-repo copies; the tag half can only be checked at release time.

## ⛔ Why a draft: an asset-less release is "latest" for every installed client

The desktop updater reads `releases/latest/download/latest.json`. GitHub's "latest" is
the newest published, non-prerelease release — **whether or not it has assets**. 0.1.45
was created before its builds ran, all three builds failed, and for the time it took to
notice, every installed client's update check resolved to a release with no manifest.

The org forbids Actions from creating a release, so the human-creates-first order is
mandatory (above). But nothing requires the release to be _published_ while the builds
run. Created as a draft, a failed build leaves a draft, which is not "latest" and harms
nobody. Measured on gui-v0.1.46 and gui-v0.1.47: `tauri-action` PATCHes the existing draft
to published after a successful upload, so the happy path needs no manual publish step —
the `--draft=false` edit above is the fallback for a build that uploads without publishing.

Two facts worth knowing. A draft's URL is `…/releases/tag/untagged-<hash>` and it is not
attached to the git tag until published; `gh release view gui-vX` still resolves it by
name, which is what the workflow's release-exists check uses. And each platform job runs
`tauri-action` separately, so a _partial_ failure (one platform red after another
published) has NOT been observed and is not claimed to be covered — which is why step 5
verifies the assets and the manifest before trusting a release, draft or not.

## ⛔ Why the bump is a script: `Cargo.lock` is a copy nobody was checking

`Cargo.lock` carries the app version a fourth time, in the `driftstack-gui` `[[package]]`
entry. Cargo rewrites it silently at build time, so it drifts without anyone noticing: it
sat at `0.1.36` from 0.1.37 through 0.1.44 while every other copy moved, and nothing was
red.

0.1.45 is what that cost. The bump replaced every `version = "0.1.44"` line in the lock.
The app's own entry did not match (it was still 0.1.36) so it was not touched, and the
line that DID match belonged to the `tracing` crate, which happened to sit at 0.1.44. That
pinned `tracing` to a version that does not exist. All three release builds failed at
dependency resolution, and because the release had been created before the builds ran, an
**asset-less release became the "latest" release the desktop updater fetches its manifest
from** — so every installed client's update check 404'd until it was deleted.

Two guards now cover it, and they answer different questions — neither alone is enough:

| guard                                              | asks                                                     | blind to                                                   |
| -------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `every-copy-of-the-app-version-must-agree.test.ts` | does the lock name the version the other three name?     | a crate pinned to a version that does not exist            |
| `.husky/pre-push` (`cargo update -w --locked`)     | is the lock consistent with Cargo.toml and the registry? | nothing here — but it is SKIPPED when cargo is not on PATH |

`scripts/bump-gui-version.mjs` edits all four by field, computes every edit before writing
any of them (one refusal writes nothing), and runs the lock validation itself.

⚠️ If a release does go out broken, `gh release delete gui-vX --cleanup-tag --yes` FIRST.
That restores the previous release as "latest" for every installed client, which is the
bleeding edge of the problem; fixing the tree can follow at its own pace.

## Known gaps

- **Windows and Linux binaries are UNSIGNED.** SmartScreen shows "unknown publisher";
  _More info → Run anyway_. Fixing this needs an OV/EV code-signing certificate, repo
  secrets, and `bundle.windows.certificateThumbprint` + `digestAlgorithm` + `timestampUrl`
  (or `signCommand` with Azure Trusted Signing). `gui-release.yml` states the pre-launch
  posture explicitly.
- **`gui-build-check.yml` never runs `tauri build`.** It runs `cargo check` and
  `cargo test`, so bundling, linking and installer generation are exercised _only_ by a
  real release. That is why `gui-v0.1.0` was the first thing to discover that the pinned
  Rust toolchain had no `x86_64-apple-darwin` target.
- **macOS is excluded from the updater** by design — see
  `src-tauri/capabilities/updater-windows-linux.json`.
