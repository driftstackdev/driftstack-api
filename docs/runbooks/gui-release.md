# GUI release runbook

How to cut a Driftstack desktop client release, and the two org-level facts that make it
non-obvious.

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

Before step 1, run the two GUI render gates from the repo root (they need the gui-client dev server and a Chromium, so neither is in pre-push; `.github/workflows/gui-gates.yml` also runs both, plus the control, with Chromium on an ubuntu runner on every push to main that touches `apps/gui-client/**`, `packages/api-types/**` or the gate scripts — its fonts differ from a Mac's, so a text width that only clips there is caught there; a red run is a defect in a view, never a reason to exempt the element): `node scripts/gui-visual-check.mjs` (profile-card geometry — nothing outside the box) and `node scripts/gui-text-quality.mjs` (every text leaf of EVERY harness scene — the six marketing scenes plus the seventeen audit scenes: one per remaining view, plus seven more for the AI view's own states (no key, planning, running, approval, done, trouble, stopping), which cannot be reached from fixture data alone and so had never been measured — twenty-three as of 2026-09-19 (the Logs view, removed from navigation in June, is gone with its scene); the gate reads the list and each stage's size from the harness's `ALL_SCENES` at run time and refuses an empty list or one missing the six — in BOTH themes: WCAG contrast, size, untitled truncation; `--control` proves the instrument still sees its four injected findings — a 7px dim span, a clipped untitled span, and a mixed-content span faded by `opacity`, the shape of the two holes its first version had; 0 findings is the bar).

## ⛔ Before you write a single line of release notes: verify each claim on the running artifact

Owner directive, 2026-09-12: _"ensure all tasks really get completed on next release update, and that
the agents responsible for tasks also finish it"_. It was earned. In the wave that became 0.1.52, four
items were reported finished by the agent that owned them while the thing the owner had described was
still there:

| what the agent finished                        | what was still open                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the `+1` no longer hid a MEASURED OS chip      | on a proxy with **no** reading — the owner's own case — the pill was unchanged                  |
| a harness literal was updated                  | `theme-token-parity.test.ts` pinned the old one; the pre-push gate rejected the push            |
| a refusal reason was added to the error type   | two of the three copies of that enum, including the customer-facing docs table, did not have it |
| every local gate passed on a chip-width change | the Linux geometry gate failed on the one row that fit by a single pixel                        |

The pattern is one thing, and it is not carelessness: **an agent's brief and the owner's sentence are
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

## After the workflow publishes: put the release notes back

`tauri-action`'s publish step overwrites the draft's title and body with its own
template ("Driftstack GUI gui-vX" + the install / auto-update boilerplate). The
`--notes-file` handed to `gh release create --draft` does not survive it, and
nothing in the workflow warns. Every release from 0.1.46 to 0.1.50 came out with
the generic page until the notes were re-applied by hand (2026-09-12).

Once the chain reports the release published, re-apply the notes on top of the
template (keep its install text — it is what a first-time downloader needs):

```sh
gh release view gui-vX.Y.Z --json body --jq .body > /tmp/template.md
{ cat relnotes-X.Y.Z.md; echo; echo "---"; echo; cat /tmp/template.md; } > /tmp/final.md
gh release edit gui-vX.Y.Z --title "Desktop client X.Y.Z" --notes-file /tmp/final.md
```

Editing the title or notes after publish touches neither `latest.json` nor the
assets; the updater is unaffected.

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
