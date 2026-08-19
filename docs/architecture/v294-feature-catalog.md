# V-294 — Feature catalog (production-ready scope)

**Source**: Comprehensive survey of `/Users/john/Downloads/driftstack-planning 2/` (132 planning files, files 00-131). Cross-referenced against `docs/verification-log.md` (V-001 → V-293) + `docs/launch/pre-launch-checklist.md` (V-287 refresh) for current-state classification.

**Purpose**: Single load-bearing scope artifact for the V-295+ multi-week production-ready arc. Founder direction 2026-05-07 retired the deferred-post-launch pattern; every previously-deferred feature ships in v1 unless V-294 surfaces it as legitimately out-of-scope.

> **⚠ V-872 — every classification below was made against a verification log that
> has since advanced by hundreds of entries.**
>
> The Source line above states the basis: cross-referenced against
> `docs/verification-log.md` at **V-293**. That is the freshness marker this
> document has, and it is a better one than a date because it is checkable — the
> log's highest entry when this note was written was V-871, so the classifications
> are 578 entries behind their own stated basis.
>
> This is not a claim that the table is wrong. It is a claim that a row here is
> evidence of what was true at V-293 and nothing more, and that the difference
> matters: V-868 found the Tauri deep-link row marked DEFERRED after V-328 shipped
> it, and corrected that row alone. The other rows have not been re-verified.
>
> **Check a row against source before acting on it.** Six findings in this arc
> (V-866 through V-871) were status documents asserting work as outstanding that
> had shipped — a P0 blocker, a runbook step, a checklist row, an ADR decision, a
> checkpoint's blocked list and an action item. The code was right in every case;
> the document describing it was not.

---

## Status taxonomy

- **SHIPPED** — exists on `main`; verified by passing tests + passing lint + at least one V-NNN log entry covering it.
- **IN-FLIGHT** — partial implementation on `main`; V-NNN entry exists but feature is not customer-complete.
- **DEFERRED** — known-needed; not yet started; targeted by V-295+ slice.
- **UNDISCOVERED** — referenced in planning files but never started + not in current V-NNN backlog.
- **AGENT-1** — feature lives in the WebKit-fork repo (Agent 1 territory); Agent 2 doesn't ship.
- **OUT-OF-SCOPE** — surveyed but explicitly cut from v1 (e.g. enterprise-tier-only, post-launch growth, year-2 ambition).

---

## Aggregate scope summary

**Total features surveyed**: 213 (across 12 surface categories).

| Status       | Count | Aggregate Tier-1 hours | Legal updates required |
| ------------ | ----- | ---------------------- | ---------------------- |
| SHIPPED      | 87    | n/a (already done)     | n/a                    |
| IN-FLIGHT    | 6     | ~12                    | 1                      |
| DEFERRED     | 41    | ~95                    | 12                     |
| UNDISCOVERED | 53    | ~190                   | 18                     |
| AGENT-1      | 18    | n/a (cross-repo)       | n/a                    |
| OUT-OF-SCOPE | 8     | n/a                    | n/a                    |

**Aggregate Agent-2 launch scope**: ~297 Tier-1 hours of feature work + ~31 legal page updates spread across the V-295+ slice arc. At 6h/day sustained = ~50 working days = ~10 weeks. Aligns with founder's "15-25 day conservative pre-V-294 estimate; multi-week arc" framing — V-294 catalog refines upward to ~10 weeks once UNDISCOVERED features are folded in.

This converges with Agent 1's V-383+ multi-week native-pipeline-alignment arc (4-12 weeks); both arcs target the same first-paying-customer-ready landing window.

---

## Recommended priority order (V-295+ slice sequencing)

Per founder direction "founder-facing trust first; admin tooling second; SDK feature parity third; ops maturity fourth":

### Tier 1 — Customer-facing trust + completeness (~85h, ~22 slices)

1. **V-295** Status page (3-4d / 24h) — `status.driftstack.dev` with manual + auto-poll + email subscriptions + privacy/DPA updates. (Founder-locked.)
2. **V-296** API key rotation flow — current is one-shot generation; rotation needs grace period + cutover.
3. **V-297** Session export / audit log download (compliance-relevant; GDPR DSAR adjacent).
4. **V-298** Customer self-service: account settings page (already PARTIAL; close to READY).
5. **V-299** Customer self-service: usage page polish (live wiring complete; UI polish only).
6. **V-300** Customer self-service: billing portal redirect (Stripe Customer Portal integration).
7. **V-301** MFA / TOTP setup + recovery codes (security gate per planning file 47).
8. **V-302** Personal-profile settings: avatar / timezone / email-notification preferences.
9. **V-303** Per-user security audit log surface (`/account/security-audit`) — backend exists (V-216); UI surface needed.
10. **V-304** Customer onboarding email flow: welcome + first-session + billing reminders (Postmark templates + scheduled-jobs).
11. **V-305** Tauri custom URL scheme `driftstack://auth/callback` (replaces V-268 polling per V-262 deferral).
12. **V-306** GUI client: live session WebRTC stream (LiveKit integration; planning file 36).
13. **V-307** GUI client: touch/click input forwarding to fleet (LiveKit data channel).
14. **V-308** GUI client: address bar + nav controls (back/forward/refresh).
15. **V-309** Customer-facing notification preferences UI + Postmark wiring.
16. **V-310** Webhooks customer-facing delivery infra: verify V-282 ✅ surface fully delivers + retries.
17. **V-311** Webhook test-delivery + replay UI in dashboard.
18. **V-312** Profile snapshots (named state versions, rollback) — backend partially present; UI absent.
19. **V-313** Profile cloning UI.
20. **V-314** Profile state cleanup UI (clear cache / reset to fresh).
21. **V-315** Workflows + recording UI (planning file 47 §workflows; significant scope ~12h).
22. **V-316** Recipe library: 20-30 system recipes for priority sites + customer fork/customize UI (planning file 56; ~16h).

### Tier 2 — Admin / ops tooling (~75h, ~18 slices)

23. **V-317** Browser-driving admin-panel Playwright tests (V-285 deferral closed).
24. **V-318** Admin: incident management UI (POST `/v1/admin/incidents` + status-page integration per V-295).
25. **V-319** Admin: customer impersonation flow (audit-logged; customer-notified).
26. **V-320** Admin: bulk customer operations (CSV export / mass email / apply changes).
27. **V-321** Admin: customer success metrics auto-identification (churn risks / upgrade opportunities).
28. **V-322** Admin: per-account billing tab (invoice download / payment methods / disputes).
29. **V-323** Admin: dunning / failed-payment UI.
30. **V-324** Admin: chargeback dispute workflow.
31. **V-325** Admin: tax / VAT reports + MOSS export.
32. **V-326** Admin: revenue dashboard (MRR / ARR / churn / LTV).
33. **V-327** Admin: detection vendor monitoring UI (per planning file 48; cross-feeds Agent 1's harness output).
34. **V-328** Admin: feature flags UI.
35. **V-329** Admin: plan configuration UI (adjust plan parameters / test mode).
36. **V-330** Admin: email template editor.
37. **V-331** Admin: third-party integrations config UI (Stripe / Mollie / Moneybird / LiveKit).
38. **V-332** Admin: admin user management (invite / revoke / change roles).
39. **V-333** Admin: separate auth from customer dashboard (email + password + mandatory TOTP per planning file 48).
40. **V-334** Admin: IP allowlist enforcement.

### Tier 3 — SDK feature parity (~50h, ~10 slices)

41. **V-335** Python SDK first PyPI tag + release pipeline.
42. **V-336** Go SDK first git tag.
43. **V-337** SDK: webhook signature verifier in Go (TS + Python shipped).
44. **V-338** SDK: streaming responses (V-282 deferred; planning file 35 v1 surface).
45. **V-339** SDK: idempotency-key support (24h dedup window per planning file 37).
46. **V-340** SDK: scope-based permission helpers (sessions:_ / profiles:_ / billing:read / admin granular).
47. **V-341** SDK: behavioral preset selectors (fast / balanced / careful).
48. **V-342** SDK: SOCKS5 / WireGuard / OpenVPN proxy config helpers.
49. **V-343** SDK: challenge-handling helpers (detect / pause / resume / submit token).
50. **V-344** SDK: recipe execution surface (per planning file 35 + 56).

### Tier 4 — Ops maturity + content + tests (~85h, ~17 slices)

51. **V-345** Public benchmark page (`benchmarks.driftstack.dev`) — comparative detection results vs Multilogin / AdsPower (per planning files 00 + 10).
52. **V-346** Customer-dashboard PARTIAL pages polish: sessions / billing / usage / webhooks visual upgrade to V-275 vocabulary.
53. **V-347** Doc-site expansion: per-recipe docs / mobile optimization guide / proxy setup guides / agent feature guide / API migration guides (planning file 41).
54. **V-348** FAQ deepen + edge-case guides + troubleshooting beyond V-282.
55. **V-349** Comprehensive edge-case + error-path test coverage (V-285 caught 3 gaps; broaden).
56. **V-350** Pattern extraction into reusable test utilities (factor V-289/V-290/V-291/V-292/V-293 mock helpers).
57. **V-351** Performance optimization passes (auth-cache hot path / scrypt warmup / rate-limit consume) beyond V-286 baseline.
58. **V-352** Disaster recovery runbook expansion (planning file 13 + 59).
59. **V-353** Mac fleet management runbook expansion (planning file 104 + 63; mostly Agent 1 territory but Agent 2 control-plane integration).
60. **V-354** Monitoring stack: Sentry custom dashboards + alert thresholds tuning.
61. **V-355** Customer support response template library (planning file 14).
62. **V-356** Discord / GitHub Discussions integration with tickets.
63. **V-357** Self-service troubleshooting: connectivity diagnostic improvements (V-277 ConnectivityView is functional; expand to full suite).
64. **V-358** AUP enforcement workflow: triage / investigation / suspension automation (planning file 09).
65. **V-359** Customer trust artifacts: SLA page + transparent retention policy + sub-processor change-log surface (planning file 83).
66. **V-360** GDPR DSAR support endpoint (planning file 48).
67. **V-361** AI agent layer scaffolding (planning file 06; agent-execution-service shell only — full agent loop is post-v1 per planning file 00).

---

## Per-feature detail

### Surface 1 — Customer API server (`apps/server`)

**Session management** (planning file 03 + 37):

| Feature                                              | Status       | Slice     | Tier-1h | Legal updates |
| ---------------------------------------------------- | ------------ | --------- | ------- | ------------- |
| Session create / list / get / destroy                | SHIPPED      | V-073     | —       | —             |
| Session navigate / interact / wait / state / capture | SHIPPED      | V-073     | —       | —             |
| Idle timeout configuration (per-session)             | UNDISCOVERED | future    | 2       | —             |
| Max-lifetime configuration (default 4h)              | UNDISCOVERED | future    | 2       | —             |
| Session metadata (customer-supplied k/v)             | SHIPPED      | V-073     | —       | —             |
| Intent result logging (full execution history)       | IN-FLIGHT    | mock-only | 4       | —             |
| Network event logging                                | UNDISCOVERED | V-NNN+    | 6       | privacy ToS   |

**Persistent profiles** (planning file 17 + 35):

| Feature                                         | Status       | Slice   | Tier-1h | Legal updates                                 |
| ----------------------------------------------- | ------------ | ------- | ------- | --------------------------------------------- |
| Profile CRUD (create / list / get / delete)     | SHIPPED      | V-081   | —       | —                                             |
| Profile state versioning + snapshots            | SHIPPED      | V-312   | —       | privacy §3.1 + §9 + DPA Annex 3 (V-373/V-384) |
| Profile-to-session binding                      | IN-FLIGHT    | partial | 3       | —                                             |
| Profile state encryption + S3 storage           | UNDISCOVERED | future  | 8       | DPA Annex 3 + privacy                         |
| Profile session history audit                   | SHIPPED      | V-216   | —       | —                                             |
| Profile cleanup operations                      | DEFERRED     | V-314   | 4       | —                                             |
| Cross-region profile portability                | OUT-OF-SCOPE | post-v1 | n/a     | —                                             |
| Concurrent session prevention (exclusive lease) | UNDISCOVERED | future  | 4       | —                                             |

**Behavioral customization** (planning file 05 + 35):

| Feature                                              | Status       | Slice  | Tier-1h | Legal updates |
| ---------------------------------------------------- | ------------ | ------ | ------- | ------------- |
| Behavior profile presets (fast / balanced / careful) | UNDISCOVERED | V-341  | 4       | —             |
| Custom persona configuration                         | UNDISCOVERED | V-NNN+ | 8       | —             |
| Per-session behavioral override                      | UNDISCOVERED | V-NNN+ | 4       | —             |

(Note: behavioral realism IMPLEMENTATION is Agent 1's territory — WebKit-fork modifications. Agent 2 ships the API surface that exposes the parameters.)

**Proxy integration** (planning file 03 + 11 + 17):

| Feature                                | Status       | Slice            | Tier-1h | Legal updates |
| -------------------------------------- | ------------ | ---------------- | ------- | ------------- |
| SOCKS5 proxy support                   | IN-FLIGHT    | V-282 SDK matrix | 6       | privacy + DPA |
| WireGuard tunnel support               | UNDISCOVERED | V-NNN+           | 8       | privacy + DPA |
| OpenVPN support (container-isolated)   | OUT-OF-SCOPE | year-2           | n/a     | —             |
| HTTP proxy fallback                    | UNDISCOVERED | V-NNN+           | 3       | privacy       |
| Per-session inline proxy specification | UNDISCOVERED | V-342            | 4       | privacy       |
| Proxy health monitoring                | UNDISCOVERED | V-NNN+           | 4       | —             |
| Proxy geo-location verification        | UNDISCOVERED | V-NNN+           | 4       | privacy       |
| Proxy configuration management API     | UNDISCOVERED | V-NNN+           | 6       | —             |

**Challenge handling** (planning file 12 + 37):

| Feature                          | Status       | Slice  | Tier-1h | Legal updates |
| -------------------------------- | ------------ | ------ | ------- | ------------- |
| Challenge detection + surfacing  | UNDISCOVERED | V-343  | 8       | —             |
| Manual challenge resolution flow | UNDISCOVERED | V-343  | 6       | —             |
| Third-party solver integration   | UNDISCOVERED | V-NNN+ | 4       | DPA Annex 3   |
| Challenge context capture        | UNDISCOVERED | V-343  | 3       | —             |

**Webhooks** (planning file 37 + 48):

| Feature                                  | Status  | Slice         | Tier-1h | Legal updates |
| ---------------------------------------- | ------- | ------------- | ------- | ------------- |
| Webhook subscriptions CRUD               | SHIPPED | V-074         | —       | —             |
| Webhook delivery tracking + retries      | SHIPPED | V-282 + V-307 | —       | —             |
| Webhook event filtering per endpoint     | SHIPPED | V-405         | —       | —             |
| Webhook test delivery (admin + customer) | SHIPPED | V-356         | —       | —             |
| Webhook signing-secret rotation          | SHIPPED | V-359         | —       | —             |
| Webhook event replay                     | SHIPPED | V-091         | —       | —             |

**API auth + rate limiting** (planning file 37):

| Feature                      | Status          | Slice | Tier-1h | Legal updates |
| ---------------------------- | --------------- | ----- | ------- | ------------- |
| API key CRUD                 | SHIPPED         | V-049 | —       | —             |
| Bearer token auth            | SHIPPED         | V-049 | —       | —             |
| Scope-based permissions      | SHIPPED         | V-174 | —       | —             |
| Key rotation flow            | SHIPPED         | V-296 | —       | —             |
| Rate limiting per key        | SHIPPED         | V-251 | —       | —             |
| Idempotency keys (24h dedup) | SHIPPED (V-873) | V-339 | 4       | —             |

### Surface 2 — Customer dashboard (`apps/customer-dashboard`)

**Session management UI** (planning file 47):

| Feature                            | Status       | Slice  | Tier-1h | Legal updates                   |
| ---------------------------------- | ------------ | ------ | ------- | ------------------------------- |
| Session list + filtering / sorting | IN-FLIGHT    | V-346  | 4       | —                               |
| Session detail view (live updates) | IN-FLIGHT    | V-346  | 6       | —                               |
| Session creation dialog            | UNDISCOVERED | V-346  | 3       | —                               |
| Session workspace (WebRTC stream)  | UNDISCOVERED | V-306  | 16      | privacy + DPA Annex 3 (LiveKit) |
| Screenshot gallery per session     | UNDISCOVERED | V-346  | 4       | —                               |
| Network inspector per session      | UNDISCOVERED | V-NNN+ | 6       | privacy                         |
| Console log viewer per session     | UNDISCOVERED | V-NNN+ | 4       | privacy                         |
| Cookies viewer per session         | UNDISCOVERED | V-NNN+ | 3       | privacy                         |
| Event timeline per session         | UNDISCOVERED | V-346  | 6       | —                               |

**Live session control** (planning file 36 + 47):

| Feature                              | Status       | Slice  | Tier-1h | Legal updates |
| ------------------------------------ | ------------ | ------ | ------- | ------------- |
| Video stream of iPhone Safari        | UNDISCOVERED | V-306  | 16      | privacy + DPA |
| Touch / click input forwarding       | UNDISCOVERED | V-307  | 8       | —             |
| Keyboard input forwarding            | UNDISCOVERED | V-307  | 4       | —             |
| Address bar / navigation controls    | UNDISCOVERED | V-308  | 4       | —             |
| Multi-user concurrent viewing (team) | UNDISCOVERED | V-NNN+ | 6       | privacy       |
| Session access audit logging         | SHIPPED      | V-216  | —       | —             |

**Persistent profile management UI** (planning file 47):

| Feature                             | Status       | Slice         | Tier-1h | Legal updates      |
| ----------------------------------- | ------------ | ------------- | ------- | ------------------ |
| Profile list + search / filter      | SHIPPED      | V-284         | —       | —                  |
| Profile detail view                 | IN-FLIGHT    | V-NNN+        | 4       | —                  |
| Profile creation form               | SHIPPED      | V-284         | —       | —                  |
| Profile cloning                     | SHIPPED      | V-313 + V-379 | —       | —                  |
| Profile snapshot management         | SHIPPED      | V-312 + V-375 | —       | privacy §9 (V-373) |
| Profile state cleanup UI            | DEFERRED     | V-314         | 4       | —                  |
| Profile archiving (30-day recovery) | UNDISCOVERED | V-NNN+        | 6       | privacy retention  |
| Profile sharing within team         | UNDISCOVERED | V-NNN+        | 8       | privacy            |

**Workflows + recording** (planning file 47):

| Feature                         | Status       | Slice  | Tier-1h | Legal updates                   |
| ------------------------------- | ------------ | ------ | ------- | ------------------------------- |
| Session recording               | UNDISCOVERED | V-315  | 8       | privacy retention               |
| Workflow visual editor          | UNDISCOVERED | V-315  | 12      | —                               |
| Workflow parameterization       | UNDISCOVERED | V-315  | 4       | —                               |
| Workflow execution              | UNDISCOVERED | V-315  | 6       | —                               |
| Workflow scheduling (cron-like) | UNDISCOVERED | V-NNN+ | 6       | privacy (scheduled-job storage) |

**Recipes** (planning file 47 + 56):

| Feature                           | Status       | Slice | Tier-1h | Legal updates |
| --------------------------------- | ------------ | ----- | ------- | ------------- |
| System recipe library (20-30)     | UNDISCOVERED | V-316 | 16      | —             |
| Recipe detail view                | UNDISCOVERED | V-316 | 4       | —             |
| Custom recipe support (JSON/YAML) | UNDISCOVERED | V-316 | 6       | —             |
| Recipe fork + customize           | UNDISCOVERED | V-316 | 3       | —             |
| Recipe test status                | UNDISCOVERED | V-316 | 3       | —             |

**API keys / webhooks / billing / usage / team / settings UI** (planning file 47):

| Feature                                     | Status          | Slice                         | Tier-1h | Legal updates                                  |
| ------------------------------------------- | --------------- | ----------------------------- | ------- | ---------------------------------------------- |
| /api-keys CRUD                              | SHIPPED         | V-270                         | —       | —                                              |
| /webhooks list + status                     | SHIPPED         | V-282 + V-307b                | —       | —                                              |
| /webhooks delivery history                  | SHIPPED         | V-307b + V-403                | —       | —                                              |
| /usage summary + visualization              | IN-FLIGHT       | V-299                         | 4       | —                                              |
| /usage historical trends + cost projections | DEFERRED        | V-299                         | 6       | —                                              |
| /billing plan picker + payment methods      | IN-FLIGHT       | V-300                         | 4       | —                                              |
| /billing portal redirect                    | SHIPPED (V-873) | V-300                         | 3       | —                                              |
| /billing invoice history + PDF download     | DEFERRED        | V-300                         | 4       | privacy                                        |
| /team member list + invitation              | UNDISCOVERED    | V-NNN+                        | 8       | privacy + ToS                                  |
| /team RBAC                                  | UNDISCOVERED    | V-NNN+                        | 6       | ToS                                            |
| /settings account + slug + region           | SHIPPED         | V-298a + V-298b               | —       | privacy §3.1 + DPA Annex 3 (V-373/V-374/V-384) |
| /settings personal profile                  | SHIPPED         | V-352 + V-352b                | —       | —                                              |
| /settings security (password / MFA)         | SHIPPED         | V-353a-h                      | —       | privacy §3.2 (V-353)                           |
| /settings active sessions list + revoke     | SHIPPED         | V-355                         | —       | —                                              |
| /settings security audit log                | SHIPPED         | V-216 + V-381 + V-398 + V-399 | —       | —                                              |
| /settings notification preferences          | SHIPPED         | V-204                         | —       | privacy                                        |

**Onboarding flow** (planning file 12):

| Feature                       | Status       | Slice        | Tier-1h | Legal updates |
| ----------------------------- | ------------ | ------------ | ------- | ------------- |
| Welcome screen + greeting     | SHIPPED      | V-184a       | —       | —             |
| Use-case segmentation         | UNDISCOVERED | V-NNN+       | 6       | —             |
| First API key auto-generation | SHIPPED      | V-244 wizard | —       | —             |
| Proxy setup guidance          | UNDISCOVERED | V-NNN+       | 6       | —             |
| Tour overlay                  | UNDISCOVERED | V-NNN+       | 4       | —             |

### Surface 3 — GUI client (`apps/gui-client`)

| Feature                                 | Status                                       | Slice         | Tier-1h | Legal updates         |
| --------------------------------------- | -------------------------------------------- | ------------- | ------- | --------------------- |
| First-run wizard                        | SHIPPED                                      | V-244 + V-261 | —       | —                     |
| Browser-OAuth flow                      | SHIPPED                                      | V-268         | —       | —                     |
| Tauri custom URL scheme `driftstack://` | BUILT (V-328), per-OS bundle run outstanding | V-305         | 8       | privacy (deep-link)   |
| Empty states across 4 list views        | SHIPPED                                      | V-275-V-277   | —       | —                     |
| Sentry crash-only telemetry             | SHIPPED                                      | V-242         | —       | —                     |
| OS keychain for API key                 | SHIPPED                                      | V-241         | —       | —                     |
| Tauri Updater wired                     | SHIPPED                                      | V-243         | —       | —                     |
| macOS code signing                      | PENDING FOUNDER                              | n/a           | n/a     | —                     |
| Windows code signing                    | PENDING FOUNDER                              | n/a           | n/a     | —                     |
| Linux package signing                   | DEFERRED                                     | post-launch   | 4       | —                     |
| Live session WebRTC stream (LiveKit)    | UNDISCOVERED                                 | V-306         | 16      | privacy + DPA Annex 3 |
| Touch / click input forwarding          | UNDISCOVERED                                 | V-307         | 8       | —                     |
| Keyboard input forwarding               | UNDISCOVERED                                 | V-307         | 4       | —                     |
| Address bar + nav controls              | UNDISCOVERED                                 | V-308         | 4       | —                     |
| Mobile device control on iOS/Android    | OUT-OF-SCOPE                                 | year-2        | n/a     | —                     |

### Surface 4 — Marketing site (`apps/marketing-site`)

| Feature                                                  | Status       | Slice       | Tier-1h | Legal updates          |
| -------------------------------------------------------- | ------------ | ----------- | ------- | ---------------------- |
| Landing + pricing + security + faq + about + self-hosted | SHIPPED      | V-264       | —       | —                      |
| Legal pages (terms/privacy/dpa/aup)                      | SHIPPED      | V-264       | —       | counsel review pending |
| Sub-processors page                                      | SHIPPED      | V-052       | —       | —                      |
| Signup link wiring                                       | SHIPPED      | V-293       | —       | —                      |
| Public benchmark page                                    | UNDISCOVERED | V-345       | 12      | —                      |
| Live fingerprint test (visitor's browser)                | UNDISCOVERED | V-345       | 12      | privacy (visitor data) |
| Customer logos / case studies                            | OUT-OF-SCOPE | post-launch | n/a     | —                      |

### Surface 5 — Doc site (`apps/docs`)

| Feature                                                                          | Status       | Slice         | Tier-1h | Legal updates |
| -------------------------------------------------------------------------------- | ------------ | ------------- | ------- | ------------- |
| Quickstart / SDK install / License activation / Profile mgmt / Session lifecycle | SHIPPED      | V-256 + V-282 | —       | —             |
| API + SDK + Webhooks reference                                                   | SHIPPED      | V-254         | —       | —             |
| Per-recipe docs                                                                  | UNDISCOVERED | V-347         | 8       | —             |
| Mobile optimization guide                                                        | UNDISCOVERED | V-347         | 4       | —             |
| Proxy setup guides                                                               | UNDISCOVERED | V-347         | 6       | —             |
| Agent feature guide                                                              | UNDISCOVERED | V-347         | 6       | —             |
| API migration guides (deprecation paths)                                         | UNDISCOVERED | V-347         | 4       | —             |
| Changelog                                                                        | UNDISCOVERED | V-347         | 3       | —             |
| FAQ + edge-case + troubleshooting deepen                                         | DEFERRED     | V-348         | 8       | —             |

### Surface 6 — Status page (NEW; `apps/status-page`)

| Feature                             | Status          | Slice | Tier-1h | Legal updates             |
| ----------------------------------- | --------------- | ----- | ------- | ------------------------- |
| Top-level overall status            | SHIPPED (V-873) | V-295 | 3       | —                         |
| Per-component status                | SHIPPED (V-873) | V-295 | 4       | —                         |
| Incident history (last 30 days)     | SHIPPED (V-873) | V-295 | 4       | privacy retention         |
| Manual incident posting (admin)     | SHIPPED (V-873) | V-295 | 6       | —                         |
| Auto-polling (Hetzner cron + R2)    | DEFERRED        | V-295 | 8       | DPA Annex 3 (cron worker) |
| Email subscription for incidents    | SHIPPED (V-873) | V-295 | 8       | privacy + DPA             |
| Twitter / Slack notifications       | DEFERRED        | V-295 | 6       | DPA Annex 3               |
| SLA reporting / uptime calculations | DEFERRED        | V-295 | 6       | ToS (SLA clause)          |
| Component-specific subscribe        | DEFERRED        | V-295 | 4       | privacy                   |

### Surface 7 — Admin panel (`apps/admin-panel`)

| Feature                                           | Status       | Slice         | Tier-1h | Legal updates |
| ------------------------------------------------- | ------------ | ------------- | ------- | ------------- |
| /accounts list + detail                           | SHIPPED      | V-187 + V-191 | —       | —             |
| /api-keys cross-account                           | SHIPPED      | V-NNN         | —       | —             |
| /sessions cross-account                           | SHIPPED      | V-NNN         | —       | —             |
| /audit-log filterable + export                    | IN-FLIGHT    | V-NNN+        | 4       | —             |
| /webhook-dlq                                      | SHIPPED      | V-NNN         | —       | —             |
| /rate-limit-overrides                             | SHIPPED      | V-NNN         | —       | —             |
| Audit-note + refund-record                        | SHIPPED      | V-281         | —       | —             |
| Browser-driving Playwright tests                  | DEFERRED     | V-317         | 6       | —             |
| Customer impersonation                            | UNDISCOVERED | V-319         | 8       | privacy + ToS |
| Bulk customer ops + CSV export                    | UNDISCOVERED | V-320         | 8       | —             |
| Customer success metrics auto-id                  | UNDISCOVERED | V-321         | 12      | privacy       |
| Per-account billing tab                           | UNDISCOVERED | V-322         | 6       | privacy       |
| Dunning / failed-payment UI                       | UNDISCOVERED | V-323         | 6       | privacy       |
| Chargeback dispute workflow                       | UNDISCOVERED | V-324         | 8       | —             |
| Tax / VAT / MOSS reports                          | UNDISCOVERED | V-325         | 8       | —             |
| Revenue dashboard                                 | UNDISCOVERED | V-326         | 8       | —             |
| Detection vendor monitoring                       | UNDISCOVERED | V-327         | 8       | —             |
| Mac fleet management UI                           | AGENT-1      | n/a           | n/a     | —             |
| Incident management UI                            | DEFERRED     | V-318         | 8       | —             |
| Postmortem generation                             | DEFERRED     | V-318         | 4       | —             |
| Feature flags UI                                  | UNDISCOVERED | V-328         | 6       | —             |
| Plan configuration UI                             | UNDISCOVERED | V-329         | 4       | ToS           |
| Email template editor                             | UNDISCOVERED | V-330         | 6       | —             |
| Third-party integration config                    | UNDISCOVERED | V-331         | 6       | —             |
| Admin user management                             | UNDISCOVERED | V-332         | 4       | —             |
| Session takeover (support role)                   | UNDISCOVERED | V-NNN+        | 8       | privacy + ToS |
| Recipe management (admin)                         | UNDISCOVERED | V-NNN+        | 8       | —             |
| Webhook delivery monitor (cross-account)          | UNDISCOVERED | V-NNN+        | 4       | —             |
| Separate auth (email + password + mandatory TOTP) | DEFERRED     | V-333         | 6       | —             |
| IP allowlist enforcement (admin)                  | DEFERRED     | V-334         | 4       | —             |

### Surface 8 — SDKs (`packages/sdk-typescript`, `packages/sdk-python`, `packages/sdk-go`)

| Feature                                    | Status   | Slice | Tier-1h | Legal updates |
| ------------------------------------------ | -------- | ----- | ------- | ------------- |
| TypeScript SDK published (npm)             | SHIPPED  | V-NNN | —       | —             |
| Python SDK alpha + first PyPI tag          | DEFERRED | V-335 | 6       | —             |
| Go SDK alpha + first git tag               | DEFERRED | V-336 | 6       | —             |
| Webhook signature verifier (TS)            | SHIPPED  | V-NNN | —       | —             |
| Webhook signature verifier (Python)        | SHIPPED  | V-NNN | —       | —             |
| Webhook signature verifier (Go)            | SHIPPED  | V-337 | —       | —             |
| Streaming responses                        | DEFERRED | V-338 | 8       | —             |
| Idempotency-key support                    | DEFERRED | V-339 | 4       | —             |
| Scope-based permission helpers             | DEFERRED | V-340 | 4       | —             |
| Behavioral preset selectors                | DEFERRED | V-341 | 4       | —             |
| SOCKS5 / WireGuard / OpenVPN proxy helpers | DEFERRED | V-342 | 6       | privacy       |
| Challenge-handling helpers                 | DEFERRED | V-343 | 6       | —             |
| Recipe execution surface                   | DEFERRED | V-344 | 4       | —             |

### Surface 9 — Infrastructure + ops (`apps/server` + `infra/`)

| Feature                                  | Status   | Slice               | Tier-1h | Legal updates                 |
| ---------------------------------------- | -------- | ------------------- | ------- | ----------------------------- |
| Hetzner deploy automation                | SHIPPED  | V-278               | —       | —                             |
| 5 CF Pages deploy workflows              | SHIPPED  | V-258-V-260 + V-295 | —       | —                             |
| Sentry crash-only wiring                 | SHIPPED  | V-117 + V-242       | —       | —                             |
| Disaster recovery runbook                | SHIPPED  | V-NNN               | —       | —                             |
| Day-1 launch runbook                     | SHIPPED  | V-280               | —       | —                             |
| Pre-launch checklist                     | SHIPPED  | V-279 + V-287       | —       | —                             |
| Release policy doc                       | SHIPPED  | V-283               | —       | —                             |
| Sub-processor mirror linter              | SHIPPED  | V-271               | —       | —                             |
| Custom Sentry dashboards                 | DEFERRED | V-354               | 6       | —                             |
| Customer support response templates      | DEFERRED | V-355               | 8       | —                             |
| Discord / GitHub Discussions integration | DEFERRED | V-356               | 6       | DPA Annex 3 (Discord, GitHub) |
| AUP enforcement automation               | DEFERRED | V-358               | 8       | —                             |
| GDPR DSAR support endpoint               | DEFERRED | V-360               | 8       | privacy                       |
| Customer trust / SLA / retention surface | DEFERRED | V-359               | 6       | ToS + privacy                 |
| Performance optimization beyond V-286    | DEFERRED | V-351               | 8       | —                             |

### Surface 10 — AI agent layer (planning file 06)

| Feature                                   | Status                | Slice          | Tier-1h | Legal updates                 |
| ----------------------------------------- | --------------------- | -------------- | ------- | ----------------------------- |
| Agent execution service shell             | DEFERRED              | V-361          | 16      | privacy + DPA Annex 3 + ToS   |
| Natural language task input               | DEFERRED              | V-361          | 4       | —                             |
| Perception-reason-action loop             | UNDISCOVERED          | V-NNN+         | 24      | —                             |
| LLM integration (bundled-LLM provider)    | DEFERRED              | V-361          | 8       | DPA Annex 3 (already present) |
| Page representation (visual + structured) | UNDISCOVERED          | V-NNN+         | 16      | —                             |
| Streaming agent thoughts (SSE)            | UNDISCOVERED          | V-NNN+         | 8       | —                             |
| BYOK + bundled billing models             | SHIPPED (markup-only) | tier3_explicit | —       | —                             |
| Agent UI in dashboard                     | UNDISCOVERED          | V-NNN+         | 16      | —                             |
| Agent safety guardrails                   | UNDISCOVERED          | V-NNN+         | 16      | ToS                           |

(Note: full agent loop is post-v1 per planning file 00. V-361 ships the shell + scaffolding only. Most agent-loop features are OUT-OF-SCOPE for v1.)

### Surface 11 — Compliance + security

| Feature                             | Status       | Slice  | Tier-1h | Legal updates |
| ----------------------------------- | ------------ | ------ | ------- | ------------- |
| Encrypted at-rest (existing tables) | SHIPPED      | V-NNN  | —       | —             |
| Transparent retention policies      | IN-FLIGHT    | V-359  | 4       | privacy       |
| GDPR DSAR support                   | DEFERRED     | V-360  | 8       | privacy       |
| Data residency (EU-first)           | SHIPPED      | V-NNN  | —       | —             |
| AUP enforcement (real)              | DEFERRED     | V-358  | 8       | —             |
| Trial abuse detection               | UNDISCOVERED | V-NNN+ | 12      | privacy       |
| Fraud signal detection              | UNDISCOVERED | V-NNN+ | 12      | privacy       |
| KYB for higher tiers                | UNDISCOVERED | V-NNN+ | 12      | ToS           |
| Penetration testing                 | OUT-OF-SCOPE | year-2 | n/a     | —             |

### Surface 12 — Business operations

| Feature                              | Status       | Slice         | Tier-1h | Legal updates        |
| ------------------------------------ | ------------ | ------------- | ------- | -------------------- |
| Stripe Checkout + webhooks           | SHIPPED      | V-080 + V-082 | —       | —                    |
| Trial pack mechanics                 | SHIPPED      | ADR-003       | —       | —                    |
| Annual discount (20%)                | SHIPPED      | ADR-004       | —       | —                    |
| Quota enforcement per plan           | SHIPPED      | V-073 + V-251 | —       | —                    |
| Subscription management              | IN-FLIGHT    | V-300         | 4       | —                    |
| Multiple payment processors (Mollie) | UNDISCOVERED | V-NNN+        | 16      | DPA Annex 3 (Mollie) |
| VAT handling + MOSS                  | DEFERRED     | V-325         | 8       | —                    |
| Dunning UI                           | DEFERRED     | V-323         | 6       | —                    |
| Self-hosted licensing (v2)           | OUT-OF-SCOPE | year-2        | n/a     | ToS                  |

---

## Legal-page-update batch summary

Per the V-293-locked legal-page-auto-update methodology, V-295+ slices that introduce NEW PII / sub-processor / ToS scope update the relevant legal docs in the SAME commit. Counsel review queue accumulates.

**Estimated legal-page deltas across V-295+ arc**:

| Legal page                                             | Estimated changes             | Anchored slices                                                                                   |
| ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/marketing-site/src/pages/legal/privacy.md`       | ~12 sections                  | V-295, V-302, V-306, V-307, V-309, V-319, V-321, V-322, V-323, V-345, V-360                       |
| `apps/marketing-site/src/pages/legal/dpa.md` (Annex 3) | ~6 rows                       | V-295 (cron), V-306 (LiveKit), V-318, V-331, V-356 (Discord/GitHub), V-NNN (Mollie)               |
| `apps/marketing-site/src/pages/legal/terms.md` (ToS)   | ~8 clauses                    | V-295 (SLA), V-306 (live-stream), V-319 (impersonation), V-329 (plan configuration), V-358, V-359 |
| `apps/marketing-site/src/pages/legal/aup.md`           | ~3 sections                   | V-358, V-NNN (KYB)                                                                                |
| `docs/legal/changes-log.md`                            | new file; row per V-NNN slice | all                                                                                               |

**Counsel review trigger** (per V-279 founder action queue item 9): batch all changes-log entries pre-first-paying-customer. Decoupled from feature-ship cadence.

---

## Recommended priority order summary (founder Tier-2 ack required before V-295+ starts)

| Tier | Theme                                | Estimated slices | Tier-1 hours |
| ---- | ------------------------------------ | ---------------- | ------------ |
| 1    | Customer-facing trust + completeness | 22               | ~85          |
| 2    | Admin / ops tooling                  | 18               | ~75          |
| 3    | SDK feature parity                   | 10               | ~50          |
| 4    | Ops maturity + content + tests       | 17               | ~85          |

**Total**: 67 V-NNN slices × avg 4.4h = ~297 Tier-1 hours.

---

## Items explicitly OUT-OF-SCOPE for v1

Per founder direction "every previously-deferred feature ships in v1 unless V-294 surfaces it as legitimately out-of-scope (e.g. enterprise-tier features)":

- **Agent perception-reason-action loop full implementation** — 24h+ AI surface; v1 ships the shell (V-361) + dashboard task-entry UI; full agent loop is post-v1 per planning file 00.
- **Cross-region profile portability** — multi-region S3 replication. v1 stays single-region.
- **OpenVPN proxy support** — niche customer ask; SOCKS5 + WireGuard + HTTP cover the launch surface.
- **Mobile device control on iOS/Android** — accessing GUI client from a mobile device. Year-2.
- **Penetration testing** — annual engagement; year-2 budget.
- **Self-hosted licensing v2** — different commercial model; year-2.
- **Customer logos / case studies** — post-launch (no customers yet).
- **WebGPU on iOS 26 fingerprint surface** — Agent-1 territory; cross-repo dep.

---

## Open questions for founder Tier-2 ack

1. **Priority order confirmation** — recommended order above is `customer-trust → admin → SDK → ops`. Confirm or reorder.
2. **Slice granularity** — currently averaging 4.4h/slice. Some V-NNN entries (V-295 status page, V-306 WebRTC) span 16-24h; these may want intra-slice phases. Confirm.
3. **AI agent layer scope** — V-361 ships the shell only. Full agent loop = post-v1? Or do you want a deeper v1 agent surface (would add ~80h to scope)?
4. **WebRTC live-session streaming (LiveKit)** — biggest single-feature scope (~32h across V-306/V-307/V-308 + LiveKit DPA Annex 3 row). Confirm v1 inclusion vs deferral.
5. **Multi-payment-processor (Mollie)** — planning file 00/116 lists Mollie as primary; current launch has Stripe only. Confirm Mollie ships in v1 or stays Stripe-only.
6. **Team RBAC + multi-user** — ~20h across V-NNN+ slices. Confirm v1 vs post-v1.

V-295+ does NOT START until founder verdicts on the 6 above + an explicit "go" on the priority order. Pre-codegen scope review mandatory per V-294 founder direction.
