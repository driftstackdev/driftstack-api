// W561 — drift guard for /docs/architecture/v294-feature-catalog.md.
// V-294 production-ready scope catalog. Drift here either weakens the
// 213-feature-survey + every-previously-deferred-ships-in-v1 founder
// direction, drops the 6-status-taxonomy (SHIPPED/IN-FLIGHT/DEFERRED/
// UNDISCOVERED/AGENT-1/OUT-OF-SCOPE), or unsets the 67-slice V-295+
// arc commitment + 6-open-question pre-codegen-scope-review gate.
//
//   • V-294. 213 features surveyed across 12 surface categories.
//   • 6-status taxonomy.
//   • ~297 Tier-1 hours / ~50 working days / ~10 weeks arc.
//   • 4-tier priority order: customer-trust → admin → SDK → ops.
//   • Surface 1-12 inventory.
//   • 8 out-of-scope items.
//   • 6 open questions for founder Tier-2 ack; V-295+ does NOT START
//     until verdicts land.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/v294-feature-catalog.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W561 /docs/architecture/v294-feature-catalog.md content parity', () => {
  const body = read(LIB);

  it("Header + Source + Purpose + every-previously-deferred-ships-in-v1 framing pinned: '# V-294 — Feature catalog (production-ready scope)' + '**Source**: Comprehensive survey of `/Users/john/Downloads/driftstack-planning 2/` (132 planning files, files 00-131).' + 'Cross-referenced against `docs/verification-log.md` (V-001 → V-293) + `docs/launch/pre-launch-checklist.md` (V-287 refresh)' + '**Purpose**: Single load-bearing scope artifact for the V-295+ multi-week production-ready arc.' + 'Founder direction 2026-05-07 retired the deferred-post-launch pattern; every previously-deferred feature ships in v1 unless V-294 surfaces it as legitimately out-of-scope.' — pinned so the V-294-header + 132-planning-files-00-131 + V-001→V-293-verification-log-cross-ref + V-287-pre-launch-checklist-refresh + 2026-05-07-founder-direction + every-previously-deferred-ships-in-v1 commitment survives", () => {
    expect(body).toMatch(/^# V-294 — Feature catalog \(production-ready scope\)$/m);
    expect(body).toMatch(
      /\*\*Source\*\*: Comprehensive survey of `\/Users\/john\/Downloads\/driftstack-planning 2\/` \(132 planning files, files 00-131\)\./,
    );
    expect(body).toMatch(
      /Cross-referenced against `docs\/verification-log\.md` \(V-001 → V-293\) \+ `docs\/launch\/pre-launch-checklist\.md` \(V-287 refresh\)/,
    );
    expect(body).toMatch(
      /\*\*Purpose\*\*: Single load-bearing scope artifact for the V-295\+ multi-week production-ready arc\./,
    );
    expect(body).toMatch(
      /Founder direction 2026-05-07 retired the deferred-post-launch pattern; every previously-deferred feature ships in v1 unless V-294 surfaces it as legitimately out-of-scope\./,
    );
  });

  it("6-status-taxonomy framing pinned: '## Status taxonomy' + '**SHIPPED** — exists on `main`; verified by passing tests + passing lint + at least one V-NNN log entry covering it.' + '**IN-FLIGHT** — partial implementation on `main`; V-NNN entry exists but feature is not customer-complete.' + '**DEFERRED** — known-needed; not yet started; targeted by V-295+ slice.' + '**UNDISCOVERED** — referenced in planning files but never started + not in current V-NNN backlog.' + '**AGENT-1** — feature lives in the WebKit-fork repo (Agent 1 territory); Agent 2 doesn't ship.' + '**OUT-OF-SCOPE** — surveyed but explicitly cut from v1 (e.g. enterprise-tier-only, post-launch growth, year-2 ambition).' — pinned so the 6-status-taxonomy (SHIPPED + IN-FLIGHT + DEFERRED + UNDISCOVERED + AGENT-1 + OUT-OF-SCOPE) definitions + Agent-1-WebKit-fork commitment survives", () => {
    expect(body).toMatch(/## Status taxonomy/);
    expect(body).toMatch(
      /- \*\*SHIPPED\*\* — exists on `main`; verified by passing tests \+ passing lint \+ at least one V-NNN log entry covering it\./,
    );
    expect(body).toMatch(
      /- \*\*IN-FLIGHT\*\* — partial implementation on `main`; V-NNN entry exists but feature is not customer-complete\./,
    );
    expect(body).toMatch(
      /- \*\*DEFERRED\*\* — known-needed; not yet started; targeted by V-295\+ slice\./,
    );
    expect(body).toMatch(
      /- \*\*UNDISCOVERED\*\* — referenced in planning files but never started \+ not in current V-NNN backlog\./,
    );
    expect(body).toMatch(
      /- \*\*AGENT-1\*\* — feature lives in the WebKit-fork repo \(Agent 1 territory\); Agent 2 doesn't ship\./,
    );
    expect(body).toMatch(
      /- \*\*OUT-OF-SCOPE\*\* — surveyed but explicitly cut from v1 \(e\.g\. enterprise-tier-only, post-launch growth, year-2 ambition\)\./,
    );
  });

  it("Aggregate-scope + ~297-hour-~10-week framing pinned: '## Aggregate scope summary' + '**Total features surveyed**: 213 (across 12 surface categories).' + '| SHIPPED      | 87' + '| IN-FLIGHT    | 6' + '| DEFERRED     | 41' + '| UNDISCOVERED | 53' + '| AGENT-1      | 18' + '| OUT-OF-SCOPE | 8' + '**Aggregate Agent-2 launch scope**: ~297 Tier-1 hours of feature work + ~31 legal page updates spread across the V-295+ slice arc.' + 'At 6h/day sustained = ~50 working days = ~10 weeks.' + 'V-294 catalog refines upward to ~10 weeks once UNDISCOVERED features are folded in.' + 'This converges with Agent 1's V-383+ multi-week native-pipeline-alignment arc (4-12 weeks)' — pinned so the 213-features-12-surface + 6-status-count (87+6+41+53+18+8) + ~297-Tier-1-hour + ~50-days-~10-weeks + Agent-1-V-383+-4-12-week-converge commitment survives", () => {
    expect(body).toMatch(/## Aggregate scope summary/);
    expect(body).toMatch(/\*\*Total features surveyed\*\*: 213 \(across 12 surface categories\)\./);
    expect(body).toMatch(/\| SHIPPED\s+\| 87/);
    expect(body).toMatch(/\| IN-FLIGHT\s+\| 6/);
    expect(body).toMatch(/\| DEFERRED\s+\| 41/);
    expect(body).toMatch(/\| UNDISCOVERED \| 53/);
    expect(body).toMatch(/\| AGENT-1\s+\| 18/);
    expect(body).toMatch(/\| OUT-OF-SCOPE \| 8/);
    expect(body).toMatch(
      /\*\*Aggregate Agent-2 launch scope\*\*: ~297 Tier-1 hours of feature work \+ ~31 legal page updates spread across the V-295\+ slice arc\./,
    );
    expect(body).toMatch(/At 6h\/day sustained = ~50 working days = ~10 weeks\./);
    expect(body).toMatch(
      /V-294 catalog refines upward to ~10 weeks once UNDISCOVERED features are folded in\./,
    );
    expect(body).toMatch(
      /This converges with Agent 1's V-383\+ multi-week native-pipeline-alignment arc \(4-12 weeks\)/,
    );
  });

  it("4-tier priority order framing pinned: '## Recommended priority order (V-295+ slice sequencing)' + 'founder-facing trust first; admin tooling second; SDK feature parity third; ops maturity fourth' + '### Tier 1 — Customer-facing trust + completeness (~85h, ~22 slices)' + '**V-295** Status page (3-4d / 24h) — `status.driftstack.dev`' + '**V-296** API key rotation flow' + '**V-301** MFA / TOTP setup + recovery codes (security gate per planning file 47).' + '**V-305** Tauri custom URL scheme `driftstack://auth/callback` (replaces V-268 polling per V-262 deferral).' + '**V-306** GUI client: live session WebRTC stream (LiveKit integration; planning file 36).' + '### Tier 2 — Admin / ops tooling (~75h, ~18 slices)' + '**V-317** Browser-driving admin-panel Playwright tests' + '**V-333** Admin: separate auth from customer dashboard (email + password + mandatory TOTP per planning file 48).' — pinned so the customer-trust→admin→SDK→ops-priority + Tier-1-22-slice-85h + Tier-2-18-slice-75h + V-295-status.driftstack.dev + V-301-MFA-planning-47 + V-305-Tauri-driftstack:// + V-306-LiveKit + V-333-admin-mandatory-TOTP commitment survives", () => {
    expect(body).toMatch(/## Recommended priority order \(V-295\+ slice sequencing\)/);
    expect(body).toMatch(
      /founder-facing trust first; admin tooling second; SDK feature parity third; ops maturity fourth/,
    );
    expect(body).toMatch(/### Tier 1 — Customer-facing trust \+ completeness \(~85h, ~22 slices\)/);
    expect(body).toMatch(/\*\*V-295\*\* Status page \(3-4d \/ 24h\) — `status\.driftstack\.dev`/);
    expect(body).toMatch(/\*\*V-296\*\* API key rotation flow/);
    expect(body).toMatch(
      /\*\*V-301\*\* MFA \/ TOTP setup \+ recovery codes \(security gate per planning file 47\)\./,
    );
    expect(body).toMatch(
      /\*\*V-305\*\* Tauri custom URL scheme `driftstack:\/\/auth\/callback` \(replaces V-268 polling per V-262 deferral\)\./,
    );
    expect(body).toMatch(
      /\*\*V-306\*\* GUI client: live session WebRTC stream \(LiveKit integration; planning file 36\)\./,
    );
    expect(body).toMatch(/### Tier 2 — Admin \/ ops tooling \(~75h, ~18 slices\)/);
    expect(body).toMatch(/\*\*V-317\*\* Browser-driving admin-panel Playwright tests/);
    expect(body).toMatch(
      /\*\*V-333\*\* Admin: separate auth from customer dashboard \(email \+ password \+ mandatory TOTP per planning file 48\)\./,
    );
  });

  it("Tier 3 + Tier 4 framing pinned: '### Tier 3 — SDK feature parity (~50h, ~10 slices)' + '**V-335** Python SDK first PyPI tag + release pipeline.' + '**V-336** Go SDK first git tag.' + '**V-337** SDK: webhook signature verifier in Go (TS + Python shipped).' + '**V-339** SDK: idempotency-key support (24h dedup window per planning file 37).' + '### Tier 4 — Ops maturity + content + tests (~85h, ~17 slices)' + '**V-345** Public benchmark page (`benchmarks.driftstack.dev`) — comparative detection results vs Multilogin / AdsPower' + '**V-360** GDPR DSAR support endpoint (planning file 48).' + '**V-361** AI agent layer scaffolding (planning file 06; agent-execution-service shell only — full agent loop is post-v1 per planning file 00).' — pinned so the Tier-3-10-slice-50h + V-335-Python-PyPI + V-336-Go-tag + V-337-Go-verifier-TS+Python-shipped + V-339-24h-dedup + Tier-4-17-slice-85h + V-345-benchmarks.driftstack.dev-Multilogin-AdsPower + V-360-GDPR-DSAR + V-361-agent-shell-only-full-loop-post-v1 commitment survives", () => {
    expect(body).toMatch(/### Tier 3 — SDK feature parity \(~50h, ~10 slices\)/);
    expect(body).toMatch(/\*\*V-335\*\* Python SDK first PyPI tag \+ release pipeline\./);
    expect(body).toMatch(/\*\*V-336\*\* Go SDK first git tag\./);
    expect(body).toMatch(
      /\*\*V-337\*\* SDK: webhook signature verifier in Go \(TS \+ Python shipped\)\./,
    );
    expect(body).toMatch(
      /\*\*V-339\*\* SDK: idempotency-key support \(24h dedup window per planning file 37\)\./,
    );
    expect(body).toMatch(/### Tier 4 — Ops maturity \+ content \+ tests \(~85h, ~17 slices\)/);
    expect(body).toMatch(
      /\*\*V-345\*\* Public benchmark page \(`benchmarks\.driftstack\.dev`\) — comparative detection results vs Multilogin \/ AdsPower/,
    );
    expect(body).toMatch(/\*\*V-360\*\* GDPR DSAR support endpoint \(planning file 48\)\./);
    expect(body).toMatch(
      /\*\*V-361\*\* AI agent layer scaffolding \(planning file 06; agent-execution-service shell only — full agent loop is post-v1 per planning file 00\)\./,
    );
  });

  it("Surface 1 customer-API + Surface 7 admin-panel highlights framing pinned: '### Surface 1 — Customer API server (`apps/server`)' + '**Session management** (planning file 03 + 37)' + '**Persistent profiles** (planning file 17 + 35)' + '**Behavioral customization** (planning file 05 + 35)' + 'behavioral realism IMPLEMENTATION is Agent 1's territory — WebKit-fork modifications. Agent 2 ships the API surface that exposes the parameters.' + '**Proxy integration** (planning file 03 + 11 + 17)' + '**Challenge handling** (planning file 12 + 37)' + '**Webhooks** (planning file 37 + 48)' + '**API auth + rate limiting** (planning file 37)' + '### Surface 7 — Admin panel (`apps/admin-panel`)' + '| Mac fleet management UI                           | AGENT-1' + '| Customer impersonation                            | UNDISCOVERED | V-319         | 8       | privacy + ToS' + '| Separate auth (email + password + mandatory TOTP) | DEFERRED     | V-333' — pinned so the Surface-1-API-7-subsystem + behavioral-realism-Agent-1-API-Agent-2 + Surface-7-admin-with-AGENT-1-fleet + V-319-impersonation-privacy+ToS + V-333-separate-auth commitment survives", () => {
    expect(body).toMatch(/### Surface 1 — Customer API server \(`apps\/server`\)/);
    expect(body).toMatch(/\*\*Session management\*\* \(planning file 03 \+ 37\)/);
    expect(body).toMatch(/\*\*Persistent profiles\*\* \(planning file 17 \+ 35\)/);
    expect(body).toMatch(/\*\*Behavioral customization\*\* \(planning file 05 \+ 35\)/);
    expect(body).toMatch(
      /behavioral realism IMPLEMENTATION is Agent 1's territory — WebKit-fork modifications\. Agent 2 ships the API surface that exposes the parameters/,
    );
    expect(body).toMatch(/\*\*Proxy integration\*\* \(planning file 03 \+ 11 \+ 17\)/);
    expect(body).toMatch(/\*\*Challenge handling\*\* \(planning file 12 \+ 37\)/);
    expect(body).toMatch(/\*\*Webhooks\*\* \(planning file 37 \+ 48\)/);
    expect(body).toMatch(/\*\*API auth \+ rate limiting\*\* \(planning file 37\)/);
    expect(body).toMatch(/### Surface 7 — Admin panel \(`apps\/admin-panel`\)/);
    expect(body).toMatch(/\| Mac fleet management UI\s+\| AGENT-1/);
    expect(body).toMatch(
      /\| Customer impersonation\s+\| UNDISCOVERED \| V-319\s+\| 8\s+\| privacy \+ ToS/,
    );
    expect(body).toMatch(
      /\| Separate auth \(email \+ password \+ mandatory TOTP\) \| DEFERRED\s+\| V-333/,
    );
  });

  it("Surface 10 AI agent + Surface 11 compliance framing pinned: '### Surface 10 — AI agent layer (planning file 06)' + '| Agent execution service shell             | DEFERRED              | V-361          | 16      | privacy + DPA Annex 3 + ToS' + '| BYOK + bundled billing models             | SHIPPED (markup-only) | tier3_explicit' + 'Note: full agent loop is post-v1 per planning file 00. V-361 ships the shell + scaffolding only. Most agent-loop features are OUT-OF-SCOPE for v1.' + '### Surface 11 — Compliance + security' + '| Data residency (EU-first)           | SHIPPED      | V-NNN' + '| GDPR DSAR support                   | DEFERRED     | V-360' + '| AUP enforcement (real)              | DEFERRED     | V-358' + '| Penetration testing                 | OUT-OF-SCOPE | year-2' — pinned so the Surface-10-AI-V-361-shell-16h + BYOK-markup-only-SHIPPED + post-v1-full-loop + Surface-11-compliance + EU-first-data-residency-SHIPPED + V-360-DSAR-DEFERRED + V-358-AUP + pentest-OUT-OF-SCOPE-year-2 commitment survives", () => {
    expect(body).toMatch(/### Surface 10 — AI agent layer \(planning file 06\)/);
    expect(body).toMatch(
      /\| Agent execution service shell\s+\| DEFERRED\s+\| V-361\s+\| 16\s+\| privacy \+ DPA Annex 3 \+ ToS/,
    );
    expect(body).toMatch(
      /\| BYOK \+ bundled billing models\s+\| SHIPPED \(markup-only\) \| tier3_explicit/,
    );
    expect(body).toMatch(
      /Note: full agent loop is post-v1 per planning file 00\. V-361 ships the shell \+ scaffolding only\. Most agent-loop features are OUT-OF-SCOPE for v1\./,
    );
    expect(body).toMatch(/### Surface 11 — Compliance \+ security/);
    expect(body).toMatch(/\| Data residency \(EU-first\)\s+\| SHIPPED\s+\| V-NNN/);
    expect(body).toMatch(/\| GDPR DSAR support\s+\| DEFERRED\s+\| V-360/);
    expect(body).toMatch(/\| AUP enforcement \(real\)\s+\| DEFERRED\s+\| V-358/);
    expect(body).toMatch(/\| Penetration testing\s+\| OUT-OF-SCOPE \| year-2/);
  });

  it("Legal-page-batch + priority-summary framing pinned: '## Legal-page-update batch summary' + 'Per the V-293-locked legal-page-auto-update methodology, V-295+ slices that introduce NEW PII / sub-processor / ToS scope update the relevant legal docs in the SAME commit.' + '| `apps/marketing-site/src/pages/legal/privacy.md`       | ~12 sections' + '| `apps/marketing-site/src/pages/legal/dpa.md` (Annex 3) | ~6 rows' + '| `apps/marketing-site/src/pages/legal/terms.md` (ToS)   | ~8 clauses' + '| `apps/marketing-site/src/pages/legal/aup.md`           | ~3 sections' + '| `docs/legal/changes-log.md`                            | new file; row per V-NNN slice' + '**Counsel review trigger** (per V-279 founder action queue item 9): batch all changes-log entries pre-first-paying-customer. Decoupled from feature-ship cadence.' + '## Recommended priority order summary (founder Tier-2 ack required before V-295+ starts)' + '**Total**: 67 V-NNN slices × avg 4.4h = ~297 Tier-1 hours.' — pinned so the V-293-legal-auto-update-SAME-commit + 5-legal-page-delta (privacy-12 + dpa-6 + terms-8 + aup-3 + changes-log) + V-279-action-item-9-counsel-batch-pre-first-paying-customer + 67-V-NNN-slice-4.4h-avg-~297-hour commitment survives", () => {
    expect(body).toMatch(/## Legal-page-update batch summary/);
    expect(body).toMatch(
      /Per the V-293-locked legal-page-auto-update methodology, V-295\+ slices that introduce NEW PII \/ sub-processor \/ ToS scope update the relevant legal docs in the SAME commit\./,
    );
    expect(body).toMatch(
      /\| `apps\/marketing-site\/src\/pages\/legal\/privacy\.md`\s+\| ~12 sections/,
    );
    expect(body).toMatch(
      /\| `apps\/marketing-site\/src\/pages\/legal\/dpa\.md` \(Annex 3\) \| ~6 rows/,
    );
    expect(body).toMatch(
      /\| `apps\/marketing-site\/src\/pages\/legal\/terms\.md` \(ToS\)\s+\| ~8 clauses/,
    );
    expect(body).toMatch(/\| `apps\/marketing-site\/src\/pages\/legal\/aup\.md`\s+\| ~3 sections/);
    expect(body).toMatch(/\| `docs\/legal\/changes-log\.md`\s+\| new file; row per V-NNN slice/);
    expect(body).toMatch(
      /\*\*Counsel review trigger\*\* \(per V-279 founder action queue item 9\): batch all changes-log entries pre-first-paying-customer\. Decoupled from feature-ship cadence\./,
    );
    expect(body).toMatch(
      /## Recommended priority order summary \(founder Tier-2 ack required before V-295\+ starts\)/,
    );
    expect(body).toMatch(/\*\*Total\*\*: 67 V-NNN slices × avg 4\.4h = ~297 Tier-1 hours\./);
  });

  it("8-out-of-scope + 6-open-question + V-295-no-start framing pinned: '## Items explicitly OUT-OF-SCOPE for v1' + '**Agent perception-reason-action loop full implementation** — 24h+ AI surface' + '**Cross-region profile portability** — multi-region S3 replication. v1 stays single-region.' + '**OpenVPN proxy support** — niche customer ask; SOCKS5 + WireGuard + HTTP cover the launch surface.' + '**Mobile device control on iOS/Android** — accessing GUI client from a mobile device. Year-2.' + '**Penetration testing** — annual engagement; year-2 budget.' + '**Self-hosted licensing v2** — different commercial model; year-2.' + '**Customer logos / case studies** — post-launch (no customers yet).' + '**WebGPU on iOS 26 fingerprint surface** — Agent-1 territory; cross-repo dep.' + '## Open questions for founder Tier-2 ack' + '**Priority order confirmation** — recommended order above is `customer-trust → admin → SDK → ops`. Confirm or reorder.' + '**WebRTC live-session streaming (LiveKit)** — biggest single-feature scope (~32h across V-306/V-307/V-308 + LiveKit DPA Annex 3 row).' + '**Multi-payment-processor (Mollie)** — planning file 00/116 lists Mollie as primary' + '**Team RBAC + multi-user** — ~20h across V-NNN+ slices.' + 'V-295+ does NOT START until founder verdicts on the 6 above + an explicit \"go\" on the priority order.' + 'Pre-codegen scope review mandatory per V-294 founder direction.' — pinned so the 8-out-of-scope (agent-loop + cross-region + OpenVPN + mobile-iOS/Android + pentest + self-hosted-v2 + logos-case-studies + WebGPU-iOS-26-Agent-1) + 6-open-question + V-295+-does-NOT-START-without-founder-verdicts + pre-codegen-mandatory commitment survives", () => {
    expect(body).toMatch(/## Items explicitly OUT-OF-SCOPE for v1/);
    expect(body).toMatch(
      /- \*\*Agent perception-reason-action loop full implementation\*\* — 24h\+ AI surface/,
    );
    expect(body).toMatch(
      /- \*\*Cross-region profile portability\*\* — multi-region S3 replication\. v1 stays single-region\./,
    );
    expect(body).toMatch(
      /- \*\*OpenVPN proxy support\*\* — niche customer ask; SOCKS5 \+ WireGuard \+ HTTP cover the launch surface\./,
    );
    expect(body).toMatch(
      /- \*\*Mobile device control on iOS\/Android\*\* — accessing GUI client from a mobile device\. Year-2\./,
    );
    expect(body).toMatch(/- \*\*Penetration testing\*\* — annual engagement; year-2 budget\./);
    expect(body).toMatch(
      /- \*\*Self-hosted licensing v2\*\* — different commercial model; year-2\./,
    );
    expect(body).toMatch(
      /- \*\*Customer logos \/ case studies\*\* — post-launch \(no customers yet\)\./,
    );
    expect(body).toMatch(
      /- \*\*WebGPU on iOS 26 fingerprint surface\*\* — Agent-1 territory; cross-repo dep\./,
    );
    expect(body).toMatch(/## Open questions for founder Tier-2 ack/);
    expect(body).toMatch(
      /1\. \*\*Priority order confirmation\*\* — recommended order above is `customer-trust → admin → SDK → ops`\. Confirm or reorder\./,
    );
    expect(body).toMatch(
      /4\. \*\*WebRTC live-session streaming \(LiveKit\)\*\* — biggest single-feature scope \(~32h across V-306\/V-307\/V-308 \+ LiveKit DPA Annex 3 row\)\./,
    );
    expect(body).toMatch(
      /5\. \*\*Multi-payment-processor \(Mollie\)\*\* — planning file 00\/116 lists Mollie as primary/,
    );
    expect(body).toMatch(/6\. \*\*Team RBAC \+ multi-user\*\* — ~20h across V-NNN\+ slices\./);
    expect(body).toMatch(
      /V-295\+ does NOT START until founder verdicts on the 6 above \+ an explicit "go" on the priority order\./,
    );
    expect(body).toMatch(/Pre-codegen scope review mandatory per V-294 founder direction\./);
  });

  it("Status-page Surface 6 + Surface 8 SDK + Surface 9 infra framing pinned: '### Surface 6 — Status page (NEW; `apps/status-page`)' + '| Top-level overall status            | DEFERRED | V-295' + '| Auto-polling (Hetzner cron + R2)    | DEFERRED | V-295 | 8       | DPA Annex 3 (cron worker)' + '| SLA reporting / uptime calculations | DEFERRED | V-295 | 6       | ToS (SLA clause)' + '### Surface 8 — SDKs (`packages/sdk-typescript`, `packages/sdk-python`, `packages/sdk-go`)' + '| TypeScript SDK published (npm)             | SHIPPED' + '| Python SDK alpha + first PyPI tag          | DEFERRED | V-335' + '| Go SDK alpha + first git tag               | DEFERRED | V-336' + '| Webhook signature verifier (Go)            | DEFERRED | V-337' + '### Surface 9 — Infrastructure + ops (`apps/server` + `infra/`)' + '| Hetzner deploy automation                | SHIPPED  | V-278' + '| 5 CF Pages deploy workflows              | SHIPPED  | V-258-V-260 + V-295' + '| GDPR DSAR support endpoint               | DEFERRED | V-360' — pinned so the Surface-6-NEW-apps/status-page + V-295-Hetzner-cron-R2-DPA-row + SLA-ToS-clause + Surface-8-3-SDK + TS-SHIPPED-Python-V-335-Go-V-336 + Surface-9-Hetzner-V-278 + 5-CF-Pages-V-258-V-260+V-295 + V-360-DSAR-endpoint commitment survives", () => {
    expect(body).toMatch(/### Surface 6 — Status page \(NEW; `apps\/status-page`\)/);
    // V-873 — seven rows in this catalog described shipped work as DEFERRED and
    // this pin froze one of them. The status site ships index / history /
    // incident / subscribe pages, three incident-and-subscriber tables back
    // /v1/admin/incidents and /v1/admin/status-subscribers, and index.astro
    // renders per-component state. Negative on the stale cell, positive on the
    // corrected one.
    expect(body, 'the DEFERRED status-page row is gone').not.toMatch(
      /\| Top-level overall status\s+\| DEFERRED \| V-295/,
    );
    expect(body, 'and reads as shipped').toMatch(
      /\| Top-level overall status\s+\| SHIPPED \(V-873\) \| V-295/,
    );
    expect(body).toMatch(
      /\| Auto-polling \(Hetzner cron \+ R2\)\s+\| DEFERRED\s+\| V-295 \| 8\s+\| DPA Annex 3 \(cron worker\)/,
    );
    expect(body).toMatch(
      /\| SLA reporting \/ uptime calculations \| DEFERRED\s+\| V-295 \| 6\s+\| ToS \(SLA clause\)/,
    );
    expect(body).toMatch(
      /### Surface 8 — SDKs \(`packages\/sdk-typescript`, `packages\/sdk-python`, `packages\/sdk-go`\)/,
    );
    expect(body).toMatch(/\| TypeScript SDK published \(npm\)\s+\| SHIPPED/);
    expect(body).toMatch(/\| Python SDK alpha \+ first PyPI tag\s+\| DEFERRED \| V-335/);
    expect(body).toMatch(/\| Go SDK alpha \+ first git tag\s+\| DEFERRED \| V-336/);
    expect(body).toMatch(/\| Webhook signature verifier \(Go\)\s+\| DEFERRED \| V-337/);
    expect(body).toMatch(/### Surface 9 — Infrastructure \+ ops \(`apps\/server` \+ `infra\/`\)/);
    expect(body).toMatch(/\| Hetzner deploy automation\s+\| SHIPPED\s+\| V-278/);
    expect(body).toMatch(/\| 5 CF Pages deploy workflows\s+\| SHIPPED\s+\| V-258-V-260 \+ V-295/);
    expect(body).toMatch(/\| GDPR DSAR support endpoint\s+\| DEFERRED \| V-360/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
