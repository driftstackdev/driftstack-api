// W546.C — drift guard for /docs/entity-org-transition.md.
// Platform-side punch list for eenmanszaak → BV transition. Drift
// here either drops the 'don't rename the GitHub org' Go-SDK
// breakage warning (would absolutely break `go get` for any
// imaginary Go customer), changes the 'already neutral' inventory
// (would mislead the founder about what's safe to leave), or
// loosens the 'pause at KvK closure' sequence (would let work
// land before founder has the required entity values).
//
//   • Target date: ~2026-05-21 KvK geruisloze omzetting close.
//   • Founder-track items OUT of scope: legal entity setup, Stripe/
//     Mollie billing entity, ToS authoring entity, Moneybird
//     invoicing.
//   • TL;DR 3-phase sequence (pre-cutover / at-KvK-closure-pause /
//     post-KvK D+1 to D+7).
//   • Already-neutral inventory (LICENSE driftstackdev + 4 package
//     manifest fields + npm @driftstack scope).
//   • DON'T rename the GitHub org — Go module path = GitHub URL;
//     breaking change for any imaginary Go customer.
//   • Coordinated SDK minor bump (api-types 0.2.0 + sdk 0.2.0).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/entity-org-transition.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W546.C /docs/entity-org-transition.md content parity', () => {
  const body = read(LIB);

  it("Header + 2026-05-21-KvK + founder-track-out-of-scope + platform-side-scope framing pinned: '# Entity-org transition — platform-side punch list' + '**Target date:** geruisloze omzetting completes ~2026-05-21 (KvK).' + '**Founder track:** legal entity setup (eenmanszaak → BV), Stripe/Mollie billing entity, ToS authoring entity, Moneybird invoicing — all **out of scope** for this repo per `AGENTS.md`.' + 'This document scopes only the **platform-side configuration** changes — what stuff in this repo + the published artifacts has to shift to reflect the new entity, in what sequence, and what's already neutral so we don't churn it.' — pinned so the 2026-05-21-KvK-geruisloze-omzetting + eenmanszaak-to-BV + 4-founder-track-out-of-scope (legal-entity + Stripe/Mollie + ToS + Moneybird) + AGENTS.md-anchor + platform-side-only-scope commitment survives", () => {
    expect(body).toMatch(/^# Entity-org transition — platform-side punch list$/m);
    expect(body).toMatch(
      /\*\*Target date:\*\* geruisloze omzetting completes ~2026-05-21 \(KvK\)\./,
    );
    expect(body).toMatch(
      /\*\*Founder track:\*\* legal entity setup \(eenmanszaak → BV\), Stripe\/Mollie/,
    );
    expect(body).toMatch(/billing entity, ToS authoring entity, Moneybird invoicing — all/);
    expect(body).toMatch(/\*\*out of scope\*\* for this repo per `AGENTS\.md`\./);
    expect(body).toMatch(/This document scopes only the \*\*platform-side configuration\*\*/);
    expect(body).toMatch(/changes — what stuff in this repo \+ the published artifacts has to/);
    expect(body).toMatch(/shift to reflect the new entity, in what sequence, and what's/);
    expect(body).toMatch(/already neutral so we don't churn it\./);
  });

  it("TL;DR 3-phase sequence framing pinned: '## TL;DR sequence' + '1. **Pre-cutover (now → KvK closure):** confirm current state is neutral (founder name appears nowhere in published metadata). Done — see \"Already neutral\" below. No action needed.' + '2. **At KvK closure:** founder gets KvK number, BTW (VAT) number, final entity name. **Pause here.** Surface to founder; nothing in this repo can be filled in until those values exist.' + '3. **Post-KvK (D+1 to D+7):** apply the punch list below in one commit. Republish all SDKs at a coordinated minor bump (api-types 0.2.0, sdk 0.2.0, etc.) so the entity transition is greppable in the changelog. Ownership transfers on the registry side happen in parallel (founder action; account-level).' — pinned so the 3-phase (pre-cutover-neutral + at-KvK-pause-for-KvK+BTW+entity-name + post-KvK-D+1-to-D+7-coordinated-bump) + greppable-changelog + parallel-registry-ownership-transfer commitment survives", () => {
    expect(body).toMatch(/## TL;DR sequence/);
    expect(body).toMatch(
      /1\.\s+\*\*Pre-cutover \(now → KvK closure\):\*\* confirm current state is/,
    );
    expect(body).toMatch(/neutral \(founder name appears nowhere in published metadata\)\./);
    expect(body).toMatch(/Done — see "Already neutral" below\. No action needed\./);
    expect(body).toMatch(
      /2\.\s+\*\*At KvK closure:\*\* founder gets KvK number, BTW \(VAT\) number,/,
    );
    expect(body).toMatch(/final entity name\. \*\*Pause here\.\*\* Surface to founder; nothing/);
    expect(body).toMatch(/in this repo can be filled in until those values exist\./);
    expect(body).toMatch(
      /3\.\s+\*\*Post-KvK \(D\+1 to D\+7\):\*\* apply the punch list below in one/,
    );
    expect(body).toMatch(/commit\. Republish all SDKs at a coordinated minor bump/);
    expect(body).toMatch(/\(api-types 0\.2\.0, sdk 0\.2\.0, etc\.\) so the entity transition is/);
    expect(body).toMatch(/greppable in the changelog\. Ownership transfers on the registry/);
    expect(body).toMatch(/side happen in parallel \(founder action; account-level\)\./);
  });

  it("Already-neutral inventory framing pinned: '## Already neutral (no action needed)' + 'The publish-yesterday work landed with **founder name appearing nowhere in published metadata**' + '`LICENSE` — `Copyright (c) 2026 driftstackdev`. The string `driftstackdev` is a GitHub org name, not a person's name. The copyright holder string can stay as-is or shift to the entity display name; either reads correctly.' + '`packages/api-types/package.json` — no `author` field. Repo URL points at `github.com/driftstackdev/driftstack-api`. Org-neutral.' + '`packages/sdk-typescript/package.json` — no `author` field. Same repo URL. Org-neutral.' + '`packages/sdk-python/pyproject.toml` — `authors = [{name = \"Driftstack\"}]`. Org-neutral. Repository URL org-neutral.' + 'npm scope `@driftstack` — already minted as the entity-neutral scope. No transfer needed; the org membership is what gets transferred (founder action — see below).' — pinned so the 5-already-neutral inventory (LICENSE + api-types pkg.json + sdk-typescript pkg.json + sdk-python pyproject.toml + npm-@driftstack-scope) + driftstackdev-is-GitHub-org-not-person + neutral-as-baseline commitment survives", () => {
    expect(body).toMatch(/## Already neutral \(no action needed\)/);
    expect(body).toMatch(/The publish-yesterday work landed with \*\*founder name appearing/);
    expect(body).toMatch(/nowhere in published metadata\*\*, so the platform side starts clean:/);
    expect(body).toMatch(/- `LICENSE` — `Copyright \(c\) 2026 driftstackdev`\. The string/);
    expect(body).toMatch(/`driftstackdev` is a GitHub org name, not a person's name\. The/);
    expect(body).toMatch(/copyright holder string can stay as-is or shift to the entity/);
    expect(body).toMatch(/display name; either reads correctly\./);
    expect(body).toMatch(/- `packages\/api-types\/package\.json` — no `author` field\. Repo URL/);
    expect(body).toMatch(/points at `github\.com\/driftstackdev\/driftstack-api`\. Org-neutral\./);
    expect(body).toMatch(/- `packages\/sdk-typescript\/package\.json` — no `author` field\. Same/);
    expect(body).toMatch(/repo URL\. Org-neutral\./);
    expect(body).toMatch(/- `packages\/sdk-python\/pyproject\.toml` — `authors = \[\{name =/);
    expect(body).toMatch(/"Driftstack"\}\]`\. Org-neutral\. Repository URL org-neutral\./);
    expect(body).toMatch(/- npm scope `@driftstack` — already minted as the entity-neutral/);
    expect(body).toMatch(/scope\. No transfer needed; the org membership is what gets/);
    expect(body).toMatch(/transferred \(founder action — see below\)\./);
  });

  it("Go-SDK-don't-rename-GitHub-org framing pinned: '`packages/sdk-go/go.mod` — module path `github.com/driftstackdev/driftstack-api/packages/sdk-go`. The module path is the GitHub URL; renaming the GitHub org would be an absolute breaking change for any imaginary Go customer (`go get` stops resolving). **Don't rename the GitHub org.**' — pinned so the go.mod-is-the-GitHub-URL + absolute-breaking-change + go-get-stops-resolving + Don't-rename-the-GitHub-org commitment survives (drift to renaming the org without bumping the module path would silently break every Go customer's go.mod)", () => {
    expect(body).toMatch(/- `packages\/sdk-go\/go\.mod` — module path/);
    expect(body).toMatch(/`github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go`\. The/);
    expect(body).toMatch(/module path is the GitHub URL; renaming the GitHub org would be/);
    expect(body).toMatch(/an absolute breaking change for any imaginary Go customer/);
    expect(body).toMatch(/\(`go get` stops resolving\)\. \*\*Don't rename the GitHub org\.\*\*/);
  });

  it("Punch-list section-A LICENSE + section-B SDK-metadata framing pinned: '## Punch list — apply at KvK closure' + '### A. Update `LICENSE` (one line, all packages)' + 'If the founder wants to reflect the BV's legal name in the copyright line, change `Copyright (c) 2026 driftstackdev` to `Copyright (c) 2026 <Entity B.V.>`.' + 'Either form is legally defensible for MIT — `driftstackdev` is the GitHub org name, which courts have routinely accepted as the copyright holder string.' + '**Decision lives with founder.** No-op is fine; explicit name is cleaner.' + '### B. SDK package metadata (optional, but tidy)' + 'Add explicit `author` / `maintainer` fields with the entity name + contact email (BV's support address, not founder's personal email)' + 'support@driftstack.dev' + 'https://driftstack.io' — pinned so the 2-punch-list-section (A-LICENSE-optional + B-SDK-metadata-optional-but-tidy) + Entity-B.V.-placeholder + MIT-court-acceptable-org-name + support@driftstack.dev not-founder-personal-email commitment survives", () => {
    expect(body).toMatch(/## Punch list — apply at KvK closure/);
    expect(body).toMatch(/### A\. Update `LICENSE` \(one line, all packages\)/);
    expect(body).toMatch(/If the founder wants to reflect the BV's legal name in the copyright/);
    expect(body).toMatch(/line, change `Copyright \(c\) 2026 driftstackdev` to/);
    expect(body).toMatch(/`Copyright \(c\) 2026 <Entity B\.V\.>`\./);
    expect(body).toMatch(/Either form is legally/);
    expect(body).toMatch(/defensible for MIT — `driftstackdev` is the GitHub org name, which/);
    expect(body).toMatch(/courts have routinely accepted as the copyright holder string\./);
    expect(body).toMatch(/\*\*Decision lives with founder\.\*\* No-op is fine; explicit name is/);
    expect(body).toMatch(/cleaner\./);
    expect(body).toMatch(/### B\. SDK package metadata \(optional, but tidy\)/);
    expect(body).toMatch(/Add explicit `author` \/ `maintainer` fields with the entity name \+/);
    expect(body).toMatch(/contact email \(BV's support address, not founder's personal email\):/);
    expect(body).toMatch(/"email": "support@driftstack\.dev"/);
    expect(body).toMatch(/"url": "https:\/\/driftstack\.io"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
