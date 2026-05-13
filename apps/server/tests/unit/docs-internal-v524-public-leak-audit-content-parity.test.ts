// W578.B — drift guard for /docs/internal/v524-public-leak-audit.md.
// V-524 driftstack-api public-repo leak audit, dated 2026-05-10 at
// HEAD `d4cc781`. Drift here either shifts the 911-file enumeration,
// flips the 5-bucket classification taxonomy, loses an `internal-
// private` verdict on a cluster that must NOT be public, or unsets
// the option-(a)-PRIVATIZE recap that gates V-525 / V-526 / V-528.
//
//   • 911 total tracked files audited 2026-05-10 at HEAD d4cc781.
//   • 5-bucket taxonomy: customer-facing-keep / internal-private /
//     extract-to-sdk-repo / delete-entirely / sanitize-then-keep.
//   • ~88 internal-private + ~157 extract-to-sdk-repo + ~75 sanitize-
//     then-keep + ~591 customer-facing-keep + ~0 delete-entirely.
//   • 11 per-cluster classification tables (root configs + .github/ +
//     infra/ + apps/server/ + admin/status/dashboard frontends + apps/
//     marketing-site + apps/docs + apps/gui-client + packages/sdk-* +
//     other packages/ + docs/ + scripts/perf/.husky).
//   • V-211 + V-205 string-leak findings catalogued (3 personal-name
//     files; Claude / Anthropic split into product-disclosure-KEEP vs
//     internal-private).
//   • Option-(a)-PRIVATIZE recap + 5-step next-steps (V-525 / V-526 /
//     V-527 LANDED / V-528 / force-push-scrub).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v524-public-leak-audit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W578.B /docs/internal/v524-public-leak-audit.md content parity', () => {
  const body = read(LIB);

  it('Header + Date-2026-05-10 + HEAD-d4cc781 + 911-file enumeration + V-525/V-526/V-528-gating + 5-bucket-taxonomy + summary-counts + option-(a)-net-effect framing pinned', () => {
    expect(body).toMatch(/^# V-524 — driftstack-api public-repo leak audit$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-10/);
    expect(body).toMatch(/\*\*HEAD audited:\*\* `d4cc781`/);
    expect(body).toMatch(/\*\*Total tracked files:\*\* 911/);
    expect(body).toMatch(
      /\*\*Purpose:\*\* classify every file currently exposed in the driftstack-api/,
    );
    expect(body).toMatch(
      /public GitHub repo, to inform the V-525 extraction plan, V-526 sanitization/,
    );
    expect(body).toMatch(
      /sweep, and V-528 privatization runbook\. \*\*Staging only — no acts performed/,
    );
    expect(body).toMatch(/by this audit\.\*\*/);
    expect(body).toMatch(/## Classification taxonomy/);
    expect(body).toMatch(
      /\| `customer-facing-keep` \| Legitimate public artifact; stays as-is \(no internal-string sweep needed beyond V-526\)\. \|/,
    );
    expect(body).toMatch(
      /\| `internal-private`\s+\| Must NOT exist in any public repo\. Privatize repo OR delete entirely from public scope\. \|/,
    );
    expect(body).toMatch(
      /\| `extract-to-sdk-repo`\s+\| Belongs in a standalone public SDK repo \(V-525 extraction plan target\)\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `delete-entirely`\s+\| Not useful in any repo \(test scaffolding, stale audits\)\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `sanitize-then-keep`\s+\| Public-suitable in principle, but contains internal\/anonymity strings — V-526 scrubs\.\s+\|/,
    );
    expect(body).toMatch(/## Summary counts/);
    expect(body).toMatch(/\| `internal-private`\s+\|\s+~88 \|\s+9\.7 \|/);
    expect(body).toMatch(/\| `extract-to-sdk-repo`\s+\|\s+~157 \|\s+17\.2 \|/);
    expect(body).toMatch(/\| `sanitize-then-keep`\s+\|\s+~75 \|\s+8\.2 \|/);
    expect(body).toMatch(/\| `customer-facing-keep` \|\s+~591 \|\s+64\.9 \|/);
    expect(body).toMatch(/\| `delete-entirely`\s+\|\s+~0 \|\s+0\.0 \|/);
    expect(body).toMatch(
      /\*\*Net effect under founder-locked option \(a\) PRIVATIZE \+ extract 3 SDK repos:\*\*/,
    );
    expect(body).toMatch(/- driftstack-api flips private → 911 files stop being public\./);
    expect(body).toMatch(
      /- 3 new public SDK repos materialize → ~157 files become the only public surface\./,
    );
    expect(body).toMatch(
      /- ~75 sanitize-then-keep files are scrubbed for V-211\/V-205 compliance regardless/,
    );
    expect(body).toMatch(
      /of repo posture \(defense-in-depth so a future re-public-flip is safe\)\./,
    );
  });

  it('Cluster 1 (root configs + meta) + Cluster 2 (.github/ CI) + Cluster 3 (infra/) framing pinned: LICENSE-keep + AGENTS.md-internal + .env.example-sanitize + status.md-internal + 10 workflow files internal + infra/ Hetzner-internal', () => {
    expect(body).toMatch(/## Per-cluster classification/);
    expect(body).toMatch(/### Cluster 1 — root configs \+ meta \(16 files\)/);
    expect(body).toMatch(/\| `LICENSE`\s+\| `customer-facing-keep` \| Standard\.\s+\|/);
    expect(body).toMatch(
      /\| `README\.md`\s+\| `sanitize-then-keep`\s+\| First-impression file; founder\/anonymity sweep \+ AI-process scrub\. \|/,
    );
    expect(body).toMatch(
      /\| `AGENTS\.md`\s+\| `internal-private`\s+\| Documents internal agent posture; not customer-facing\.\s+\|/,
    );
    expect(body).toMatch(/\| `package\.json`\s+\| `customer-facing-keep` \| npm metadata\.\s+\|/);
    expect(body).toMatch(
      /\| `\.env\.example`\s+\| `sanitize-then-keep`\s+\| May include V-NNN refs in comments\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `status\.md`\s+\| `internal-private`\s+\| Live ops status; never customer-facing\.\s+\|/,
    );
    expect(body).toMatch(/### Cluster 2 — `\.github\/` CI \+ ops \(10 files\)/);
    expect(body).toMatch(
      /CI workflows reference internal infra \(Hetzner SSH hosts, Cloudflare account/,
    );
    expect(body).toMatch(
      /IDs as secrets\) but the secret VALUES are not in the file — only secret NAMES\./,
    );
    expect(body).toMatch(
      /Most are `sanitize-then-keep` to scrub V-NNN refs in inline comments\. None/,
    );
    expect(body).toMatch(
      /need to be in any public repo for SDK distribution; bucket them collectively/,
    );
    expect(body).toMatch(/`internal-private` under the option-\(a\) verdict\./);
    expect(body).toMatch(/\| `\.github\/dependabot\.yml`\s+\| `internal-private` \|/);
    expect(body).toMatch(/\| `\.github\/workflows\/ci\.yml`\s+\| `internal-private` \|/);
    expect(body).toMatch(
      /\| `\.github\/workflows\/dependabot-auto-merge\.yml`\s+\| `internal-private` \|/,
    );
    expect(body).toMatch(/\| `\.github\/workflows\/server-deploy\.yml`\s+\| `internal-private` \|/);
    expect(body).toMatch(/### Cluster 3 — `infra\/` \(9 files\)/);
    expect(body).toMatch(
      /\| `infra\/` \| `internal-private` \| Hetzner-specific provisioning; never customer-facing\. \|/,
    );
  });

  it('Cluster 4 (apps/server/) + Cluster 5 (admin/status/dashboard) + Cluster 6 (marketing + docs) + Cluster 7 (gui-client) + Cluster 8 (sdk-* extract target) framing pinned: 321 server internal + 62 admin/dashboard internal + 87 marketing/docs sanitize + 104 gui-client internal + 157 sdk-* extract + DPA Annex 3 Anthropic sub-processor disclosure required', () => {
    expect(body).toMatch(/### Cluster 4 — `apps\/server\/` \(321 files\)/);
    expect(body).toMatch(
      /The Fastify control plane source\. Closed-source product code by intent\./,
    );
    expect(body).toMatch(
      /\| `internal-private` \|\s+~321 \| Customers consume the API over the wire; source not part of the deliverable\. \|/,
    );
    expect(body).toMatch(
      /### Cluster 5 — `apps\/admin-panel\/` \(21 files\), `apps\/status-site\/` \(9 files\), `apps\/customer-dashboard\/` \(32 files\)/,
    );
    expect(body).toMatch(
      /\| `internal-private` \|\s+~62 \| Internal UIs \(admin\) \+ customer-portal frontends; binaries ship via CDN\. \|/,
    );
    expect(body).toMatch(
      /### Cluster 6 — `apps\/marketing-site\/` \(37 files\), `apps\/docs\/` \(50 files\)/,
    );
    expect(body).toMatch(
      /Customer-facing copy\. Marketing-site copy contains sub-processor disclosures/,
    );
    expect(body).toMatch(
      /that REFERENCE Anthropic \(required per DPA Annex 3 — bundled-LLM feature\)\./,
    );
    expect(body).toMatch(/These are product disclosures, not AI-tooling references — they stay\./);
    expect(body).toMatch(
      /\| `sanitize-then-keep` \|\s+~87 \| Public copy lives as built artifacts on CDN; source stays private under opt \(a\)\. \|/,
    );
    expect(body).toMatch(
      /Under option \(a\): marketing-site \+ docs source live in driftstack-api private,/,
    );
    expect(body).toMatch(
      /deploy artifacts publish to Cloudflare Pages\. No public-source mirror needed\./,
    );
    expect(body).toMatch(/### Cluster 7 — `apps\/gui-client\/` \(104 files\)/);
    expect(body).toMatch(
      /Tauri client\. Binaries distribute via GitHub Releases on a separate public/,
    );
    expect(body).toMatch(
      /repo \(`driftstack-gui-releases`\) for autoupdate signing; source stays in the/,
    );
    expect(body).toMatch(/private `driftstack-api` monorepo\./);
    expect(body).toMatch(
      /\| `internal-private` \|\s+~104 \| Source private; releases public via separate repo \(V-525 follow-up scope\)\. \|/,
    );
    expect(body).toMatch(
      /### Cluster 8 — `packages\/sdk-\*` \(157 files: TS=53, Python=56, Go=48\)/,
    );
    expect(body).toMatch(
      /\*\*This is the V-525 extraction target\.\*\* Each SDK becomes its own standalone/,
    );
    expect(body).toMatch(/public repo \(`driftstack-typescript-sdk` \/ `driftstack-python-sdk` \//);
    expect(body).toMatch(
      /`driftstack-go-sdk`\)\. Each repo contains: `src\/`, `tests\/`, `README\.md`,/,
    );
    expect(body).toMatch(
      /`LICENSE`, `CHANGELOG\.md`, `\.github\/workflows\/` \(publish to npm\/PyPI\/Go module/,
    );
    expect(body).toMatch(/registry\)\. No internal docs, no V-NNN refs\./);
    expect(body).toMatch(
      /\| `packages\/sdk-typescript\/` \| `extract-to-sdk-repo` \| `driftstack-typescript-sdk` \|/,
    );
    expect(body).toMatch(
      /\| `packages\/sdk-python\/`\s+\| `extract-to-sdk-repo` \| `driftstack-python-sdk`\s+\|/,
    );
    expect(body).toMatch(
      /\| `packages\/sdk-go\/`\s+\| `extract-to-sdk-repo` \| `driftstack-go-sdk`\s+\|/,
    );
    expect(body).toMatch(
      /V-526 sanitization sweep runs against each SDK before extraction — V-NNN log/,
    );
    expect(body).toMatch(/references, founder framing, and AI-process prose must be zero in the/);
    expect(body).toMatch(/extracted repos\./);
  });

  it('Cluster 9 (other packages/) + Cluster 10 (docs/ highest-risk) + Cluster 11 (scripts/perf/.husky) framing pinned: api-types/behavioural-simulation/recipe-library/recapture-automation/webrtc-streaming/webhook-delivery internal + 22 docs/ rows internal + scripts/perf/.husky internal', () => {
    expect(body).toMatch(/### Cluster 9 — other `packages\/` \(54 files\)/);
    expect(body).toMatch(
      /\| `packages\/api-types\/`\s+\| `internal-private` \| Shared types; consumed by server \+ SDKs\. Each SDK bundles its own copy of generated types\. \|/,
    );
    expect(body).toMatch(
      /\| `packages\/behavioural-simulation\/` \| `internal-private` \| Core differentiation; private package\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `packages\/recipe-library\/`\s+\| `internal-private` \| Phase 3\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `packages\/recapture-automation\/`\s+\| `internal-private` \| Phase 3\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `packages\/webrtc-streaming\/`\s+\| `internal-private` \| Phase 3\.\s+\|/,
    );
    expect(body).toMatch(
      /\| `packages\/webhook-delivery\/`\s+\| `internal-private` \| Server-side delivery primitives\.\s+\|/,
    );
    expect(body).toMatch(/### Cluster 10 — `docs\/` \(75 files\)/);
    expect(body).toMatch(/Highest-risk cluster for leaks\. Most files are explicitly internal\./);
    expect(body).toMatch(/\| `docs\/CAPABILITIES\.md`\s+\| `internal-private`\s+\|/);
    expect(body).toMatch(/\| `docs\/architecture\.md`\s+\| `internal-private`\s+\|/);
    expect(body).toMatch(/\| `docs\/architecture\/` \(10 files\)\s+\| `internal-private`\s+\|/);
    expect(body).toMatch(/\| `docs\/adr\/` \(7 files\)\s+\| `internal-private`\s+\|/);
    expect(body).toMatch(/\| `docs\/api\/` \(1 file\)\s+\| `sanitize-then-keep` \|/);
    expect(body).toMatch(/\| `docs\/legal\/` \(7 files\)\s+\| `internal-private`\s+\|/);
    expect(body).toMatch(/\| `docs\/verification-log\.md`\s+\| `internal-private`\s+\|/);
    expect(body).toMatch(
      /### Cluster 11 — `scripts\/` \(5 files\) \+ `perf\/` \(5 files\) \+ `\.husky\/` \(2 files\)/,
    );
    expect(body).toMatch(/\| `scripts\/` \| `internal-private` \|/);
    expect(body).toMatch(/\| `perf\/`\s+\| `internal-private` \|/);
    expect(body).toMatch(/\| `\.husky\/`\s+\| `internal-private` \|/);
  });

  it('V-211 personal-name leaks + V-205 AI-tooling-vs-DPA-sub-processor split + Anthropic-bundled-LLM KEEP + V-205 enforcement-comments KEEP + option-(a)-PRIVATIZE recap + V-525-extraction + V-526-sanitize + V-527-LANDED + V-528-runbook + force-push-scrub-after-private-flip + verification-method framing pinned', () => {
    expect(body).toMatch(/## V-211 \+ V-205 string-leak findings \(input to V-526\)/);
    expect(body).toMatch(/### Personal-name leaks \(V-211\)/);
    expect(body).toMatch(/Three files contain personal-name strings:/);
    expect(body).toMatch(
      /\| `docs\/entity-org-transition\.md` \(line 104\)\s+\| KvK \/ BV minting flow — operational engineering\.\s+\| Move to private docs-tree; never publish\. \|/,
    );
    expect(body).toMatch(
      /\| `docs\/marketing\/dashboard-admin-visual-audit\.md` \(188, 250\) \| Self-referential audit — confirming the codebase has zero personal-name strings \(META\)\. \| Scrub for irony — replace `Joël/,
    );
    expect(body).toMatch(
      /\| `docs\/verification-log\.md` \(line 11864\)\s+\| Historical V-log entry recording a prior sanitization\.\s+\| Move to private docs-tree; never publish\. \|/,
    );
    expect(body).toMatch(/### AI-tooling vs sub-processor disclosure/);
    expect(body).toMatch(/`Claude` \/ `Anthropic` occurrences split into:/);
    expect(body).toMatch(
      /\| Sub-processor \/ DPA Annex 3 \(`apps\/marketing-site\/src\/data\/sub-processors\.ts`, `apps\/marketing-site\/src\/pages\/legal\/dpa\.md`, `apps\/marketing-site\/src\/pages\/legal\/privacy\.md`\) \| KEEP — required product disclosure for bundled-LLM\.\s+\|/,
    );
    expect(body).toMatch(
      /\| Guard comments \(`apps\/gui-client\/src\/views\/FirstRunWizard\.tsx`\)\s+\| KEEP — they ARE the V-205 enforcement, not violations\.\s+\|/,
    );
    expect(body).toMatch(
      /\| AGENTS\.md sub-processor listing\s+\| KEEP — internal doc, but stays accurate\.\s+\|/,
    );
    expect(body).toMatch(
      /\| Internal V-log references\s+\| `internal-private` cluster covers — moves to private tree\. \|/,
    );
    expect(body).toMatch(
      /Net: zero AI-tooling references in customer-facing surfaces; all `Anthropic`/,
    );
    expect(body).toMatch(/mentions on the marketing site are sub-processor disclosure\./);
    expect(body).toMatch(/## Founder-locked decision \(recap\)/);
    expect(body).toMatch(
      /Option \*\*\(a\) PRIVATIZE driftstack-api \+ extract 3 SDK repos\*\* was selected/,
    );
    expect(body).toMatch(
      /over option \(b\) ruthless in-place cleanup\. This audit's bucket counts confirm/,
    );
    expect(body).toMatch(
      /why: 88\+ files are unambiguously `internal-private` and would require either/,
    );
    expect(body).toMatch(
      /deletion \(loses engineering history\) or force-push scrub \(high-risk on a/,
    );
    expect(body).toMatch(
      /paying-customer-pending repo\)\. Privatization is a single atomic operation/,
    );
    expect(body).toMatch(/with reversible blast radius\./);
    expect(body).toMatch(/## Next steps \(gated on founder review tomorrow\)/);
    expect(body).toMatch(
      /1\. \*\*V-525 extraction plan\*\* \(W16\): generate `driftstack-typescript-sdk` \//,
    );
    expect(body).toMatch(
      /`driftstack-python-sdk` \/ `driftstack-go-sdk` as branches in the current/,
    );
    expect(body).toMatch(/repo, ready to push to fresh GitHub repos\./);
    expect(body).toMatch(
      /2\. \*\*V-526 sanitization sweep\*\* \(W17\): scrub the ~75 `sanitize-then-keep`/,
    );
    expect(body).toMatch(
      /files even though they end up in a private repo, so a future SDK-extract/,
    );
    expect(body).toMatch(/never needs a second pass\./);
    expect(body).toMatch(
      /3\. \*\*V-527 commit-msg hook\*\* \(W15 — LANDED, this wave\): prevents new V-205 \//,
    );
    expect(body).toMatch(/V-211 violations from being committed\./);
    expect(body).toMatch(
      /4\. \*\*V-528 privatization runbook\*\* \(W17\): one-command sequence the founder/,
    );
    expect(body).toMatch(
      /triggers tomorrow to flip the GitHub setting \+ push 3 SDK repos public\./,
    );
    expect(body).toMatch(
      /5\. \*\*V-205 force-push scrub of historical violators\*\* \(`63a20c1`, `ef649a1`\):/,
    );
    expect(body).toMatch(/runs AFTER the private flip — on a private repo, force-push has zero/);
    expect(body).toMatch(/customer-visible blast radius\./);
    expect(body).toMatch(/## Verification/);
    expect(body).toMatch(
      /- Counts from `git ls-files \| wc -l` and per-directory `awk -F\/` aggregations/,
    );
    expect(body).toMatch(/at HEAD `d4cc781`\./);
    expect(body).toMatch(/- Personal-name leaks confirmed with `git grep -E "Joel\|Theunissen"`\./);
    expect(body).toMatch(/- Sub-processor-disclosure context confirmed with `git grep "Anthropic"/);
    expect(body).toMatch(/apps\/marketing-site\/`\./);
    expect(body).toMatch(
      /- This document is itself written to `docs\/internal\/` — the `internal-private`/,
    );
    expect(body).toMatch(/cluster — so it carries no anonymity risk of its own\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
