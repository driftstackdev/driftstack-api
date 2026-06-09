# Dependency-security audit — 2026-06-09 (W328)

A fresh audit dimension not previously covered (the code-audit veins are
exhausted; this is the _dependency_ attack surface via `npm audit`).

## Bottom line

**The prod server runtime is clean.** Both HIGH-severity advisories are in the
**astro build-toolchain for the static sites**, not the Fastify server runtime.
Real prod-server exposure: effectively nil. No urgent action; the clean fix is a
(breaking) astro 5→6 bump, tracked as a maintenance slice below.

## Findings (`npm audit --omit=dev`, prod tree)

16 prod-dep vulns (1 low, 13 moderate, **2 high**). The 2 HIGH:

| Advisory                                                                           | Package         | Pulled by                                           | Reachability                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-77vg-94rm-hx3p (devalue DoS, sparse-array deser.)                             | `devalue@5.8.0` | `astro@5.18.1`                                      | **Build-time only.** devalue runs during astro SSR/serialization at build; our sites build from trusted repo content → not attacker-reachable. Safe fix exists (5.8.1, a semver patch).                                                                 |
| GHSA-g9mf-h72j-4rw9 + 4 others (undici smuggling / decompression DoS / WS crashes) | `undici@7.14.0` | `@astrojs/cloudflare@12.6.13` (admin-panel adapter) | **Adapter/build-time.** This is the Cloudflare _adapter's_ undici, NOT the server's HTTP client. The server's own `undici` is `8.4.0` (NOT in the vulnerable `7.0.0–7.23.0` range) — the runtime outbound-HTTP path (webhooks, proxies, BYOK) is clean. |

The server's **direct** `undici` (`apps/server/package.json` → `^8.4.0`) is the one
that matters for runtime request-smuggling/DoS, and it is safe.

## Why not auto-fix this wave

- `npm audit fix` (non-breaking) only patches `devalue 5.8.0 → 5.8.1` — a
  build-time DoS that isn't realistically exploitable for our static sites.
- The `undici@7.14.0` transitive isn't safely fixable without either a breaking
  astro/adapter major bump or a risky transitive `overrides` that forces a major
  on the Cloudflare adapter (could break the adapter).
- The pre-push gate builds the _server_, not the astro sites, so a transitive
  bump affecting astro builds can't be verified here — and the admin-panel
  deploys via Cloudflare Pages (separate pipeline), so a bad bump would surface
  only at the next Pages build.
- Per "never manufacture churn": churning the lockfile + astro toolchain for a
  non-exploitable build-time advisory isn't warranted.

## Recommendation (founder-aware, tracked)

The clean remediation that refreshes BOTH transitives at once is the **astro 5 →
6 migration** — which is exactly the dependabot PR that currently **fails CI**
(`bump astro from 5.18.1 to 6.4.4`, run 27112312363). Astro 6 has breaking
changes across the 5 astro sites (marketing/docs/dashboard/admin/status), so it's
a deliberate maintenance slice, not an autopilot drop-in. Schedule it when the
astro sites can be built + smoke-tested together. Until then, real risk is low
(build-time, static, server runtime clean).
