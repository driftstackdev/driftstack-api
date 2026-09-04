# Entity-org transition — platform-side punch list

**Target date:** geruisloze omzetting completes ~2026-05-21 (KvK).
**Founder track:** legal entity setup (eenmanszaak → BV), Stripe/Mollie
billing entity, ToS authoring entity, Moneybird invoicing — all
**out of scope** for this repo per `AGENTS.md`.

This document scopes only the **platform-side configuration**
changes — what stuff in this repo + the published artifacts has to
shift to reflect the new entity, in what sequence, and what's
already neutral so we don't churn it.

## TL;DR sequence

1. **Pre-cutover (now → KvK closure):** confirm current state is
   neutral (founder name appears nowhere in published metadata).
   Done — see "Already neutral" below. No action needed.
2. **At KvK closure:** founder gets KvK number, BTW (VAT) number,
   final entity name. **Pause here.** Surface to founder; nothing
   in this repo can be filled in until those values exist.
3. **Post-KvK (D+1 to D+7):** apply the punch list below in one
   commit. Republish all SDKs at a coordinated minor bump
   (api-types 0.2.0, sdk 0.2.0, etc.) so the entity transition is
   greppable in the changelog. Ownership transfers on the registry
   side happen in parallel (founder action; account-level).

## Already neutral (no action needed)

The publish-yesterday work landed with **founder name appearing
nowhere in published metadata**, so the platform side starts clean:

- `LICENSE` — `Copyright (c) 2026 driftstackdev`. The string
  `driftstackdev` is a GitHub org name, not a person's name. The
  copyright holder string can stay as-is or shift to the entity
  display name; either reads correctly.
- `packages/api-types/package.json` — no `author` field. Repo URL
  points at `github.com/driftstackdev/driftstack-api`. Org-neutral.
- `packages/sdk-typescript/package.json` — no `author` field. Same
  repo URL. Org-neutral.
- `packages/sdk-python/pyproject.toml` — `authors = [{name =
"Driftstack"}]`. Org-neutral. Repository URL org-neutral.
- `packages/sdk-go/go.mod` — module path
  `github.com/driftstackdev/driftstack-api/packages/sdk-go`. The
  module path is the GitHub URL; renaming the GitHub org would be
  an absolute breaking change for any imaginary Go customer
  (`go get` stops resolving). **Don't rename the GitHub org.**
- README files across all SDKs — neutral phrasing ("Driftstack",
  "Driftstack API", no founder name).
- npm scope `@driftstack` — already minted as the entity-neutral
  scope. No transfer needed; the org membership is what gets
  transferred (founder action — see below).

## Punch list — apply at KvK closure

### A. Update `LICENSE` (one line, all packages)

If the founder wants to reflect the BV's legal name in the copyright
line, change `Copyright (c) 2026 driftstackdev` to
`Copyright (c) 2026 <Entity B.V.>`. Either form is legally
defensible for MIT — `driftstackdev` is the GitHub org name, which
courts have routinely accepted as the copyright holder string.
**Decision lives with founder.** No-op is fine; explicit name is
cleaner.

### B. SDK package metadata (optional, but tidy)

Add explicit `author` / `maintainer` fields with the entity name +
contact email (BV's support address, not founder's personal email):

```jsonc
// packages/api-types/package.json + packages/sdk-typescript/package.json
"author": {
  "name": "<Entity B.V.>",
  "email": "support@driftstack.dev",
  "url": "https://driftstack.io"
}
```

```toml
# packages/sdk-python/pyproject.toml — replace the existing authors line
authors = [
  { name = "<Entity B.V.>", email = "support@driftstack.dev" }
]
```

Go's `go.mod` has no author field; the module path is the only
identity. Skip.

### C. Tauri bundle identifier — **leave alone**

`apps/gui-client/src-tauri/tauri.conf.json` declares
`identifier: "dev.driftstack.gui"`. This is the macOS bundle
identifier. **Don't change it.** Renaming invalidates every existing
install's local store
(`~/Library/Application Support/dev.driftstack.gui/...`), forcing
the founder + any pre-launch testers to re-enter API keys + proxy
configs. The identifier already follows reverse-DNS convention and
is org-neutral (no person name embedded). Leave.

### D. Apple Developer signing identity — founder action

The `APPLE_SIGNING_IDENTITY` env var in `PACKAGING.md` references
the founder's personal cert ("Developer ID Application: Joël
Theunissen (XXXXXXXXXX)"). Post-KvK, the BV mints its own
Developer ID cert and the env var swaps. No code change in this
repo — just an updated value in the founder's `~/.driftstack/build.env`.

Notarisation env vars (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
similarly swap from personal Apple ID to the BV's Developer Program
account.

### E. Registry account ownership transfers — founder action

These are **account-level** transfers, not file-level edits. The
founder does these via the registry web UIs after KvK closure:

| Registry                   | Current owner                                    | Transfer to                                                              |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| npm `@driftstack` org      | personal `joeltheunissen89-alt` (org admin)      | BV-owned account; add as org admin, remove personal account              |
| PyPI `driftstack-sdk`      | personal account                                 | BV-owned PyPI account; transfer ownership via Account Settings → Members |
| Go modules                 | (no central registry; Go modules are git-tagged) | n/a — module path stays                                                  |
| GitHub `driftstackdev` org | personal (org admin)                             | BV-owned GitHub account; add as org admin, remove personal               |
| Apple Developer Program    | personal                                         | BV-owned (separate enrolment, $99/yr)                                    |

The founder owns each of these transitions; no agent action. Just
flagging here so the V-log entry that records the transition has a
canonical checklist.

### F. CHANGELOG — record the entity transition

Add a minor-bump entry to each SDK's CHANGELOG noting the entity
transfer date + the registry-ownership swap. Same shape as a normal
release. Suggested wording:

> ## 0.2.0 — 2026-MM-DD
>
> Entity-org transition: package authorship + LICENSE copyright now
> reference `<Entity B.V.>`. No code or wire-format changes; this is
> a housekeeping bump to align with the entity registration.

(TS SDK has no CHANGELOG yet — see contract audit finding C from
2026-05-03; adding it before this transition is convenient timing.)

## Risks / surprises

1. **GitHub org rename = nuclear**. `go.mod` modules pin the GitHub
   URL as the import path. Renaming `driftstackdev` to anything else
   silently breaks `go get` for every Go customer. **Decision:**
   keep the GitHub org name `driftstackdev` regardless of the BV's
   legal name. The org-name is technical infrastructure, not a
   trademark statement.

2. **npm package rename = nuclear**. Same logic — `@driftstack/sdk`
   is the import name customers call. Don't rename.

3. **Account-ownership transfers create a window** where the founder's
   personal account loses publish rights and the BV's account
   doesn't yet have them. Sequence: add BV account as co-owner FIRST,
   then remove personal AFTER the BV publishes its first release.
   Don't atomic-swap.

4. **PyPI ownership transfer requires the new owner to confirm** by
   clicking an email link. Schedule the transfer when both
   keychains/inboxes are reachable.

5. **Local Tauri stores survive** the transition because the
   identifier stays `dev.driftstack.gui`. The founder's API key +
   proxy configs persist seamlessly.

## What's already in motion that this transition can ride along with

- TS SDK CHANGELOG (audit finding C) — add it during the entity
  bump rather than as a separate one-off.
- drizzle-kit upgrade (audit finding C) — independent; do whenever.

## Surface to founder

Two questions before applying the punch list:

1. **Final BV name + KvK number + BTW number** — paste when
   available; the agent fills them in across LICENSE + package
   metadata in one commit.
2. **Support email decision** — `support@driftstack.dev` assumed.
   Confirm the actual support address (or skip the email field if
   the founder prefers issues-only via GitHub).

Status: **scoped, awaiting KvK closure**. Punch list is small enough
that the post-closure commit lands in one session.
