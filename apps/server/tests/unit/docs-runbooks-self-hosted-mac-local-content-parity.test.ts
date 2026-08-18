// W557.B — drift guard for /docs/runbooks/self-hosted-mac-local.md.
// V-333 full-local-stack-on-Mac runbook. Drift here either weakens
// the V-333b-Playwright-driver follow-up posture (would lose the
// real-browser-on-Mac upgrade path), drops the 6-surface dev port
// inventory (3000-API + 4321-customer + 4322-admin + 4323-mkt +
// 4324-docs + 4325-status), or weakens the TRUNCATE-reset-between-
// runs SQL discipline.
//
//   • V-333. Stand up entire control plane locally.
//   • V-336 npm run dev:all single-command concurrently.
//   • V-333b PlaywrightDriver pending — DRIVER=playwright +
//     PLAYWRIGHT_BROWSER=webkit/chromium/firefox.
//   • DRIVER=webkit returns DriverNotIntegratedError until WebKit
//     fork (Agent 1 repo) lands production driver.
//   • PUBLIC_API_BASE_URL defaults http://localhost:3000.
//   • GUI self-hosted default base http://localhost:3000 (matches dev API;
//     first-run wizard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/self-hosted-mac-local.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W557.B /docs/runbooks/self-hosted-mac-local.md content parity', () => {
  const body = read(LIB);

  it("Header + V-333 framing pinned: '# Self-hosted on macOS — full local stack runbook' + 'V-333. Stand up the entire Driftstack control plane on a Mac so you can exercise the API + GUI end-to-end without touching Hetzner or the Cloudflare-fronted production stack.' + 'Verifying the full sign-up → checkout → API key → session flow before each release.' + 'Reproducing customer-reported bugs locally.' + 'Founder-action validation (V-328 native bundle test, V-243 updater key generation, etc.).' + 'Pre-empting \"preparing to open real browsers\" — once the PlaywrightDriver lands (V-333b)' — pinned so the V-333-entire-control-plane + 4-use-case + V-328+V-243-founder-validation + V-333b-Playwright-pending commitment survives", () => {
    expect(body).toMatch(/^# Self-hosted on macOS — full local stack runbook$/m);
    expect(body).toMatch(/V-333\. Stand up the entire Driftstack control plane on a Mac so you/);
    expect(body).toMatch(/can exercise the API \+ GUI end-to-end without touching Hetzner or the/);
    expect(body).toMatch(/Cloudflare-fronted production stack\./);
    expect(body).toMatch(/- Verifying the full sign-up → checkout → API key → session flow/);
    expect(body).toMatch(/before each release\./);
    expect(body).toMatch(/- Reproducing customer-reported bugs locally\./);
    expect(body).toMatch(/- Founder-action validation \(V-328 native bundle test, V-243/);
    expect(body).toMatch(/updater key generation, etc\.\)\./);
    expect(body).toMatch(/- Pre-empting "preparing to open real browsers" — once the/);
    expect(body).toMatch(/PlaywrightDriver lands \(V-333b\)/);
  });

  it("Prerequisites + one-time setup framing pinned: 'macOS 12+ (Monterey or newer).' + 'Node.js 22+' + 'Docker Desktop (for Postgres 17 + Redis 7).' + 'Tauri prerequisites for the GUI client: Rust' + 'docker compose up -d' (default docker-compose.yml) + 'postgres on 127.0.0.1:5432 (db driftstack / user driftstack)' + 'redis on 127.0.0.1:6379' + 'npm run db:migrate --workspace @driftstack/server' — pinned so the macOS-12+ + Node-22+ + Docker-Postgres-17-Redis-7 + Tauri-Rust + 5432-driftstack-DB + 6379-Redis + db:migrate-@driftstack/server commitment survives. The compose file is docker-compose.yml (db/user/password all `driftstack` per .env.example + docker-compose.yml) — NOT a docker-compose.dev.yml (no such file) nor a driftstack_dev DB.", () => {
    expect(body).toMatch(/- macOS 12\+ \(Monterey or newer\)\./);
    expect(body).toMatch(/- Node\.js 22\+/);
    expect(body).toMatch(/- Docker Desktop \(for Postgres 17 \+ Redis 7\)\./);
    expect(body).toMatch(/- Tauri prerequisites for the GUI client: Rust/);
    expect(body).toMatch(/docker compose up -d/);
    expect(body).toMatch(/# {3}postgres on 127\.0\.0\.1:5432 \(db driftstack \/ user driftstack\)/);
    // The referenced compose file must actually exist (self-hoster runs it).
    expect(body).not.toMatch(/docker-compose\.dev\.yml/);
    expect(body).toMatch(/# {3}redis on 127\.0\.0\.1:6379/);
    expect(body).toMatch(/npm run db:migrate --workspace @driftstack\/server/);
  });

  it('V-336 dev:all + six deterministic non-colliding surface ports + local API default pinned', () => {
    expect(body).toMatch(/V-336 — single command starts every surface concurrently:/);
    expect(body).toMatch(/npm run dev:all/);
    expect(body).toMatch(/API server\s+\|\s+`npm run dev:server`\s+\|\s+<http:\/\/localhost:3000>/);
    expect(body).toMatch(
      /Customer dashboard \| `npm run dev:dashboard` \| <http:\/\/localhost:5173>/,
    );
    expect(body).toMatch(/Admin panel\s+\|\s+`npm run dev:admin`\s+\|\s+<http:\/\/localhost:5174>/);
    expect(body).toMatch(
      /Marketing site\s+\|\s+`npm run dev:marketing` \| <http:\/\/localhost:4321>/,
    );
    expect(body).toMatch(/Docs site\s+\|\s+`npm run dev:docs`\s+\|\s+<http:\/\/localhost:4322>/);
    expect(body).toMatch(
      /Status site\s+\|\s+`npm run dev:status`\s+\|\s+<http:\/\/localhost:4323>/,
    );
    expect(body).toMatch(/Open the customer dashboard at <http:\/\/localhost:5173>/);
    expect(body).toMatch(/`PUBLIC_API_BASE_URL` defaults to `http:\/\/localhost:3000` for all/);
    expect(body).toMatch(/Astro apps in dev — they pick up the local API automatically\./);
  });

  it("V-333b Playwright + DRIVER=webkit-NotIntegratedError framing pinned: '## Switch to the real browser path (V-333b — shipped)' + 'DRIVER=playwright' + 'PLAYWRIGHT_BROWSER=webkit  # or 'chromium' / 'firefox'' + 'Restart the API server. Sessions now spawn a real browser visible on the Mac desktop.' + 'Until V-333b ships, `DRIVER=webkit` returns `DriverNotIntegratedError` per design — the WebKit fork (Agent 1 repo) lands the production driver separately.' — pinned so the V-333b-pending + DRIVER=playwright-PLAYWRIGHT_BROWSER + 3-browser-options + DRIVER=webkit-NotIntegratedError + Agent-1-repo-separately commitment survives", () => {
    // V-866 — this section read "pending" and "once the PlaywrightDriver
    // lands" after it landed: PlaywrightDriver is a real 270-line Driver at
    // apps/server/src/drivers/playwright.ts and DRIVER=playwright is
    // selectable. One negative per stale sentence.
    expect(body, 'the pending heading is gone').not.toMatch(
      /## Switch to the real browser path \(V-333b — pending\)/,
    );
    expect(body, 'and the once-it-lands instruction').not.toMatch(
      /Once the PlaywrightDriver lands \(V-333b\), set in/,
    );
    expect(body, 'the section records the driver as shipped').toMatch(
      /## Switch to the real browser path \(V-333b — shipped\)/,
    );
    expect(body).toMatch(/DRIVER=playwright/);
    expect(body).toMatch(/PLAYWRIGHT_BROWSER=webkit {2}# or 'chromium' \/ 'firefox'/);
    expect(body).toMatch(/Restart the API server\. Sessions now spawn a real browser visible on/);
    expect(body).toMatch(/the Mac desktop\./);
    // The webkit CONCLUSION is still true — every method of drivers/webkit.ts
    // throws — but its premise died with V-333b. Right answer, dead reason.
    expect(body, 'the dead premise is gone').not.toMatch(/Until V-333b ships, `DRIVER=webkit`/);
    expect(body, 'the behaviour itself still holds and is still pinned').toMatch(
      /`DRIVER=webkit` returns `DriverNotIntegratedError` per design/,
    );
    expect(body, 'and it is decoupled from V-333b').toMatch(
      /conditional on V-333b, which has shipped/,
    );
    expect(body, 'the Agent-1-fork attribution survives the rewrap').toMatch(
      /is the fork in the Agent 1 repo and lands separately\./,
    );
  });

  it("Reset-between-runs + common-pitfalls framing pinned: 'TRUNCATE TABLE' + 'sessions, profiles, api_keys, web_sessions, accounts, account_audit_log' + 'admin_audit_log, webhook_endpoints, webhook_deliveries, stripe_events' + 'subscriptions, usage_records, rate_limit_overrides, status_subscribers' + 'incidents, incident_updates, scheduled_jobs, team_members, team_invites' + 'legal_acceptances RESTART IDENTITY CASCADE' + 'docker compose exec redis redis-cli FLUSHALL' + '**GUI's First-Run Wizard fails**: usually a base-URL mismatch. The GUI self-hosted default is `http://localhost:3000` (matches the dev API) per `apps/gui-client/src/lib/settings.ts`' + '**Migrations fail with \"extension uuid-ossp not found\"**' + 'docker compose down -v && docker compose' + '**Tauri dev hangs at \"Compiling tauri\"**: cold compile is slow on Apple Silicon (~3 min); warm rebuilds are <10s.' — pinned so the TRUNCATE-CASCADE-table-inventory + Redis-FLUSHALL + GUI-self-hosted-default-3000 + uuid-ossp-down-v + Tauri-cold-3min-warm-10s commitment survives", () => {
    expect(body).toMatch(/TRUNCATE TABLE/);
    expect(body).toMatch(
      /sessions, profiles, api_keys, web_sessions, accounts, account_audit_log,/,
    );
    expect(body).toMatch(/admin_audit_log, webhook_endpoints, webhook_deliveries, stripe_events,/);
    expect(body).toMatch(/subscriptions, usage_records, rate_limit_overrides, status_subscribers,/);
    expect(body).toMatch(
      /incidents, incident_updates, scheduled_jobs, team_members, team_invites,/,
    );
    expect(body).toMatch(/legal_acceptances RESTART IDENTITY CASCADE;/);
    expect(body).toMatch(/docker compose exec redis redis-cli FLUSHALL/);
    expect(body).toMatch(/- \*\*GUI's First-Run Wizard fails\*\*: usually a base-URL mismatch/);
    expect(body).toMatch(/self-hosted default is `http:\/\/localhost:3000` \(matches the dev/);
    // Regression: the GUI default flipped 7780 → 3000 on 2026-05-20
    // (FirstRunWizard.tsx + settings.ts DEFAULT_SETTINGS) — the runbook
    // must not resurrect the stale 7780 default.
    expect(body).not.toMatch(/7780/);
    expect(body).toMatch(/`apps\/gui-client\/src\/lib\/settings\.ts`/);
    expect(body).toMatch(/- \*\*Migrations fail with "extension uuid-ossp not found"\*\*/);
    expect(body).toMatch(/docker compose down -v && docker compose/);
    expect(body).toMatch(/- \*\*Tauri dev hangs at "Compiling tauri"\*\*: cold compile is slow on/);
    expect(body).toMatch(/Apple Silicon \(~3 min\); warm rebuilds are <10s\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
