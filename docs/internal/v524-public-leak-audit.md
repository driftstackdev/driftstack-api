# V-524 — driftstack-api public-repo leak audit

**Date:** 2026-05-10
**HEAD audited:** `d4cc781`
**Total tracked files:** 911
**Purpose:** classify every file currently exposed in the driftstack-api
public GitHub repo, to inform the V-525 extraction plan, V-526 sanitization
sweep, and V-528 privatization runbook. **Staging only — no acts performed
by this audit.**

## Classification taxonomy

| Bucket                 | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `customer-facing-keep` | Legitimate public artifact; stays as-is (no internal-string sweep needed beyond V-526). |
| `internal-private`     | Must NOT exist in any public repo. Privatize repo OR delete entirely from public scope. |
| `extract-to-sdk-repo`  | Belongs in a standalone public SDK repo (V-525 extraction plan target).                 |
| `delete-entirely`      | Not useful in any repo (test scaffolding, stale audits).                                |
| `sanitize-then-keep`   | Public-suitable in principle, but contains internal/anonymity strings — V-526 scrubs.   |

## Summary counts

| Bucket                 | File count | % of repo |
| ---------------------- | ---------: | --------: |
| `internal-private`     |        ~88 |       9.7 |
| `extract-to-sdk-repo`  |       ~157 |      17.2 |
| `sanitize-then-keep`   |        ~75 |       8.2 |
| `customer-facing-keep` |       ~591 |      64.9 |
| `delete-entirely`      |         ~0 |       0.0 |

**Net effect under founder-locked option (a) PRIVATIZE + extract 3 SDK repos:**

- driftstack-api flips private → 911 files stop being public.
- 3 new public SDK repos materialize → ~157 files become the only public surface.
- ~75 sanitize-then-keep files are scrubbed for V-211/V-205 compliance regardless
  of repo posture (defense-in-depth so a future re-public-flip is safe).

## Per-cluster classification

### Cluster 1 — root configs + meta (16 files)

| Path                   | Bucket                 | Notes                                                              |
| ---------------------- | ---------------------- | ------------------------------------------------------------------ |
| `LICENSE`              | `customer-facing-keep` | Standard.                                                          |
| `README.md`            | `sanitize-then-keep`   | First-impression file; founder/anonymity sweep + AI-process scrub. |
| `AGENTS.md`            | `internal-private`     | Documents internal agent posture; not customer-facing.             |
| `package.json`         | `customer-facing-keep` | npm metadata.                                                      |
| `package-lock.json`    | `customer-facing-keep` | Reproducibility.                                                   |
| `tsconfig.base.json`   | `customer-facing-keep` | Build config.                                                      |
| `tsconfig.json`        | `customer-facing-keep` | Build config.                                                      |
| `tsconfig.eslint.json` | `customer-facing-keep` | Lint config.                                                       |
| `eslint.config.js`     | `customer-facing-keep` | Lint config.                                                       |
| `.prettierrc.json`     | `customer-facing-keep` | Format config.                                                     |
| `.prettierignore`      | `customer-facing-keep` | Format config.                                                     |
| `.nvmrc`               | `customer-facing-keep` | Node version pin.                                                  |
| `.gitignore`           | `customer-facing-keep` | Standard.                                                          |
| `.env.example`         | `sanitize-then-keep`   | May include V-NNN refs in comments.                                |
| `drizzle.config.ts`    | `customer-facing-keep` | Schema config.                                                     |
| `docker-compose.yml`   | `customer-facing-keep` | Dev infra.                                                         |
| `vitest.config.ts`     | `customer-facing-keep` | Test config.                                                       |
| `vitest.workspace.ts`  | `customer-facing-keep` | Test config.                                                       |
| `status.md`            | `internal-private`     | Live ops status; never customer-facing.                            |

### Cluster 2 — `.github/` CI + ops (10 files)

CI workflows reference internal infra (Hetzner SSH hosts, Cloudflare account
IDs as secrets) but the secret VALUES are not in the file — only secret NAMES.
Most are `sanitize-then-keep` to scrub V-NNN refs in inline comments. None
need to be in any public repo for SDK distribution; bucket them collectively
`internal-private` under the option-(a) verdict.

| Path                                              | Bucket             |
| ------------------------------------------------- | ------------------ |
| `.github/dependabot.yml`                          | `internal-private` |
| `.github/workflows/ci.yml`                        | `internal-private` |
| `.github/workflows/dependabot-auto-merge.yml`     | `internal-private` |
| `.github/workflows/deploy-customer-dashboard.yml` | `internal-private` |
| `.github/workflows/deploy-docs.yml`               | `internal-private` |
| `.github/workflows/deploy-marketing.yml`          | `internal-private` |
| `.github/workflows/deploy.yml`                    | `internal-private` |
| `.github/workflows/gui-build-check.yml`           | `internal-private` |
| `.github/workflows/gui-release.yml`               | `internal-private` |
| `.github/workflows/server-deploy.yml`             | `internal-private` |

### Cluster 3 — `infra/` (9 files)

| Path     | Bucket             | Notes                                                 |
| -------- | ------------------ | ----------------------------------------------------- |
| `infra/` | `internal-private` | Hetzner-specific provisioning; never customer-facing. |

### Cluster 4 — `apps/server/` (321 files)

The Fastify control plane source. Closed-source product code by intent.

| Bucket             | Count | Notes                                                                        |
| ------------------ | ----: | ---------------------------------------------------------------------------- |
| `internal-private` |  ~321 | Customers consume the API over the wire; source not part of the deliverable. |

### Cluster 5 — `apps/admin-panel/` (21 files), `apps/status-site/` (9 files), `apps/customer-dashboard/` (32 files)

| Bucket             | Count | Notes                                                                    |
| ------------------ | ----: | ------------------------------------------------------------------------ |
| `internal-private` |   ~62 | Internal UIs (admin) + customer-portal frontends; binaries ship via CDN. |

### Cluster 6 — `apps/marketing-site/` (37 files), `apps/docs/` (50 files)

Customer-facing copy. Marketing-site copy contains sub-processor disclosures
that REFERENCE Anthropic (required per DPA Annex 3 — bundled-LLM feature).
These are product disclosures, not AI-tooling references — they stay.

| Bucket               | Count | Notes                                                                            |
| -------------------- | ----: | -------------------------------------------------------------------------------- |
| `sanitize-then-keep` |   ~87 | Public copy lives as built artifacts on CDN; source stays private under opt (a). |

Under option (a): marketing-site + docs source live in driftstack-api private,
deploy artifacts publish to Cloudflare Pages. No public-source mirror needed.

### Cluster 7 — `apps/gui-client/` (104 files)

Tauri client. Binaries distribute via GitHub Releases on a separate public
repo (`driftstack-gui-releases`) for autoupdate signing; source stays in the
private `driftstack-api` monorepo.

| Bucket             | Count | Notes                                                                      |
| ------------------ | ----: | -------------------------------------------------------------------------- |
| `internal-private` |  ~104 | Source private; releases public via separate repo (V-525 follow-up scope). |

### Cluster 8 — `packages/sdk-*` (157 files: TS=53, Python=56, Go=48)

**This is the V-525 extraction target.** Each SDK becomes its own standalone
public repo (`driftstack-typescript-sdk` / `driftstack-python-sdk` /
`driftstack-go-sdk`). Each repo contains: `src/`, `tests/`, `README.md`,
`LICENSE`, `CHANGELOG.md`, `.github/workflows/` (publish to npm/PyPI/Go module
registry). No internal docs, no V-NNN refs.

| Path                       | Bucket                | New repo target             |
| -------------------------- | --------------------- | --------------------------- |
| `packages/sdk-typescript/` | `extract-to-sdk-repo` | `driftstack-typescript-sdk` |
| `packages/sdk-python/`     | `extract-to-sdk-repo` | `driftstack-python-sdk`     |
| `packages/sdk-go/`         | `extract-to-sdk-repo` | `driftstack-go-sdk`         |

V-526 sanitization sweep runs against each SDK before extraction — V-NNN log
references, founder framing, and AI-process prose must be zero in the
extracted repos.

### Cluster 9 — other `packages/` (54 files)

| Path                               | Bucket             | Notes                                                                                      |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `packages/api-types/`              | `internal-private` | Shared types; consumed by server + SDKs. Each SDK bundles its own copy of generated types. |
| `packages/behavioural-simulation/` | `internal-private` | Core differentiation; private package.                                                     |
| `packages/recipe-library/`         | `internal-private` | Phase 3.                                                                                   |
| `packages/recapture-automation/`   | `internal-private` | Phase 3.                                                                                   |
| `packages/webrtc-streaming/`       | `internal-private` | Phase 3.                                                                                   |
| `packages/webhook-delivery/`       | `internal-private` | Server-side delivery primitives.                                                           |

### Cluster 10 — `docs/` (75 files)

Highest-risk cluster for leaks. Most files are explicitly internal.

| Path                                       | Bucket               |
| ------------------------------------------ | -------------------- |
| `docs/CAPABILITIES.md`                     | `internal-private`   |
| `docs/architecture.md`                     | `internal-private`   |
| `docs/architecture/` (10 files)            | `internal-private`   |
| `docs/adr/` (7 files)                      | `internal-private`   |
| `docs/api/` (1 file)                       | `sanitize-then-keep` |
| `docs/benchmarks/` (4 files)               | `internal-private`   |
| `docs/contract-audit-2026-05-03.md`        | `internal-private`   |
| `docs/decisions.md`                        | `internal-private`   |
| `docs/deployment/` (6 files)               | `internal-private`   |
| `docs/entity-org-transition.md`            | `internal-private`   |
| `docs/founder-action-queue.md`             | `internal-private`   |
| `docs/founder-actions/` (5 files)          | `internal-private`   |
| `docs/gui-client/` (1 file)                | `internal-private`   |
| `docs/internal/` (3+ files)                | `internal-private`   |
| `docs/launch/` (1 file)                    | `internal-private`   |
| `docs/legal/` (7 files)                    | `internal-private`   |
| `docs/load-test/` (2 files)                | `internal-private`   |
| `docs/locked-decisions.md`                 | `internal-private`   |
| `docs/marketing/` (2 files)                | `internal-private`   |
| `docs/network-architecture.md`             | `internal-private`   |
| `docs/onboarding-for-future-developers.md` | `internal-private`   |
| `docs/operations/` (4 files)               | `internal-private`   |
| `docs/progress/` (2 files)                 | `internal-private`   |
| `docs/proposals/` (2 files)                | `internal-private`   |
| `docs/runbooks/` (6 files)                 | `internal-private`   |
| `docs/security-audit-2026-05-06.md`        | `internal-private`   |
| `docs/tech-debt.md`                        | `internal-private`   |
| `docs/verification-log.md`                 | `internal-private`   |

### Cluster 11 — `scripts/` (5 files) + `perf/` (5 files) + `.husky/` (2 files)

| Path       | Bucket             |
| ---------- | ------------------ |
| `scripts/` | `internal-private` |
| `perf/`    | `internal-private` |
| `.husky/`  | `internal-private` |

## V-211 + V-205 string-leak findings (input to V-526)

### Personal-name leaks (V-211)

Three files contain personal-name strings:

| File                                                        | Context                                                                                 | V-526 disposition                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | ---------- | ------------------------------------------------------------------- |
| `docs/entity-org-transition.md` (line 104)                  | KvK / BV minting flow — operational engineering.                                        | Move to private docs-tree; never publish. |
| `docs/marketing/dashboard-admin-visual-audit.md` (188, 250) | Self-referential audit — confirming the codebase has zero personal-name strings (META). | Scrub for irony — replace `Joël           | Theunissen | joeltheunissen89`literal with`<personal-name-pattern>` placeholder. |
| `docs/verification-log.md` (line 11864)                     | Historical V-log entry recording a prior sanitization.                                  | Move to private docs-tree; never publish. |

### AI-tooling vs sub-processor disclosure

`Claude` / `Anthropic` occurrences split into:

| Category                                                                                                                                                                       | Disposition                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Sub-processor / DPA Annex 3 (`apps/marketing-site/src/data/sub-processors.ts`, `apps/marketing-site/src/pages/legal/dpa.md`, `apps/marketing-site/src/pages/legal/privacy.md`) | KEEP — required product disclosure for bundled-LLM.        |
| Guard comments (`apps/gui-client/src/views/FirstRunWizard.tsx`)                                                                                                                | KEEP — they ARE the V-205 enforcement, not violations.     |
| AGENTS.md sub-processor listing                                                                                                                                                | KEEP — internal doc, but stays accurate.                   |
| Internal V-log references                                                                                                                                                      | `internal-private` cluster covers — moves to private tree. |

Net: zero AI-tooling references in customer-facing surfaces; all `Anthropic`
mentions on the marketing site are sub-processor disclosure.

## Founder-locked decision (recap)

Option **(a) PRIVATIZE driftstack-api + extract 3 SDK repos** was selected
over option (b) ruthless in-place cleanup. This audit's bucket counts confirm
why: 88+ files are unambiguously `internal-private` and would require either
deletion (loses engineering history) or force-push scrub (high-risk on a
paying-customer-pending repo). Privatization is a single atomic operation
with reversible blast radius.

## Next steps (gated on founder review tomorrow)

1. **V-525 extraction plan** (W16): generate `driftstack-typescript-sdk` /
   `driftstack-python-sdk` / `driftstack-go-sdk` as branches in the current
   repo, ready to push to fresh GitHub repos.
2. **V-526 sanitization sweep** (W17): scrub the ~75 `sanitize-then-keep`
   files even though they end up in a private repo, so a future SDK-extract
   never needs a second pass.
3. **V-527 commit-msg hook** (W15 — LANDED, this wave): prevents new V-205 /
   V-211 violations from being committed.
4. **V-528 privatization runbook** (W17): one-command sequence the founder
   triggers tomorrow to flip the GitHub setting + push 3 SDK repos public.
5. **V-205 force-push scrub of historical violators** (`63a20c1`, `ef649a1`):
   runs AFTER the private flip — on a private repo, force-push has zero
   customer-visible blast radius.

## Verification

- Counts from `git ls-files | wc -l` and per-directory `awk -F/` aggregations
  at HEAD `d4cc781`.
- Personal-name leaks confirmed with `git grep -E "Joel|Theunissen"`.
- Sub-processor-disclosure context confirmed with `git grep "Anthropic"
apps/marketing-site/`.
- This document is itself written to `docs/internal/` — the `internal-private`
  cluster — so it carries no anonymity risk of its own.
