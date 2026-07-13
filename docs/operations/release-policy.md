# Driftstack release policy

Canonical policy for which deploy workflow handles which environment. Locked per V-283 founder direction 2026-05-07.

The repo has two server-side deploy workflows (V-278). Both exist on `main` and both will continue to exist; the policy is which to use per release, not which to delete.

## The split

| Environment | Workflow                              | Trigger                                      | Shape                         |
| ----------- | ------------------------------------- | -------------------------------------------- | ----------------------------- |
| Staging     | `.github/workflows/deploy.yml`        | push to `main`                               | Continuous delivery (auto)    |
| Production  | `.github/workflows/server-deploy.yml` | tag matching `server-v*` + workflow_dispatch | Explicit release (deliberate) |

## Why split

- **Staging on main**: every commit to main is a candidate to live on `staging.driftstack.dev`. Catches integration regressions immediately + gives the founder a place to smoke-test against real infra before any production cut. No approval gate; if main is green, staging gets it.
- **Production on tag**: production cuts are deliberate. The founder reviews + tags `server-vX.Y.Z`; the tag-triggered workflow builds the image at exactly the tagged commit + deploys to `api.driftstack.dev`. The production GitHub Environment's reviewer gate still applies as the final approval before the SSH-deploy step runs.

## What about the `deploy-production` job in `deploy.yml`?

`deploy.yml` has a legacy `deploy-production` job from before the V-283 policy lock. Per policy, this job is **not the canonical production path** — production cuts go through `server-deploy.yml` triggered on a `server-v*` tag.

The `deploy-production` approval gate in `deploy.yml` remains as a backstop in case the tag pipeline ever needs to be bypassed (e.g. CI tag-detection bug, urgent rollback to a non-tagged commit). It should not be approved during normal operation.

If you find yourself approving `deploy-production` in `deploy.yml` regularly, that's a signal the tag-pipeline isn't fitting the workflow — surface it for founder review, don't quietly normalize approving the legacy gate.

## Per-release decision tree

When ready to release:

1. **Is this a routine staging deploy after a main merge?** Nothing to do — `deploy.yml` already fired on push.
2. **Is this a production cut?**
   1. Verify the commit you're cutting from is on `main` and CI is green.
   2. Run any pre-launch smoke against staging that matters for this change.
   3. Tag: `git tag server-v0.X.Y && git push origin server-v0.X.Y`.
   4. The `server-deploy.yml` workflow fires — builds at tag, deploys to production after the GitHub Environment approval gate clears.
3. **Is this an emergency rollback to a non-tagged commit?** Two options:
   1. Tag the rollback target: `git tag server-v0.X.Y-rollback <good-sha> && git push origin server-v0.X.Y-rollback`. Keeps everything on the tag-pipeline.
   2. Image-level rollback per `docs/operations/launch-day-runbook.md` rollback section. SSH to the production VM, set `IMAGE_TAG` to a previous good ghcr.io image, `docker compose up -d`. Faster but doesn't update what's tagged at `main`.

The first option is preferred unless the SSH path is faster (1-2 min vs ~3 min for the tag-pipeline).

## What changes when policy is locked

- **Founder workflow muscle memory**: production cuts mean tagging, not approving. The tag becomes the canonical artefact.
- **Audit trail**: the `server-vX.Y.Z` tag is the production-deploy-of-record. Every prod cut leaves a tag in `git tag --list 'server-v*'` for forensic timeline reconstruction.
- **Hotfix discipline**: a hotfix is a tag (`server-v0.X.Y` → `server-v0.X.Y+1`), not a "approve a different commit on the prod gate." Same artefact shape as planned releases; no special hotfix path.
- **CI breadth**: `deploy.yml`'s build-image job + skip-on-missing-secret pattern still handles the staging deploy. Tag pipeline is leaner — image build + production deploy only, no staging hop (staging already has the latest commit anyway via `deploy.yml`'s push-on-main path).

## Versioning the tags

`server-v` tags follow SemVer:

- **Patch** (`server-v0.1.0` → `server-v0.1.1`): bugfix, internal refactor, no observable behaviour change.
- **Minor** (`server-v0.1.x` → `server-v0.2.0`): additive API changes, new features, backwards-compatible.
- **Major** (`server-v0.x.y` → `server-v1.0.0` and beyond): breaking API changes per ADR-NNN versioning policy. Major bumps trigger the deprecation cycle in `apps/docs/src/pages/api/versioning.md`.

Tags are independent from the GUI client (`gui-v*`), the SDK (`sdk-ts-v*`, `sdk-py-v*`, `sdk-go-v*`), and any other taggable surface. Same repo, different release cycles, no coupling.

## Tag-creation rules

- **No retagging**: tags are immutable artefacts. Fixing a typo in a tagged release means cutting a new tag, not force-pushing the existing one.
- **No skipping versions**: `server-v0.1.0` → `server-v0.1.1` → `server-v0.1.2`. Skipping (`v0.1.0` → `v0.1.5`) makes the gap suspicious in audit timelines.
- **Annotated tags only**: `git tag -a server-vX.Y.Z -m "Release X.Y.Z — <summary>"`. Lightweight tags don't carry the message context.
- **Tag from `main` only**: tags applied to off-main commits don't represent shipped state. The pre-push hook + branch-protection rules can be tightened to enforce this; documenting the discipline first.

## Related docs

- `docs/operations/launch-day-runbook.md` — references this policy in the T-0 cutover section.
- `docs/founder-actions/v278-hetzner-deploy-keys.md` — first-deploy options reference this policy.
- `docs/operations/production-env-schema.md` — env-var schema in provisioning order.
- `docs/deployment/runbook.md` — day-to-day operations.
- `docs/deployment/dr-runbook.md` — disaster recovery procedures.

## Policy review

This policy is locked at V-283 founder direction 2026-05-07. Revision triggers:

1. Founder explicit direction to switch.
2. Production-cut friction observed in practice that the policy doesn't accommodate (e.g. tag-pipeline failures requiring emergency override).
3. Material change to the underlying CI / deployment stack (e.g. moving off Hetzner; switching off ghcr.io; replacing wrangler/CF Pages).

Without one of those, the policy stays — `deploy.yml` for staging, `server-deploy.yml` for production. Predictability over flexibility.
