# GUI release runbook

How to cut a Driftstack desktop client release, how the release workflow is shaped, how to
dry-run it without publishing anything, and the org-level facts that make it non-obvious.

## TL;DR — cutting a release

```sh
# 1. Bump the version. FIVE files carry it and they are guarded to agree:
#      apps/gui-client/package.json               "version"
#      apps/gui-client/src-tauri/tauri.conf.json  "version"  <- names the assets + latest.json
#      apps/gui-client/src-tauri/Cargo.toml       [package] version
#      apps/gui-client/src-tauri/Cargo.lock       the driftstack-gui [[package]] entry
#      package-lock.json (repo root)              the apps/gui-client workspace entry
#    Use the script. It edits each one by FIELD and validates the lock; see
#    "Why the bump is a script" below for the release this cost.
node scripts/bump-gui-version.mjs 0.1.1

# 2. Tag it, ANNOTATED. The tag MUST be gui-v<that exact version> — the workflow
#    refuses otherwise — and it must be `-a`; policy forbids lightweight tags.
git tag -a gui-v0.1.1 -m "Driftstack GUI v0.1.1 — <what changed>"

# 3. ⛔ PUSH THE TAG FIRST. This order is load-bearing, not a preference — see
#    "Why step 3 comes first" below. It also fires .github/workflows/gui-release.yml.
git push origin gui-v0.1.1

# 4. Create the release AGAINST THE TAG THAT NOW EXISTS, as a DRAFT, with its real
#    title and notes. Because the tag is already on origin, `gh` attaches to it
#    instead of creating one of its own. A draft is not "latest": if the builds
#    fail, the updater keeps serving the previous release instead of an asset-less
#    one (see "Why a draft" below). The workflow keeps this title and these notes;
#    it only appends the install section if the notes lack one.
#    The run does not need the draft until every platform is built and signed, so
#    this step can follow the push by minutes; preflight only warns while it is
#    missing. If the run gets there first, publish-manifest stops without writing
#    anything: create the draft, then `gh run rerun <run-id> --failed` (see
#    "If the run reaches publish-manifest before the draft exists").
gh release create gui-v0.1.1 --draft --title "Desktop client 0.1.1" --notes-file relnotes-0.1.1.md

# 5. Watch the run, then VERIFY BEFORE TRUSTING: 10 assets, latest.json carrying 9
#    platform keys with 0 unsigned. `publish-manifest` uploads every asset into the
#    draft and publishes it ONCE, after all three platforms are built and signed and
#    the upload is checked; publish by hand only if it is still a draft after a
#    green run.
gh run watch <run-id> --exit-status
gh release view gui-v0.1.1 --json assets,isDraft
gh release edit gui-v0.1.1 --draft=false   # only if isDraft is still true
```

To test a change to the workflow itself, dry-run it first — see "Dry run" below. It
builds and signs every platform and publishes nothing.

Before step 1, run the two GUI render gates from the repo root (they need the gui-client dev server and a Chromium, so neither is in pre-push; `.github/workflows/gui-gates.yml` also runs both, plus the control, with Chromium on an ubuntu runner on every push to main that touches `apps/gui-client/**`, `packages/api-types/**` or the gate scripts — its fonts differ from a Mac's, so a text width that only clips there is caught there; a red run is a defect in a view, never a reason to exempt the element): `node scripts/gui-visual-check.mjs` (profile-card geometry — nothing outside the box) and `node scripts/gui-text-quality.mjs` (every text leaf of EVERY harness scene — the six marketing scenes plus the nineteen audit scenes: one per remaining view, plus seven more for the AI view's own states (no key, planning, running, approval, done, trouble, stopping), which cannot be reached from fixture data alone and so had never been measured, plus TWO that are WINDOWS rather than states and carry stage sizes of their own (the gate renders each scene at its declared size and never passes `?stage=`, so anything but 1280x800 is otherwise measured by nothing): `audit-agent-chat-small`, the running state at the 960x600 Tauri minimum, and `audit-agent-chat-ended`, the only scene whose phone screen is the real `AgentSessionPanel` — its own "Session ended" overlay in the ~205px box stage 4 gave it, which no gate had ever rendered — twenty-five as of 2026-09-20 (the Logs view, removed from navigation in June, is gone with its scene); the gate reads the list and each stage's size from the harness's `ALL_SCENES` at run time and refuses an empty list or one missing the six — in BOTH themes: WCAG contrast, size, untitled truncation; `--control` proves the instrument still sees its four injected findings — a 7px dim span, a clipped untitled span, and a mixed-content span faded by `opacity`, the shape of the two holes its first version had; 0 findings is the bar).

## ⛔ Before you write a single line of release notes: verify each claim on the running artifact

Owner directive, 2026-09-12: every task on the next release update must really be completed, and
finished by whoever is responsible for it. It was earned. In the batch that became 0.1.52, four
items were reported finished by whoever owned them while the thing the owner had described was
still there:

| what was reported finished                     | what was still open                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the `+1` no longer hid a MEASURED OS chip      | on a proxy with **no** reading — the owner's own case — the pill was unchanged                  |
| a harness literal was updated                  | `theme-token-parity.test.ts` pinned the old one; the pre-push gate rejected the push            |
| a refusal reason was added to the error type   | two of the three copies of that enum, including the customer-facing docs table, did not have it |
| every local gate passed on a chip-width change | the Linux geometry gate failed on the one row that fit by a single pixel                        |

The pattern is one thing, and it is not carelessness: **a task's brief and the owner's sentence are
different propositions, and the brief is the one with the acceptance criteria attached.** A green test is
evidence about what the test states. It is not evidence that a person looking at the screen sees what
they asked to see.

So every item a release CLAIMS gets this treatment before the notes mention it:

1. **Quote the owner's words.** Not a paraphrase, not a ticket title.
2. **Name the observable** that settles it — what a person sees on screen, or a value on the wire. Never
   a test name and never a code path.
3. **Produce that observable off the running artifact.** Render the real view in the harness at the real
   width, read the DOM, screenshot it and LOOK at the screenshot. Drive the route for a server item.
   An earlier report is not evidence; neither is a passing suite.
4. **Attack your own verdict once.** Name the state you did not try and try it. Every miss above was an
   adjacent state: no reading instead of a reading, the other theme, another width, a different font
   stack, a stored value instead of a pasted one, the second failure instead of the first.
5. **Write `UNVERIFIABLE HERE` when it is.** A real tunnel coming up, a real OAuth sign-in and an install
   on the owner's own machine cannot be proved from a maintainer's box. Say so in the notes rather than
   letting the claim stand — "still to come" is a section the notes are allowed to have.

⛔ **A claim in the notes with no verification behind it is worse than an omission.** The customer reads
it, believes the thing is fixed, and the next report is about trust rather than about the defect.

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

Artifacts land on the release — 10 of them: `-setup.exe` (Windows), `.dmg` and
`_universal.app.tar.gz` (macOS), `.AppImage` + `.deb` (Linux), a `.sig` for each of the
four updater artifacts (the `.exe`, `.app.tar.gz`, `.AppImage` and `.deb`; the `.dmg` is
not one), plus `latest.json` for the updater.

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

Since 2026-09-24 the workflow never tries to create a release: `tauri-action` only
builds, and `publish-manifest` uploads into the release a person created (see "How the
workflow is shaped"). A missing release no longer costs the build either. The signed set
is kept with the run, so a publish that found no draft is finished by re-running that one
job (see "If the run reaches publish-manifest before the draft exists").

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

### ⛔⛔ 2026-09-17 — BOTH claims above stopped being true. Measured on gui-v0.1.62 and gui-v0.1.63.

**The draft is no longer used, so it no longer protects anything.** On both releases the draft
was created exactly as step 4 says, against a tag already on origin. Each platform job then logged

```
Couldn't find release with tag gui-v0.1.63. Creating one.
```

and `tauri-action` created **its own release and published it**. Evidence, from the releases API:

| tag         | release id | draft | assets | name                                                           |
| ----------- | ---------- | ----- | ------ | -------------------------------------------------------------- |
| gui-v0.1.62 | 389859928  | true  | 0      | Desktop client 0.1.62 ← the hand-made draft, orphaned          |
| gui-v0.1.62 | 389864718  | false | 10     | Desktop client 0.1.62 ← created by the action, renamed by hand |
| gui-v0.1.63 | 390862111  | true  | 0      | Desktop client 0.1.63 ← the hand-made draft, orphaned          |
| gui-v0.1.63 | 390868508  | false | 6→10   | created by the action as "Driftstack GUI gui-v0.1.63"          |

So "the org forbids Actions from creating a release" is **also no longer true** — the action
created one, twice. 0.1.62's orphan went unnoticed for a day: `gh release view <tag>` resolves to
the DRAFT while both exist, which is why a post-build check read `isDraft: true` on a release that
was in fact live.

**A partial publish HAS now been observed.** On 0.1.63 the Linux bundles built and signed, and the
upload of the `.deb` was answered two minutes in by GitHub's own "Unicorn!" error page — a
GitHub-side failure. Windows and macOS had already published. For ~25 minutes the release that was
"latest" for every installed client carried 6 assets and no Linux.

**What actually contained it was not the draft. It was the manifest's shape.** `latest.json` is
keyed by platform, and a platform whose job failed has no key: the live manifest held 6 keys, all
signed (4 darwin, 2 windows), so a Linux client saw no 0.1.63 and stayed on 0.1.62 — it was never
offered a broken update. That property is load-bearing and nothing here states or tests it.

**What to do until the workflow is fixed:**

1. After a red platform job, read the log before anything else. If the bundles are listed under
   "Found artifacts" and the error is an HTML page, it is an upload failure:
   `gh run rerun <run-id> --failed`. `publish-manifest` is skipped while any platform is red and
   runs after the re-run, which is what writes the last keys.
2. Address releases **by id**, never by tag, while two exist:
   `gh api repos/<org>/<repo>/releases --paginate -q '.[] | select(.tag_name=="gui-vX")'`.
3. Put the real title and notes on the PUBLISHED one (`gh api -X PATCH …/releases/<id>`), then
   delete the empty draft by id. Deleting a release never deletes the tag — confirm with
   `git ls-remote --tags origin gui-vX` anyway.
4. Then run step 5's verification as written: 10 assets, 9 platform keys, 0 unsigned.

**The real fix** is in the workflow, not here: either have it find the draft (list releases and
match `tag_name`, since `GET /releases/tags/:tag` does not return drafts) and publish only from
`publish-manifest` once every platform is green, or drop the draft step from this runbook and say
plainly that publication is per-platform. It is left open rather than patched blind — a release
workflow cannot be tested without cutting a release.

**2026-09-24 — the first option is what the workflow now does**, and the dry run (below) is how
it gets tested without cutting a release. `preflight` and `publish-manifest` find the release by
`tag_name` in the release list. `preflight` refuses two or more at once, so the orphan-draft state
above stops the run instead of being published around. `publish-manifest` refuses anything but
EXACTLY one. (`preflight` does not refuse zero: the draft is created after the tag push, see
step 4.) No platform job touches the release any
more: `publish-manifest` uploads all ten assets after every platform is built and signed,
`latest.json` last, checks that the release carries exactly those files at exactly those sizes,
and only then publishes the draft. A red platform leaves an untouched draft. Steps 1–4 above are
still the recovery for releases cut before this change.

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
  real release — or, since 2026-09-24, by a dry run of `gui-release.yml` (see "Dry run"),
  which is the cheap way to find out first. That is why `gui-v0.1.0` was the first thing to
  discover that the pinned Rust toolchain had no `x86_64-apple-darwin` target.
- **macOS is excluded from the updater** by design — see
  `src-tauri/capabilities/updater-windows-linux.json`.

## Release notes: written once, at step 4

Until 2026-09-24, `tauri-action`'s publish step overwrote the draft's title and body
with its own template ("Driftstack GUI gui-vX" + the install / auto-update
boilerplate), so every release from 0.1.46 on needed its notes re-applied by hand
after publish.

The workflow no longer does that. `publish-manifest` keeps the title and notes the
draft was created with (step 4), and appends the install / auto-update section once,
below a `---`, only if the notes do not already contain an `**Install**` line — it is
what a first-time downloader needs. To change the notes after publish:

```sh
gh release edit gui-vX.Y.Z --title "Desktop client X.Y.Z" --notes-file relnotes-X.Y.Z.md
```

Editing the title or notes after publish touches neither `latest.json` nor the
assets; the updater is unaffected.

## How the workflow is shaped (security sweep E-10)

The updater signing key can sign an update that every installed client will accept, and
the release it is uploaded to IS the updater endpoint. So the key is kept away from
everything that runs third-party code. Four jobs in `.github/workflows/gui-release.yml`:

| job                | runs on                   | token          | holds the signing key?       | what it does                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------- | -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`        | ubuntu                    | contents:write | no                           | reads the version from `tauri.conf.json`; on a tag push, refuses a lightweight tag, a tag that disagrees with the version, and two or more releases for the tag, and only warns when there is no release yet (write only because a draft is invisible to a read-only token)                                                                                   |
| `build`            | macOS, Ubuntu, Windows    | contents:read  | **no**                       | everything that runs third-party code: `npm ci`, the workspace builds, the Simulator, `tauri-action` with `--no-sign`. Hands its bundles on as the `unsigned-<platform>` workflow artifacts, under the asset names releases have always used                                                                                                                  |
| `sign`             | a fresh ubuntu runner     | contents:read  | **in one step, and only it** | checks out only `package-lock.json`, installs only the tauri CLI it pins (integrity-checked, no install scripts), then fetches the build's bundles and refuses anything but the five a release carries; signs the four updater artifacts, verifies every signature against the public key, assembles `latest.json` (9 keys), keeps it all as `signed-release` |
| `publish-manifest` | ubuntu, **tag push only** | contents:write | no                           | needs exactly one release for the tag and otherwise stops before writing anything; uploads `signed-release` into the draft (`latest.json` last), checks the release carries exactly those files at those sizes, publishes it, then checks the updater endpoint anonymously                                                                                    |

Three things fail the run on purpose: a `.sig` coming out of `build` (it would mean a key
reached it); anything in the build's hand-over other than the five bundles (below); and a
signature that does not verify against the public key installed clients trust. That is
`TAURI_UPDATER_PUBKEY`, or `TAURI_UPDATER_TRUSTED_PUBKEY` while a key rotation sets it
(see "Key rotation" below). tauri itself only warns when the private
key does not match the public one, which would ship updates no install can apply. `the-release-job-pins-every-action-to-a-commit-and-keeps-no-token-on-disk.test.ts`
fails if the key appears anywhere but that one signing step.

The key being in one step is not enough on its own: every secret of a job is in the
runner's memory for the whole job, and a GitHub-hosted runner gives any step root. So
nothing the build wrote may run anywhere in `sign`. The build's hand-over is checked right
after it is fetched, before any step reads it: exactly one each of `.dmg`, `.app.tar.gz`,
`-setup.exe`, `.AppImage` and `.deb`, each a regular file with a plain name, and nothing
else (no module, no dotfile, no directory, no symlink). The signer is installed before the
hand-over is fetched; `python3` runs with `-I`, so it never imports from the directory it
runs in; and the signer is handed `./<name>`, so no name can be read as an option. If
"The build handed over the five bundles and nothing else" fails, do not just re-run: its
error lists what else was there, and something in the build wrote it. Find what did
before cutting another release.
`the-sign-job-runs-nothing-the-build-left-beside-its-bundles.test.ts` runs those steps
against planted files.

A re-run of a failed platform (`gh run rerun <run-id> --failed`) re-runs `sign` and
`publish-manifest` after it; nothing reached the release in the meantime. A re-run of
failed jobs keeps the earlier attempt's workflow artifacts, which is how the re-run jobs
find the platforms that did not fail. Both uploads set `overwrite: true`, so a name an
earlier attempt already used is replaced rather than failing the job.

### If the run reaches publish-manifest before the draft exists

The draft is created after the tag push (step 4), and the run does not need it until
every platform is built and signed. If it is still missing then, `publish-manifest`
stops with `No release carries gui-vX` and writes nothing: no asset, no `latest.json`,
no publish. The tag is not burnt, and nothing needs rebuilding:

```sh
gh release create gui-vX.Y.Z --draft --title "Desktop client X.Y.Z" --notes-file relnotes-X.Y.Z.md
gh run rerun <run-id> --failed       # re-runs publish-manifest alone, from the kept signed-release
gh run watch <run-id> --exit-status
```

The same recovery applies when it stops on two releases for the tag: keep one (by id, see
above), then re-run. The signed set is kept for 7 days (`retention-days` in the
workflow). After that, a re-run of the whole workflow (`gh run rerun <run-id>`)
rebuilds and re-signs it.

## Dry run: test the workflow without publishing anything

A manual run of the workflow is ALWAYS a dry run — the dispatch takes no inputs, so
nothing typed into it can turn publishing on. It runs `preflight` (reading the version,
skipping the tag and release checks), `build` on all three platforms and `sign` with the
real key. `publish-manifest` does not run: no release is created, changed or published,
and no `latest.json` reaches one. The result is kept as workflow artifacts for 7 days.

```sh
# 1. Start it from main (or any branch) — it builds that branch's app version.
gh workflow run gui-release.yml --ref main
gh run list --workflow gui-release.yml --limit 1          # note the run id
gh run watch <run-id> --exit-status                       # preflight, 3x build, sign: all green; publish-manifest skipped

# 2. Take the signed set and check it.
gh run download <run-id> -n signed-release -D /tmp/gui-dry-run
ls /tmp/gui-dry-run                                        # 10 files: .dmg, _universal.app.tar.gz, -setup.exe, .AppImage, .deb, 4 x .sig, latest.json
jq '.version, (.platforms | length), ([.platforms[] | select(.signature == "")] | length)' /tmp/gui-dry-run/latest.json
#    -> the app version, 9, 0

# 3. Confirm nothing was published: the updater still serves the current release.
curl -sL https://github.com/driftstackdev/driftstack-api/releases/latest/download/latest.json | jq .version
```

In the run log, the `sign` job's "The build handed over the five bundles and nothing else"
step lists the five bundle names and nothing more, its "Every signature must verify
against the updater public key" step lists `verified` for all four updater artifacts, and
the `build` legs' "Collect the unsigned bundles" steps list the asset names — compare them with the previous release's
(`gh release view gui-vX --json assets`): only the version in them may differ.

## Key rotation: `TAURI_UPDATER_TRUSTED_PUBKEY`

The `sign` job verifies every signature against the public key that INSTALLED clients
trust, because that is the key the updater checks. Normally that is
`TAURI_UPDATER_PUBKEY`, the key this build compiles in. A key rotation
(`docs/founder-actions/v243-tauri-updater-keys.md`, "Rotation") is the one release where
they differ on purpose: it is signed with the OLD private key and compiles in the NEW
public key. For that release, set the optional repository variable to the OLD public key:

```sh
gh variable set TAURI_UPDATER_TRUSTED_PUBKEY < old-gui-update.pub   # the OLD public key file
gh variable list                                                    # is it still set?
gh variable delete TAURI_UPDATER_TRUSTED_PUBKEY                     # with the switch to the NEW private key
```

While it is set and differs from the compiled key, every run prints a `KEY ROTATION`
warning naming both key ids, and dry runs do too. Any release signed with another key fails
and names the variable, so a value left behind shows up at the next release instead of going
unnoticed. Without the variable, the rotation release fails verification, and the error
says to set it. Dry-run the rotation release with the variable set before cutting its tag.

## Where the updater actually reads from

`apps/gui-client/src-tauri/tauri.conf.json` → `plugins.updater.endpoints`:
`https://github.com/driftstackdev/driftstack-api/releases/latest/download/latest.json`.
That is the only "what does the updater serve" check that means anything:

```sh
curl -sL https://github.com/driftstackdev/driftstack-api/releases/latest/download/latest.json | jq .version
```

It must still read the PREVIOUS version while the draft builds (a draft is not
"latest"), and the new one after publish. There is no updater route on
`api.driftstack.dev`; a guess like `/v1/gui/updates/latest.json` returns 404
and proves nothing.
