// W557.C — drift guard for /docs/runbooks/v295c-status-site-cf-pages.md.
// V-295c founder one-time CF Pages + DNS + R2 setup. Drift here
// either weakens the separate-public-R2-bucket discipline (would
// invite making the recordings bucket public — compliance break),
// drops the 5-step CF Pages build settings inventory (would lose
// the Astro preset / build cmd / output-dir contract), or weakens
// the V-295c2 R2-fallback posture (status page must survive API
// outages).
//
//   • V-295c. Founder-facing one-time setup.
//   • CF Pages project: driftstack-status; production branch main.
//   • Build: npm install && npm run build --workspace
//     apps/status-site; output apps/status-site/dist.
//   • PUBLIC_API_BASE_URL=https://api.driftstack.dev (prod).
//   • PUBLIC_STATUS_R2_URL — V-295c2 R2 fallback.
//   • Separate R2 bucket (`driftstack-public`) — recordings bucket
//     STAYS private (Customer Data, public would be compliance break).
//   • CNAME: status → driftstack-status.pages.dev, Proxied.
//   • Hermetic build — does NOT call API at build time.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/v295c-status-site-cf-pages.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W557.C /docs/runbooks/v295c-status-site-cf-pages.md content parity', () => {
  const body = read(LIB);

  it("Header + V-295c + auto-deploy framing pinned: '# V-295c — status.driftstack.dev Cloudflare Pages runbook' + 'Founder-facing one-time setup for the status page CF Pages project + DNS. Once these steps are done the GitHub-Pages-style auto-deploy takes over; future commits to `main` redeploy the static bundle from `apps/status-site/dist/`.' + 'Cloudflare account with `driftstack.dev` zone already managed' + 'GitHub access to `driftstackdev/driftstack-api`.' — pinned so the V-295c-founder-one-time + auto-deploy-after-setup + apps/status-site/dist-static-bundle + Cloudflare-driftstack.dev-zone + GitHub-driftstackdev-access commitment survives", () => {
    expect(body).toMatch(/^# V-295c — status\.driftstack\.dev Cloudflare Pages runbook$/m);
    expect(body).toMatch(/Founder-facing one-time setup for the status page CF Pages project \+/);
    expect(body).toMatch(/DNS\. Once these steps are done the GitHub-Pages-style auto-deploy/);
    expect(body).toMatch(/takes over; future commits to `main` redeploy the static bundle from/);
    expect(body).toMatch(/`apps\/status-site\/dist\/`\./);
    expect(body).toMatch(/- Cloudflare account with `driftstack\.dev` zone already managed/);
    expect(body).toMatch(/- GitHub access to `driftstackdev\/driftstack-api`\./);
  });

  it("5-step CF Pages project setup framing pinned: '## One-time CF Pages project setup' + '**Workers & Pages** → **Create** → **Pages** → **Connect to Git** → select `driftstackdev/driftstack-api`.' + '**Project name**: `driftstack-status` (the deploy URL becomes `driftstack-status.pages.dev`' + '**Production branch**: `main`.' + '**Build settings**' + 'Framework preset: **Astro**' + 'Build command: `npm install && npm run build --workspace apps/status-site`' + 'Build output directory: `apps/status-site/dist`' + 'Root directory: leave empty (the project is a workspace)' + '**Environment variables** (production + preview)' + '`PUBLIC_API_BASE_URL` = `https://api.driftstack.dev`' + '`PUBLIC_STATUS_R2_URL`' + '**Save and Deploy**. The first build runs ~90s.' — pinned so the 5-step-CF-Pages + driftstack-status-project + main-production-branch + Astro-preset + build-cmd-workspace + dist-output-dir + PUBLIC_API_BASE_URL + PUBLIC_STATUS_R2_URL + Save-Deploy-~90s commitment survives", () => {
    expect(body).toMatch(/## One-time CF Pages project setup/);
    expect(body).toMatch(/\*\*Workers & Pages\*\* → \*\*Create\*\* → \*\*Pages\*\* →/);
    expect(body).toMatch(/\*\*Connect to Git\*\* → select `driftstackdev\/driftstack-api`\./);
    expect(body).toMatch(/2\. \*\*Project name\*\*: `driftstack-status` \(the deploy URL becomes/);
    expect(body).toMatch(/`driftstack-status\.pages\.dev`;/);
    expect(body).toMatch(/3\. \*\*Production branch\*\*: `main`\./);
    expect(body).toMatch(/4\. \*\*Build settings\*\*:/);
    expect(body).toMatch(/- Framework preset: \*\*Astro\*\*/);
    expect(body).toMatch(
      /- Build command: `npm install && npm run build --workspace apps\/status-site`/,
    );
    expect(body).toMatch(/- Build output directory: `apps\/status-site\/dist`/);
    expect(body).toMatch(/- Root directory: leave empty \(the project is a workspace\)/);
    expect(body).toMatch(/5\. \*\*Environment variables\*\* \(production \+ preview\)/);
    expect(body).toMatch(/- `PUBLIC_API_BASE_URL` = `https:\/\/api\.driftstack\.dev`/);
    expect(body).toMatch(/- `PUBLIC_STATUS_R2_URL`/);
    expect(body).toMatch(/Click \*\*Save and Deploy\*\*\. The first build runs ~90s\./);
  });

  it("V-295c2 R2-public-bucket + compliance-break framing pinned: '## R2 public bucket (V-295c2 fallback)' + 'The status site falls back to a public R2 object when the live API is unreachable.' + '**A separate R2 bucket** holds this object — the recordings bucket stays private (it contains Customer Data; making it public would be a compliance break).' + '`driftstack-public` (or chosen name). Region: same as the recordings bucket (EU per data-residency).' + '**Custom domain** → connect `r2-public.driftstack.dev`' + 'Set the API server env `R2_BUCKET_PUBLIC` to the new bucket name in the Hetzner deploy `.env`.' + 'snapshot writer poller should produce the file' + 'curl -sS https://r2-public.driftstack.dev/status/incidents-public.json' + 'If `R2_BUCKET_PUBLIC` is unset the API server logs a warning at boot and the snapshot writer is disabled' — pinned so the V-295c2-R2-fallback + separate-bucket-recordings-stays-private + Customer-Data-compliance-break + driftstack-public-EU + r2-public.driftstack.dev-custom-domain + R2_BUCKET_PUBLIC-env + snapshot-writer-disabled-if-unset commitment survives", () => {
    expect(body).toMatch(/## R2 public bucket \(V-295c2 fallback\)/);
    expect(body).toMatch(/The status site falls back to a public R2 object when the live API is/);
    expect(body).toMatch(/unreachable\./);
    expect(body).toMatch(/\*\*A separate R2 bucket\*\* holds this object — the recordings/);
    expect(body).toMatch(
      /bucket stays private \(it contains Customer Data; making it public would/,
    );
    expect(body).toMatch(/be a compliance break\)\./);
    expect(body).toMatch(/`driftstack-public` \(or chosen name\)\. Region: same as the recordings/);
    expect(body).toMatch(/bucket \(EU per data-residency\)\./);
    expect(body).toMatch(/\*\*Custom domain\*\* →\s*connect `r2-public\.driftstack\.dev`/);
    expect(body).toMatch(/3\. Set the API server env `R2_BUCKET_PUBLIC` to the new bucket name in/);
    expect(body).toMatch(/the Hetzner deploy `\.env`\./);
    expect(body).toMatch(/snapshot writer poller should produce the file/);
    expect(body).toMatch(
      /curl -sS https:\/\/r2-public\.driftstack\.dev\/status\/incidents-public\.json/,
    );
    expect(body).toMatch(
      /If `R2_BUCKET_PUBLIC` is unset the API server logs a warning at boot and/,
    );
    expect(body).toMatch(/the snapshot writer is disabled;/);
  });

  it("DNS CNAME + verification + re-deploy semantics framing pinned: '## DNS — point status.driftstack.dev at the Pages project' + 'Name: `status`' + 'Target: `driftstack-status.pages.dev`' + 'Proxy status: **Proxied** (orange cloud — keeps Cloudflare's TLS, HTTP/3, and caching layer in front).' + '## Verification (post-deploy, founder runs once)' + 'Visit `https://status.driftstack.dev/`.' + '\"All systems operational\" (green dot)' + '`https://api.driftstack.dev/v1/status/incidents` returns 200 with `{ data: [...] }`.' + 'Post a test incident from the admin panel (`/incidents` → \"Post new incident\") with `public=true`.' + '## Re-deploy semantics' + 'Every push to `main` that touches `apps/status-site/**` triggers a Pages build automatically.' + 'Pages keeps the previous deployment available for instant rollback' + 'The build is hermetic — it does NOT call the API at build time.' — pinned so the CNAME-Proxied-orange-cloud + 4-step-verification + green-dot-All-systems-operational + auto-build-on-apps/status-site-push + previous-deployment-rollback + hermetic-no-API-at-build commitment survives", () => {
    expect(body).toMatch(/## DNS — point status\.driftstack\.dev at the Pages project/);
    expect(body).toMatch(/- Name: `status`/);
    expect(body).toMatch(/- Target: `driftstack-status\.pages\.dev`/);
    expect(body).toMatch(
      /- Proxy status: \*\*Proxied\*\* \(orange cloud — keeps Cloudflare's TLS,/,
    );
    expect(body).toMatch(/HTTP\/3, and caching layer in front\)\./);
    expect(body).toMatch(/## Verification \(post-deploy, founder runs once\)/);
    expect(body).toMatch(/1\. Visit `https:\/\/status\.driftstack\.dev\/`\./);
    expect(body).toMatch(/"All systems operational" \(green dot\)/);
    expect(body).toMatch(
      /`https:\/\/api\.driftstack\.dev\/v1\/status\/incidents` returns 200 with/,
    );
    expect(body).toMatch(/`\{ data: \[\.\.\.\] \}`\./);
    expect(body).toMatch(/3\. Post a test incident from the admin panel/);
    expect(body).toMatch(/\(`\/incidents` → "Post new incident"\) with `public=true`\./);
    expect(body).toMatch(/## Re-deploy semantics/);
    expect(body).toMatch(
      /- Every push to `main` that touches `apps\/status-site\/\*\*` triggers a/,
    );
    expect(body).toMatch(/Pages build automatically\./);
    expect(body).toMatch(/- Pages keeps the previous deployment available for instant rollback/);
    expect(body).toMatch(/- The build is hermetic — it does NOT call the API at build time\./);
  });

  it("Failure modes framing pinned: '## Failure modes' + '**API down**: the page shows \"Status currently unavailable\"; the page itself stays up because it's static HTML on Cloudflare's CDN. V-295c2 will add an R2-mirrored snapshot fallback' + '**CF Pages outage**: extremely rare; the only mitigation is multi-CDN, which is out of scope until traffic justifies it.' + 'CF Pages shares the same SLA as Cloudflare's edge, which is the same edge that fronts api.driftstack.dev.' + '**DNS misconfiguration**: covered by step-2 verification above.' + 'If `status.driftstack.dev` returns a CF \"page not found\" error, the CNAME is wrong; if TLS fails, the custom-domain hookup in CF Pages is incomplete.' — pinned so the 3-failure-mode (API-down + CF-Pages-outage + DNS-misconfig) + Status-currently-unavailable + V-295c2-R2-fallback + multi-CDN-out-of-scope + CF-edge-same-SLA + CNAME-wrong-vs-custom-domain-incomplete commitment survives", () => {
    expect(body).toMatch(/## Failure modes/);
    expect(body).toMatch(/- \*\*API down\*\*: the page shows "Status currently unavailable"; the/);
    expect(body).toMatch(/page itself stays up because it's static HTML on Cloudflare's CDN\./);
    expect(body).toMatch(/V-295c2 will add an R2-mirrored snapshot fallback/);
    expect(body).toMatch(
      /- \*\*CF Pages outage\*\*: extremely rare; the only mitigation is multi-/,
    );
    expect(body).toMatch(/CDN, which is out of scope until traffic justifies it\./);
    expect(body).toMatch(/CF Pages/);
    expect(body).toMatch(/shares the same SLA as Cloudflare's edge, which is the same edge/);
    expect(body).toMatch(/that fronts api\.driftstack\.dev\./);
    expect(body).toMatch(/- \*\*DNS misconfiguration\*\*: covered by step-2 verification above\./);
    expect(body).toMatch(/If\s*`status\.driftstack\.dev` returns a CF "page not found" error, the/);
    expect(body).toMatch(/CNAME is wrong; if TLS fails, the custom-domain hookup in CF Pages/);
    expect(body).toMatch(/is incomplete\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
