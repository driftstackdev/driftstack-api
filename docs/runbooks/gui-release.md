# GUI release runbook

How to cut a Driftstack desktop client release, and the two org-level facts that make it
non-obvious.

## TL;DR — cutting a release

```sh
# 1. Bump the version in ALL THREE places (they are guarded to agree).
#    apps/gui-client/package.json
#    apps/gui-client/src-tauri/tauri.conf.json
#    apps/gui-client/src-tauri/Cargo.toml

# 2. Tag it. The tag MUST be gui-v<that exact version> — the workflow refuses otherwise.
git tag -a gui-v0.1.1 -m "Driftstack GUI v0.1.1 — <what changed>"

# 3. Create the release BEFORE or immediately after pushing the tag (see "Why" below).
gh release create gui-v0.1.1 --title "Driftstack GUI gui-v0.1.1" --notes "..."

# 4. Push the tag. This fires .github/workflows/gui-release.yml.
git push origin gui-v0.1.1
```

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
_before_ building. `apps/server/tests/unit/three-copies-of-the-app-version-must-agree.test.ts`
guards the three in-repo copies; the tag half can only be checked at release time.

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
