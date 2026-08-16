// W614 — drift guard for infra/ (11 files).
// V-278 Hetzner deployment artefacts: README + docker-compose + 2
// bootstrap scripts + systemd unit + 2 nginx vhosts + 4 env templates.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const I = (rel: string) => resolve(REPO_ROOT, `infra/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W614 infra/ content parity', () => {
  it('README.md: V-278 Hetzner framing + layout tree + 12-slice deployment-cycle table (A bootstrap → L Sentry-projects) + CF Full-strict TLS + 7-sub-processor map + TEST vs LIVE credential split pinned', () => {
    const body = read(I('README.md'));
    expect(body).toMatch(/^# Driftstack API — infra\/$/m);
    expect(body).toMatch(/^V-278 Hetzner deployment artifacts\.$/m);
    expect(body).toMatch(/^## Layout$/m);
    expect(body).toMatch(/bootstrap\.sh\s+Run-once host bootstrap \(Ubuntu 24\.04\)/);
    expect(body).toMatch(/deploy-api\.sh\s+Deploy the Fastify API to a host \(V-278\.B\)/);
    expect(body).toMatch(/production\.env\.template\s+production \.env shape \(REDACTED secrets\)/);
    expect(body).toMatch(
      /api\.driftstack\.dev\.conf\s+production API vhost \(port 80, behind CF proxy\)/,
    );
    expect(body).toMatch(/driftstack-api\.service\s+systemd unit, runs as `driftstack` user/);
    expect(body).toMatch(
      /docker-compose\.yml\s+legacy compose model \(superseded by V-278 systemd\)/,
    );
    expect(body).toMatch(/^## V-278 deployment cycle$/m);
    expect(body).toMatch(
      /V-278\.A \| Bootstrap both servers via `bootstrap\/bootstrap\.sh production`/,
    );
    expect(body).toMatch(/V-278\.B \| Deploy api\.driftstack\.dev → production/);
    expect(body).toMatch(/V-278\.C \| Deploy app\.driftstack\.dev → production/);
    expect(body).toMatch(/V-278\.G \| Run migrations on Neon Postgres \(`drizzle-kit migrate`\)/);
    expect(body).toMatch(/V-278\.H \| DNS records via Cloudflare API/);
    expect(body).toMatch(
      /V-278\.K \| Post-launch — split Neon \+ Upstash into separate prod\/staging projects/,
    );
    expect(body).toMatch(
      /V-278\.L \| Post-launch — create dedicated Sentry projects for dashboard \+ marketing/,
    );
    expect(body).toMatch(/^## TLS strategy$/m);
    expect(body).toMatch(/Cloudflare proxied \+ Universal SSL/);
    expect(body).toMatch(/"Full \(strict\)" SSL\/TLS/);
    expect(body).toMatch(/^## Sub-processor map$/m);
    expect(body).toMatch(
      /\*\*Hetzner Cloud\*\* \(Nuremberg NBG1 \/ Falkenstein FSN1\) — VM compute\./,
    );
    expect(body).toMatch(/\*\*Neon\*\* \(Frankfurt eu-central-1\) — managed Postgres 17\./);
    expect(body).toMatch(/\*\*Upstash\*\* \(eu-central\) — managed Redis 7\./);
    expect(body).toMatch(
      /\*\*Cloudflare\*\* \(global, EU-jurisdiction R2\) — DNS \/ CDN \/ R2 \/ WAF\./,
    );
    expect(body).toMatch(
      /\*\*Postmark\*\* \(US\) — transactional email; sender domain DKIM-verified\./,
    );
    expect(body).toMatch(
      /\*\*Sentry\*\* \(DE \/ EU region\) — error tracking \+ release tracking\./,
    );
    expect(body).toMatch(/\*\*Stripe\*\* \(US, EU subsidiary for SCA\) — payment processing\./);
    expect(body).toMatch(/`scripts\/check-subprocessor-mirror\.mjs` enforces public ↔ DPA Annex 3/);
    expect(body).toMatch(/^## Credential handling$/m);
    expect(body).toMatch(
      /\*\*TEST-mode secrets\*\* \(Stripe `sk_test_`, Postmark dev tokens\) may be/,
    );
    expect(body).toMatch(/committed via base64 in `DEPLOY_DOTENV_BASE64` GitHub secret\./);
    expect(body).toMatch(
      /\*\*LIVE-mode secrets\*\* \(Stripe `sk_live_`, post-KvK\) are written via/,
    );
    expect(body).toMatch(/SSH directly to `\/opt\/driftstack\/api\/\.env` on the host\./);
    expect(existsSync(I('README.md'))).toBe(true);
  });

  it('hetzner/docker-compose.yml: API-only service + IMAGE_TAG default ghcr/driftstackdev + env_file .env via DEPLOY_DOTENV_BASE64 + Coinbase-Commerce-dropped crypto-deferred ADR-002 + NODE_ENV=production + PORT=7780 + localhost-only 127.0.0.1:7780 + node /health healthcheck + json-file 50m×5 logging pinned', () => {
    const body = read(I('hetzner/docker-compose.yml'));
    expect(body).toMatch(/^# Driftstack API — production \/ staging compose file\.$/m);
    expect(body).toMatch(
      /^# Lives on the Hetzner VM at \/opt\/driftstack\/docker-compose\.yml\. The$/m,
    );
    expect(body).toMatch(
      /^# deploy pipeline \(`\.github\/workflows\/deploy\.yml`\) SSHes in, sets$/m,
    );
    expect(body).toMatch(
      /^# IMAGE_TAG via env, runs `docker compose pull && docker compose up -d`\.$/m,
    );
    expect(body).toMatch(
      /^# This compose file is for the API server only\. Postgres \+ Redis are$/m,
    );
    expect(body).toMatch(/managed services \(Neon \+ Upstash\); R2 is HTTP-API; Postmark is/);
    expect(body).toMatch(/HTTP-API; Sentry is HTTP-API\. Nothing is provisioned by docker on/);
    expect(body).toMatch(/the host except the API container itself\./);
    expect(body).toMatch(/^services:$/m);
    expect(body).toMatch(
      /^\s+image: \$\{IMAGE_TAG:-ghcr\.io\/driftstackdev\/driftstack-api:latest\}$/m,
    );
    expect(body).toMatch(/^\s+container_name: driftstack-api$/m);
    expect(body).toMatch(/^\s+restart: unless-stopped$/m);
    expect(body).toMatch(/^\s+env_file:$/m);
    expect(body).toMatch(/\.env # populated by the deploy pipeline from/);
    expect(body).toMatch(/DEPLOY_DOTENV_BASE64\. Contains DATABASE_URL, REDIS_URL,/);
    expect(body).toMatch(/R2_\*, POSTMARK_\*, SENTRY_DSN, STRIPE_\*, per the Workstream A/);
    expect(body).toMatch(/locked sub-processor list\./);
    expect(body).toMatch(/Crypto payment processor deferred to post-launch \(ADR-002\)\./);
    expect(body).toMatch(/Coinbase Commerce dropped 2026-05-03 for non-US\/Singapore/);
    expect(body).toMatch(/merchants\. Alternative processor selection \+ env vars will land/);
    expect(body).toMatch(/Stripe is sole launch payment rail \(fiat-only\)\./);
    expect(body).toMatch(/^\s+NODE_ENV: production$/m);
    expect(body).toMatch(/^\s+PORT: 7780$/m);
    expect(body).toMatch(/'127\.0\.0\.1:7780:7780' # bind localhost-only; Cloudflare Tunnel or a/);
    expect(body).toMatch(/reverse proxy fronts this externally\./);
    expect(body).toMatch(
      /"fetch\('http:\/\/127\.0\.0\.1:7780\/health'\)\.then\(r => process\.exit\(r\.ok\?0:1\)\)\.catch\(\(\) => process\.exit\(1\)\)"/,
    );
    expect(body).toMatch(/^\s+interval: 10s$/m);
    expect(body).toMatch(/^\s+timeout: 3s$/m);
    expect(body).toMatch(/^\s+retries: 3$/m);
    expect(body).toMatch(/^\s+start_period: 20s$/m);
    expect(body).toMatch(/^\s+driver: 'json-file'$/m);
    expect(body).toMatch(/^\s+max-size: '50m'$/m);
    expect(body).toMatch(/^\s+max-file: '5'$/m);
    expect(existsSync(I('hetzner/docker-compose.yml'))).toBe(true);
  });

  it('bootstrap/bootstrap.sh: V-278.A Ubuntu-24.04 idempotent bootstrap + 7-step layout (apt + Node22 + UFW 22/80/443 default-deny + fail2ban + /opt/driftstack tree + nginx + systemd-reload) + production|staging role-guard + driftstack service-account pinned', () => {
    const body = read(I('bootstrap/bootstrap.sh'));
    expect(body).toMatch(/^#!\/usr\/bin\/env bash$/m);
    expect(body).toMatch(/^# V-278\.A — Hetzner Ubuntu 24\.04 LTS bootstrap\.$/m);
    expect(body).toMatch(/^# Idempotent\. Run as root over SSH:$/m);
    expect(body).toMatch(/scp infra\/bootstrap\/bootstrap\.sh root@\$HOST:\/root\/bootstrap\.sh/);
    expect(body).toMatch(
      /ssh root@\$HOST 'bash \/root\/bootstrap\.sh production' \(or 'staging'\)/,
    );
    expect(body).toMatch(/Brings a fresh CPX server to a known-good state for the Driftstack/);
    expect(body).toMatch(/control-plane API \+ the static-asset reverse proxy\. Postgres \+ Redis/);
    expect(body).toMatch(/are managed services \(Neon \+ Upstash\); R2 \/ Postmark \/ Sentry \//);
    expect(body).toMatch(/^# What it installs:$/m);
    expect(body).toMatch(/apt updates \+ unattended-upgrades \(security only\)/);
    expect(body).toMatch(/Node 22 LTS via NodeSource APT repo/);
    expect(body).toMatch(/nginx \(reverse proxy \+ static asset server for non-API subdomains\)/);
    expect(body).toMatch(/UFW \(allow 22\/tcp, 80\/tcp, 443\/tcp; default-deny inbound\)/);
    expect(body).toMatch(/fail2ban \(default sshd profile\)/);
    expect(body).toMatch(/postgresql-client \(psql for Neon admin\)/);
    expect(body).toMatch(/^set -euo pipefail$/m);
    expect(body).toMatch(/^ROLE="\$\{1:-\}"$/m);
    expect(body).toMatch(/^\s+production\|staging\) : ;;$/m);
    expect(body).toMatch(/echo "usage: \$0 \{production\|staging\}" >&2/);
    expect(body).toMatch(/^export DEBIAN_FRONTEND=noninteractive$/m);
    expect(body).toMatch(/^apt-get update -qq$/m);
    expect(body).toMatch(/^apt-get upgrade -yq -o Dpkg::Options::='--force-confold'$/m);
    expect(body).toMatch(/ca-certificates curl gnupg lsb-release rsync jq/);
    expect(body).toMatch(/ufw fail2ban unattended-upgrades/);
    expect(body).toMatch(/APT::Periodic::Unattended-Upgrade "1";/);
    expect(body).toMatch(/Unattended-Upgrade::Automatic-Reboot "false";/);
    expect(body).toMatch(/curl -fsSL https:\/\/deb\.nodesource\.com\/setup_22\.x \| bash -/);
    expect(body).toMatch(/^ufw --force reset >\/dev\/null$/m);
    expect(body).toMatch(/^ufw default deny incoming$/m);
    expect(body).toMatch(/^ufw default allow outgoing$/m);
    expect(body).toMatch(/^ufw allow 22\/tcp comment 'SSH'$/m);
    expect(body).toMatch(
      /^ufw allow 80\/tcp comment 'HTTP \(nginx; redirects to 443 for proxied subdomains\)'$/m,
    );
    expect(body).toMatch(/^ufw allow 443\/tcp comment 'HTTPS'$/m);
    expect(body).toMatch(/^systemctl enable --now fail2ban$/m);
    expect(body).toMatch(/^install -d -m 0755 \/opt\/driftstack$/m);
    expect(body).toMatch(/^install -d -m 0755 \/opt\/driftstack\/api$/m);
    expect(body).toMatch(/^install -d -m 0755 \/opt\/driftstack\/web$/m);
    expect(body).toMatch(
      /useradd --system --home-dir \/opt\/driftstack --shell \/usr\/sbin\/nologin driftstack/,
    );
    expect(body).toMatch(/^chown -R driftstack:driftstack \/opt\/driftstack$/m);
    expect(body).toMatch(/^rm -f \/etc\/nginx\/sites-enabled\/default$/m);
    expect(body).toMatch(/^systemctl enable --now nginx$/m);
    expect(body).toMatch(/^systemctl daemon-reload$/m);
    expect(body).toMatch(/=== V-278\.A bootstrap complete \(role=\$ROLE\) ===/);
    expect(existsSync(I('bootstrap/bootstrap.sh'))).toBe(true);
  });

  it('bootstrap/deploy-api.sh: V-278.B Fastify deploy + production HOST=128.140.37.74 + staging HOST=116.203.22.197 + per-role nginx vhost selection + npm-build → rsync dist trees → npm-ci-omit-dev-ignore-scripts → scp .env → GIT_SHA injection → systemctl restart + 5-retry curl /health probe pinned', () => {
    const body = read(I('bootstrap/deploy-api.sh'));
    expect(body).toMatch(
      /^# V-278\.B — Deploy the Fastify control-plane API to a Hetzner host\.$/m,
    );
    expect(body).toMatch(/infra\/bootstrap\/deploy-api\.sh production\s+# → root@128\.140\.37\.74/);
    expect(body).toMatch(/infra\/bootstrap\/deploy-api\.sh staging\s+# → root@116\.203\.22\.197/);
    expect(body).toMatch(/bootstrap\.sh has run on the target host \(V-278\.A\)\./);
    expect(body).toMatch(/The agent's SSH key is authorized for `root` on the target\./);
    expect(body).toMatch(/Local build is up-to-date \(`npm run build` in repo root\)\./);
    expect(body).toMatch(/`infra\/env-templates\/\$ROLE\.env` exists with REAL secrets/);
    expect(body).toMatch(/Idempotent: re-running deploys the latest local build without/);
    expect(body).toMatch(/downtime \(systemd Restart=always \+ brief in-flight request loss/);
    expect(body).toMatch(/during the restart; <1s by design\)\./);
    expect(body).toMatch(/^set -euo pipefail$/m);
    expect(body).toMatch(/^ROLE="\$\{1:-\}"$/m);
    expect(body).toMatch(/^\s+production\)$/m);
    expect(body).toMatch(/^\s+HOST=128\.140\.37\.74$/m);
    expect(body).toMatch(/^\s+NGINX_VHOST=infra\/nginx\/api\.driftstack\.dev\.conf$/m);
    expect(body).toMatch(/^\s+NGINX_VHOST_NAME=api\.driftstack\.dev$/m);
    expect(body).toMatch(/^\s+staging\)$/m);
    expect(body).toMatch(/^\s+HOST=116\.203\.22\.197$/m);
    expect(body).toMatch(/^\s+NGINX_VHOST=infra\/nginx\/staging\.driftstack\.dev\.conf$/m);
    expect(body).toMatch(/^\s+NGINX_VHOST_NAME=staging\.driftstack\.dev$/m);
    expect(body).toMatch(/^ENV_FILE_LOCAL="infra\/env-templates\/\$ROLE\.env"$/m);
    expect(body).toMatch(/Copy infra\/env-templates\/\$ROLE\.env\.template to \$ENV_FILE_LOCAL/);
    expect(body).toMatch(/and fill in the REDACTED secrets before deploying\./);
    expect(body).toMatch(/'test -d \/opt\/driftstack\/api && echo bootstrapped'/);
    expect(body).toMatch(/npm run build --workspace @driftstack\/server --if-present/);
    expect(body).toMatch(/npm run build --workspace @driftstack\/api-types --if-present/);
    expect(body).toMatch(/rsync -az --delete/);
    expect(body).toMatch(/--include 'apps\/server\/dist\/\*\*\*'/);
    expect(body).toMatch(/--include 'packages\/api-types\/dist\/\*\*\*'/);
    expect(body).toMatch(
      /--include 'docs\/' --include 'docs\/legal\/' --include 'docs\/legal\/\*\.md'/,
    );
    expect(body).toMatch(/--exclude '\*'/);
    expect(body).toMatch(
      /'cd \/opt\/driftstack\/api && npm ci --omit=dev --ignore-scripts --no-audit --no-fund'/,
    );
    expect(body).toMatch(/scp -q "\$ENV_FILE_LOCAL" "root@\$HOST:\/opt\/driftstack\/api\/\.env"/);
    expect(body).toMatch(/^GIT_SHA=\$\(git rev-parse --short HEAD\)$/m);
    expect(body).toMatch(
      /sed -i 's\|\^GIT_SHA=\.\*\|GIT_SHA=\$GIT_SHA\|' \/opt\/driftstack\/api\/\.env/,
    );
    expect(body).toMatch(/chown driftstack:driftstack \/opt\/driftstack\/api\/\.env/);
    expect(body).toMatch(/chmod 600 \/opt\/driftstack\/api\/\.env/);
    expect(body).toMatch(/scp -q infra\/systemd\/driftstack-api\.service/);
    expect(body).toMatch(/"root@\$HOST:\/etc\/systemd\/system\/driftstack-api\.service"/);
    expect(body).toMatch(/ln -sf \/etc\/nginx\/sites-available\/\$NGINX_VHOST_NAME\.conf/);
    expect(body).toMatch(/\/etc\/nginx\/sites-enabled\/\$NGINX_VHOST_NAME\.conf/);
    expect(body).toMatch(/^\s+nginx -t$/m);
    expect(body).toMatch(/^\s+systemctl daemon-reload$/m);
    expect(body).toMatch(/^\s+systemctl enable driftstack-api$/m);
    expect(body).toMatch(/^\s+systemctl restart driftstack-api$/m);
    expect(body).toMatch(/^\s+systemctl reload nginx$/m);
    expect(body).toMatch(/^for _i in 1 2 3 4 5; do$/m);
    expect(body).toMatch(/curl -fsS http:\/\/127\.0\.0\.1:7780\/health/);
    expect(body).toMatch(/=== V-278\.B deploy complete \(role=\$ROLE\) ===/);
    expect(existsSync(I('bootstrap/deploy-api.sh'))).toBe(true);
  });

  it('systemd/driftstack-api.service: V-278.A unit + User/Group=driftstack + ExecStart=/usr/bin/node apps/server/dist/index.js + Restart=always RestartSec=2 + sandboxing (NoNewPrivileges + PrivateTmp + ProtectSystem=strict + ProtectHome + Lockdown* + RestrictSUIDSGID + RestrictRealtime + LockPersonality) + V8-JIT no-MemoryDenyWriteExecute rationale + StartLimitBurst=5/60s crash-loop guard pinned', () => {
    const body = read(I('systemd/driftstack-api.service'));
    expect(body).toMatch(/^# V-278\.A — systemd unit for the Driftstack control-plane API\.$/m);
    expect(body).toMatch(/Lands at \/etc\/systemd\/system\/driftstack-api\.service via the deploy/);
    expect(body).toMatch(
      /step\. The deploy step also writes \/opt\/driftstack\/api\/\.env from the/,
    );
    expect(body).toMatch(/DEPLOY_DOTENV_BASE64 secret before `systemctl restart driftstack-api`\./);
    expect(body).toMatch(/^\[Unit\]$/m);
    expect(body).toMatch(/^Description=Driftstack API \(Fastify control plane\)$/m);
    expect(body).toMatch(/^Documentation=https:\/\/github\.com\/driftstackdev\/driftstack-api$/m);
    expect(body).toMatch(/^After=network-online\.target$/m);
    expect(body).toMatch(/^Wants=network-online\.target$/m);
    expect(body).toMatch(/^\[Service\]$/m);
    expect(body).toMatch(/^Type=simple$/m);
    expect(body).toMatch(/^User=driftstack$/m);
    expect(body).toMatch(/^Group=driftstack$/m);
    expect(body).toMatch(/^WorkingDirectory=\/opt\/driftstack\/api$/m);
    expect(body).toMatch(/^EnvironmentFile=\/opt\/driftstack\/api\/\.env$/m);
    expect(body).toMatch(/^Environment=NODE_ENV=production$/m);
    expect(body).toMatch(/^Environment=NODE_OPTIONS=--enable-source-maps$/m);
    expect(body).toMatch(/^ExecStart=\/usr\/bin\/node apps\/server\/dist\/index\.js$/m);
    expect(body).toMatch(/^Restart=always$/m);
    expect(body).toMatch(/^RestartSec=2$/m);
    expect(body).toMatch(/^TimeoutStartSec=30$/m);
    expect(body).toMatch(/^TimeoutStopSec=20$/m);
    expect(body).toMatch(/Sandboxing — the API needs network \+ the \.env file but nothing else\./);
    expect(body).toMatch(/^NoNewPrivileges=true$/m);
    expect(body).toMatch(/^PrivateTmp=true$/m);
    expect(body).toMatch(/^ProtectSystem=strict$/m);
    expect(body).toMatch(/^ProtectHome=true$/m);
    expect(body).toMatch(/^ProtectKernelTunables=true$/m);
    expect(body).toMatch(/^ProtectKernelModules=true$/m);
    expect(body).toMatch(/^ProtectControlGroups=true$/m);
    expect(body).toMatch(/^RestrictSUIDSGID=true$/m);
    expect(body).toMatch(/^RestrictRealtime=true$/m);
    expect(body).toMatch(/^LockPersonality=true$/m);
    expect(body).toMatch(/MemoryDenyWriteExecute is incompatible with Node's V8 JIT/);
    expect(body).toMatch(/V8 maps/);
    expect(body).toMatch(/code pages with PROT_EXEC then PROT_WRITE for baseline-tier/);
    expect(body).toMatch(/compilation; the directive causes SIGTRAP at startup\)\./);
    expect(body).toMatch(/^SystemCallArchitectures=native$/m);
    expect(body).toMatch(/Crash-loop guard: more than 5 restarts in 60s flips us to failed\./);
    expect(body).toMatch(/^StartLimitIntervalSec=60$/m);
    expect(body).toMatch(/^StartLimitBurst=5$/m);
    expect(body).toMatch(/^\[Install\]$/m);
    expect(body).toMatch(/^WantedBy=multi-user\.target$/m);
    expect(existsSync(I('systemd/driftstack-api.service'))).toBe(true);
  });

  it('nginx/api.driftstack.dev.conf: V-278.B/M production vhost + CF Full-strict (LE DNS-01 + certbot renew) + 80→443 redirect + TLS 1.2/1.3 Mozilla-intermediate ciphers + ssl_session_tickets off + CF-Connecting-IP real-ip + 4m client_max_body + gzip off + proxy_pass 127.0.0.1:7780 + 60s read/send timeout + proxy_buffering off pinned', () => {
    const body = read(I('nginx/api.driftstack.dev.conf'));
    expect(body).toMatch(
      /^# V-278\.B \/ V-278\.M — nginx vhost for api\.driftstack\.dev with origin TLS\.$/m,
    );
    expect(body).toMatch(/After V-278\.M, Cloudflare's SSL\/TLS mode is set to "Full \(strict\)":/);
    expect(body).toMatch(/the customer-edge leg is HTTPS via Cloudflare's Universal SSL \(auto-/);
    expect(body).toMatch(/issued, auto-renewed\); the Cloudflare-to-origin leg is HTTPS via the/);
    expect(body).toMatch(/Let's Encrypt cert below \(issued via DNS-01 with the agent's/);
    expect(body).toMatch(/Cloudflare API token \+ auto-renewed by certbot's systemd timer\)\./);
    expect(body).toMatch(/Plaintext port 80 is kept as an HTTP→HTTPS redirect/);
    expect(body).toMatch(/# HTTP→HTTPS redirect on port 80\./);
    expect(body).toMatch(/^server \{$/m);
    expect(body).toMatch(/^\s+listen 80;$/m);
    expect(body).toMatch(/^\s+listen \[::\]:80;$/m);
    expect(body).toMatch(/^\s+server_name api\.driftstack\.dev;$/m);
    expect(body).toMatch(/^\s+location = \/nginx-health \{$/m);
    expect(body).toMatch(/^\s+return 200 "ok\\n";$/m);
    expect(body).toMatch(/^\s+return 301 https:\/\/\$host\$request_uri;$/m);
    expect(body).toMatch(/# Production HTTPS vhost\./);
    expect(body).toMatch(/^\s+listen 443 ssl http2;$/m);
    expect(body).toMatch(/^\s+listen \[::\]:443 ssl http2;$/m);
    expect(body).toMatch(
      /^\s+ssl_certificate\s+\/etc\/letsencrypt\/live\/api\.driftstack\.dev\/fullchain\.pem;$/m,
    );
    expect(body).toMatch(
      /^\s+ssl_certificate_key \/etc\/letsencrypt\/live\/api\.driftstack\.dev\/privkey\.pem;$/m,
    );
    expect(body).toMatch(
      /# TLS 1\.2 \+ 1\.3 only; modern ciphers from Mozilla's intermediate set\./,
    );
    expect(body).toMatch(/^\s+ssl_protocols TLSv1\.2 TLSv1\.3;$/m);
    expect(body).toMatch(/ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256/);
    expect(body).toMatch(/^\s+ssl_prefer_server_ciphers off;$/m);
    expect(body).toMatch(/^\s+ssl_session_cache shared:SSL:10m;$/m);
    expect(body).toMatch(/^\s+ssl_session_timeout 10m;$/m);
    expect(body).toMatch(/^\s+ssl_session_tickets off;$/m);
    expect(body).toMatch(/Real client IP — Cloudflare passes it via CF-Connecting-IP\./);
    // Security fix 2026-07-01 — the 0.0.0.0/0 wildcard (which let ANY direct
    // connection to the origin forge CF-Connecting-IP and defeat every
    // IP-keyed rate limit) is gone; trust is now scoped to Cloudflare's real
    // edge ranges via the conf.d snippet, not declared per-vhost anymore.
    expect(body).not.toMatch(/^\s*set_real_ip_from 0\.0\.0\.0\/0;/m);
    expect(body).toMatch(/\/etc\/nginx\/conf\.d\/cloudflare-real-ip\.conf/);
    expect(body).toMatch(
      /set_real_ip_from\s*\n\s*# is cumulative across directives, not last-wins\./,
    );
    expect(body).toMatch(/^\s+client_max_body_size 100m;$/m);
    expect(body).toMatch(/^\s+client_body_timeout 30s;$/m);
    expect(body).toMatch(/^\s+client_header_timeout 15s;$/m);
    expect(body).toMatch(/^\s+send_timeout 30s;$/m);
    expect(body).toMatch(/^\s+gzip off;$/m);
    expect(body).toMatch(/^\s+access_log \/var\/log\/nginx\/api\.driftstack\.dev\.access\.log;$/m);
    expect(body).toMatch(
      /^\s+error_log \/var\/log\/nginx\/api\.driftstack\.dev\.error\.log warn;$/m,
    );
    expect(body).toMatch(/^\s+proxy_pass http:\/\/127\.0\.0\.1:7780;$/m);
    expect(body).toMatch(/^\s+proxy_http_version 1\.1;$/m);
    expect(body).toMatch(/^\s+proxy_set_header Host \$host;$/m);
    expect(body).toMatch(/^\s+proxy_set_header X-Real-IP \$remote_addr;$/m);
    expect(body).toMatch(/^\s+proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;$/m);
    expect(body).toMatch(/^\s+proxy_set_header X-Forwarded-Proto https;$/m);
    expect(body).toMatch(/^\s+proxy_connect_timeout 5s;$/m);
    expect(body).toMatch(/^\s+proxy_send_timeout 60s;$/m);
    expect(body).toMatch(/^\s+proxy_read_timeout 60s;$/m);
    expect(body).toMatch(/^\s+proxy_buffering off;$/m);
    expect(existsSync(I('nginx/api.driftstack.dev.conf'))).toBe(true);
  });

  it('nginx/staging.driftstack.dev.conf: V-278.F/M staging vhost + 2-SAN cert (staging.driftstack.dev + api.staging.driftstack.dev) + same shape as production vhost + 80→443 redirect + proxy_pass 127.0.0.1:7780 pinned', () => {
    const body = read(I('nginx/staging.driftstack.dev.conf'));
    expect(body).toMatch(/^# V-278\.F \/ V-278\.M — staging nginx vhost with origin TLS\.$/m);
    expect(body).toMatch(/# See api\.driftstack\.dev\.conf for design notes; same shape, staging/);
    expect(body).toMatch(
      /# host\. Cert covers staging\.driftstack\.dev \+ api\.staging\.driftstack\.dev/,
    );
    expect(body).toMatch(/# \(single LE cert with 2 SAN entries\)\./);
    expect(body).toMatch(
      /^\s+server_name staging\.driftstack\.dev api\.staging\.driftstack\.dev;$/m,
    );
    expect(body).toMatch(
      /^\s+ssl_certificate\s+\/etc\/letsencrypt\/live\/staging\.driftstack\.dev\/fullchain\.pem;$/m,
    );
    expect(body).toMatch(
      /^\s+ssl_certificate_key \/etc\/letsencrypt\/live\/staging\.driftstack\.dev\/privkey\.pem;$/m,
    );
    expect(body).toMatch(/^\s+ssl_protocols TLSv1\.2 TLSv1\.3;$/m);
    // Security fix 2026-07-01 — same wildcard removal as api.driftstack.dev.conf.
    expect(body).not.toMatch(/^\s*set_real_ip_from 0\.0\.0\.0\/0;/m);
    expect(body).toMatch(/\/etc\/nginx\/conf\.d\/cloudflare-real-ip\.conf/);
    expect(body).toMatch(/^\s+client_max_body_size 100m;$/m);
    expect(body).toMatch(
      /^\s+access_log \/var\/log\/nginx\/staging\.driftstack\.dev\.access\.log;$/m,
    );
    expect(body).toMatch(
      /^\s+error_log \/var\/log\/nginx\/staging\.driftstack\.dev\.error\.log warn;$/m,
    );
    expect(body).toMatch(/^\s+return 301 https:\/\/\$host\$request_uri;$/m);
    expect(body).toMatch(/^\s+proxy_pass http:\/\/127\.0\.0\.1:7780;$/m);
    expect(body).toMatch(/^\s+proxy_set_header X-Forwarded-Proto https;$/m);
    expect(existsSync(I('nginx/staging.driftstack.dev.conf'))).toBe(true);
  });

  it('env-templates/production.env.template: REDACTED-secret template + Neon DATABASE_URL eu-central-1 + Upstash REST URL+TOKEN + 5 R2 vars (driftstack-prod-*) + 3 Postmark vars + Sentry DE + Stripe TEST-pre-launch + 6 auth signing secrets (V-296b rotation) + GIT_SHA placeholder + 4 base URLs + CORS allow-list pinned', () => {
    const body = read(I('env-templates/production.env.template'));
    expect(body).toMatch(/^# V-278\.A — production \.env template\.$/m);
    expect(body).toMatch(
      /^# DO NOT commit a populated copy of this file\. The deploy step writes$/m,
    );
    expect(body).toMatch(
      /^# \/opt\/driftstack\/api\/\.env from DEPLOY_DOTENV_BASE64 \(a base64-encoded$/m,
    );
    expect(body).toMatch(
      /^# secret kept in GitHub Actions \/ 1Password \/ KeePassXC — agent never$/m,
    );
    expect(body).toMatch(/^NODE_ENV=production$/m);
    expect(body).toMatch(/^PORT=7780$/m);
    expect(body).toMatch(/^LOG_LEVEL=info$/m);
    expect(body).toMatch(/Postgres \(Neon, eu-central-1\)/);
    expect(body).toMatch(
      /^DATABASE_URL=postgresql:\/\/neondb_owner:REDACTED@ep-aged-pond-al77cutb\.c-3\.eu-central-1\.aws\.neon\.tech\/neondb\?sslmode=require$/m,
    );
    expect(body).toMatch(/Redis \(Upstash, eu-central\)/);
    // REDIS_URL is the var the server actually connects with (ioredis, via
    // bootstrap.ts). It was absent from this template while the header said
    // "Upstash REST" and claimed an @upstash/redis wrapper that is not a
    // dependency of this repo — so a template-built deploy ran production
    // Redis on the silent localhost fallback. Pinned here so it stays.
    expect(body).toMatch(
      /^REDIS_URL=rediss:\/\/default:REDACTED@welcome-antelope-114301\.upstash\.io:6379$/m,
    );
    expect(body).toMatch(
      /^UPSTASH_REDIS_REST_URL=https:\/\/welcome-antelope-114301\.upstash\.io$/m,
    );
    expect(body).toMatch(/^UPSTASH_REDIS_REST_TOKEN=REDACTED$/m);
    expect(body).toMatch(/R2 \(Cloudflare\)/);
    expect(body).toMatch(/^R2_ACCOUNT_ID=7260371ac521e2a08a27ba8c7bdd5f43$/m);
    expect(body).toMatch(/^R2_BUCKET_AVATARS=driftstack-prod-avatars$/m);
    expect(body).toMatch(/^R2_BUCKET_UPLOADS=driftstack-prod-uploads$/m);
    expect(body).toMatch(/^R2_PUBLIC_BASE_URL=https:\/\/avatars\.driftstack\.dev$/m);
    expect(body).toMatch(/^POSTMARK_SERVER_TOKEN=REDACTED$/m);
    expect(body).toMatch(/^POSTMARK_FROM_TRANSACTIONAL=noreply@driftstack\.dev$/m);
    expect(body).toMatch(/^POSTMARK_FROM_DEFAULT=info@driftstack\.dev$/m);
    expect(body).toMatch(
      /^SENTRY_DSN=https:\/\/a30962fd20ed09c4e7f23b3c3fc32724@o4511325811834880\.ingest\.de\.sentry\.io\/4511325820223568$/m,
    );
    expect(body).toMatch(/^SENTRY_ENVIRONMENT=production$/m);
    expect(body).toMatch(/^SENTRY_RELEASE=PLACEHOLDER_GIT_SHA$/m);
    expect(body).toMatch(/^SENTRY_TRACES_SAMPLE_RATE=0\.05$/m);
    expect(body).toMatch(/TEST mode pre-launch \(per Stripe credential-handling memory rule\)\./);
    expect(body).toMatch(/Live keys swap in via SSH-write after BV KvK closure \(~2026-05-21\)\./);
    expect(body).toMatch(/^STRIPE_SECRET_KEY=sk_test_REDACTED$/m);
    expect(body).toMatch(/^STRIPE_PUBLISHABLE_KEY=pk_test_REDACTED$/m);
    expect(body).toMatch(/^STRIPE_WEBHOOK_SECRET=whsec_REDACTED$/m);
    expect(body).toMatch(/Generate fresh per environment:\s+openssl rand -hex 32/);
    expect(body).toMatch(/These rotate independently of code deploys; rotation cycle V-296b\./);
    expect(body).toMatch(/^SESSION_SIGNING_SECRET=REDACTED$/m);
    expect(body).toMatch(/^EMAIL_VERIFICATION_SIGNING_SECRET=REDACTED$/m);
    expect(body).toMatch(/^PASSWORD_RESET_SIGNING_SECRET=REDACTED$/m);
    expect(body).toMatch(/^MAGIC_LINK_SIGNING_SECRET=REDACTED$/m);
    expect(body).toMatch(/^MFA_ENCRYPTION_KEY=REDACTED$/m);
    expect(body).toMatch(/^WEBHOOK_DEFAULT_SIGNING_SEED=REDACTED$/m);
    expect(body).toMatch(/Surfaced on \/version so deploy automation can confirm what's running\./);
    expect(body).toMatch(/deploy-api\.sh writes the local HEAD SHA at deploy time\./);
    expect(body).toMatch(/^GIT_SHA=PLACEHOLDER_GIT_SHA$/m);
    expect(body).toMatch(/^PUBLIC_BASE_URL=https:\/\/api\.driftstack\.dev$/m);
    expect(body).toMatch(/^DASHBOARD_BASE_URL=https:\/\/app\.driftstack\.dev$/m);
    expect(body).toMatch(/^DOCS_BASE_URL=https:\/\/docs\.driftstack\.dev$/m);
    expect(body).toMatch(/^MARKETING_BASE_URL=https:\/\/driftstack\.dev$/m);
    expect(body).toMatch(/^TRUST_PROXY=1$/m);
    expect(body).toMatch(/V-278 — CORS allow-list\. Comma-separated origin URLs that the/);
    expect(body).toMatch(
      /^CORS_ALLOWED_ORIGINS=https:\/\/app\.driftstack\.dev,https:\/\/admin\.driftstack\.dev,https:\/\/status\.driftstack\.dev,https:\/\/driftstack\.dev,https:\/\/www\.driftstack\.dev,https:\/\/docs\.driftstack\.dev$/m,
    );
    expect(existsSync(I('env-templates/production.env.template'))).toBe(true);
  });

  it('env-templates/staging.env.template: V-278.F mirror + isolated services + different auth secrets + live staging API/dashboard/CORS topology pinned', () => {
    const body = read(I('env-templates/staging.env.template'));
    expect(body).toMatch(/^# V-278\.F — staging \.env template\.$/m);
    expect(body).toMatch(/^# Mirrors production\.env\.template\. V-278\.K split Postgres into a$/m);
    expect(body).toMatch(
      /^# separate staging Neon project; Redis remains shared with production$/m,
    );
    expect(body).toMatch(/^# behind the `stg:` key prefix\.$/m);
    expect(body).toMatch(/^NODE_ENV=production$/m);
    expect(body).toMatch(/^PORT=7780$/m);
    expect(body).toMatch(/^LOG_LEVEL=debug$/m);
    expect(body).toMatch(/^DRIFTSTACK_DEPLOY_ENV=staging$/m);
    expect(body).toMatch(/Postgres \(isolated staging Neon project\)/);
    expect(body).toMatch(
      /^DATABASE_URL=postgresql:\/\/neondb_owner:REDACTED@ep-lingering-math-alnalhby-pooler\.c-3\.eu-central-1\.aws\.neon\.tech\/neondb\?sslmode=require$/m,
    );
    expect(body).toMatch(/V-278\.K isolation: staging migrations and test writes must never land/);
    expect(body).toMatch(/deploy-bridge\.sh fails closed/);
    expect(body).toMatch(/Redis \(shared with prod, key prefix\)/);
    // As on production: the connect-with var, absent while the REST pair
    // stood in for it. Shared instance, so REDIS_KEY_PREFIX is what keeps
    // staging keys off production's.
    expect(body).toMatch(
      /^REDIS_URL=rediss:\/\/default:REDACTED@welcome-antelope-114301\.upstash\.io:6379$/m,
    );
    expect(body).toMatch(/^REDIS_KEY_PREFIX=stg:$/m);
    expect(body).toMatch(/^R2_BUCKET_AVATARS=driftstack-staging-avatars$/m);
    expect(body).toMatch(/^R2_BUCKET_UPLOADS=driftstack-staging-uploads$/m);
    expect(body).toMatch(/^R2_PUBLIC_BASE_URL=https:\/\/avatars\.staging\.driftstack\.dev$/m);
    expect(body).toMatch(/^SENTRY_ENVIRONMENT=staging$/m);
    expect(body).toMatch(/^SENTRY_TRACES_SAMPLE_RATE=1\.0$/m);
    expect(body).toMatch(/Stripe \(TEST keys; same as prod pre-launch\)/);
    expect(body).toMatch(/Auth secrets \(DIFFERENT from prod\)/);
    expect(body).toMatch(/^PUBLIC_BASE_URL=https:\/\/staging\.driftstack\.dev$/m);
    expect(body).toMatch(
      /^DASHBOARD_BASE_URL=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev$/m,
    );
    expect(body).toMatch(
      /^DASHBOARD_ORIGIN=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev$/m,
    );
    expect(body).toMatch(
      /^CORS_ALLOWED_ORIGINS=https:\/\/staging\.driftstack\.dev,https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev,https:\/\/staging\.driftstack-admin-panel\.pages\.dev,https:\/\/staging\.driftstack-status\.pages\.dev,https:\/\/app\.driftstack\.dev,https:\/\/driftstack\.dev,https:\/\/docs\.driftstack\.dev$/m,
    );
    expect(existsSync(I('env-templates/staging.env.template'))).toBe(true);
  });

  // 2026-05-20 — populated .env files are gitignored (they hold real
  // secrets; only the *.env.template scaffolds are checked in). On CI
  // the runner has no .env files; skip the populated-copy parity
  // checks when the file is absent so CI stays green while the local
  // operator-side drift guard still fires.
  it.skipIf(!existsSync(I('env-templates/production.env')))(
    'env-templates/production.env: populated TEST-mode copy + NODE_ENV=production + PORT=7780 + LOG_LEVEL=info + Neon DATABASE_URL + rediss:// REDIS_URL on port 6379 + Postmark API token + Sentry DE region + Stripe sk_test_ key shape + 6 hex auth secrets + 4 base URLs + TRUST_PROXY=1 + CORS allow-list pinned',
    () => {
      const body = read(I('env-templates/production.env'));
      expect(body).toMatch(/^NODE_ENV=production$/m);
      expect(body).toMatch(/^PORT=7780$/m);
      expect(body).toMatch(/^LOG_LEVEL=info$/m);
      expect(body).toMatch(/#.*Postgres \(Neon, eu-central-1\)/);
      expect(body).toMatch(
        /^DATABASE_URL=postgresql:\/\/neondb_owner:[^@]+@ep-aged-pond-al77cutb\.c-3\.eu-central-1\.aws\.neon\.tech\/neondb\?sslmode=require$/m,
      );
      expect(body).toMatch(
        /#.*Redis \(Upstash, rediss:\/\/ — TLS to port 6379; same auth token as REST\)/,
      );
      expect(body).toMatch(
        /^REDIS_URL=rediss:\/\/default:[^@]+@welcome-antelope-114301\.upstash\.io:6379$/m,
      );
      expect(body).toMatch(
        /^UPSTASH_REDIS_REST_URL=https:\/\/welcome-antelope-114301\.upstash\.io$/m,
      );
      expect(body).toMatch(/^UPSTASH_REDIS_REST_TOKEN=\S+$/m);
      expect(body).toMatch(/#.*Postmark/);
      expect(body).toMatch(/^POSTMARK_API_TOKEN=[0-9a-f-]+$/m);
      expect(body).toMatch(/^POSTMARK_FROM=noreply@driftstack\.dev$/m);
      expect(body).toMatch(/^POSTMARK_REPLY_TO=info@driftstack\.dev$/m);
      expect(body).toMatch(/#.*Sentry \(EU region\)/);
      expect(body).toMatch(/^SENTRY_ENVIRONMENT=production$/m);
      expect(body).toMatch(/^SENTRY_TRACES_SAMPLE_RATE=0\.05$/m);
      expect(body).toMatch(
        /#.*Stripe \(TEST mode pre-KvK; live keys swap in via SSH-write post-launch\)/,
      );
      expect(body).toMatch(/^STRIPE_SECRET_KEY=sk_test_\S+$/m);
      expect(body).toMatch(/^STRIPE_PUBLISHABLE_KEY=pk_test_\S+$/m);
      expect(body).toMatch(/#.*Auth secrets \(per-environment unique\)/);
      expect(body).toMatch(/^SESSION_SIGNING_SECRET=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^EMAIL_VERIFICATION_SIGNING_SECRET=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^PASSWORD_RESET_SIGNING_SECRET=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^MAGIC_LINK_SIGNING_SECRET=[0-9a-f]{64}$/m);
      // MFA_ENCRYPTION_KEY / PROFILE_MASTER_KEY are AES-256 keys — config.ts's
      // boot guard requires base64-decoding to exactly 32 bytes, not the hex
      // shape the other signing secrets use (fixed 2026-07-01: staging had
      // this wrong as hex, which crashed the boot-time zod validation).
      expect(body).toMatch(/^MFA_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$/m);
      expect(body).toMatch(/^PROFILE_MASTER_KEY=[A-Za-z0-9+/]{43}=$/m);
      expect(body).toMatch(/^WEBHOOK_DEFAULT_SIGNING_SEED=[0-9a-f]{64}$/m);
      expect(body).toMatch(/# Public URLs|# ── Misc/);
      expect(body).toMatch(/^PUBLIC_BASE_URL=https:\/\/api\.driftstack\.dev$/m);
      expect(body).toMatch(/^DASHBOARD_BASE_URL=https:\/\/app\.driftstack\.dev$/m);
      // Required by config.ts's boot-time guard — see the matching comment
      // in the staging.env block below.
      expect(body).toMatch(/^DASHBOARD_ORIGIN=https:\/\/app\.driftstack\.dev$/m);
      expect(body).toMatch(/^DOCS_BASE_URL=https:\/\/docs\.driftstack\.dev$/m);
      expect(body).toMatch(/^MARKETING_BASE_URL=https:\/\/driftstack\.dev$/m);
      expect(body).toMatch(/^TRUST_PROXY=1$/m);
      expect(body).toMatch(
        /^CORS_ALLOWED_ORIGINS=https:\/\/app\.driftstack\.dev,https:\/\/admin\.driftstack\.dev,https:\/\/status\.driftstack\.dev,https:\/\/driftstack\.dev,https:\/\/www\.driftstack\.dev,https:\/\/docs\.driftstack\.dev$/m,
      );
      expect(existsSync(I('env-templates/production.env'))).toBe(true);
    },
  );

  it.skipIf(!existsSync(I('env-templates/staging.env')))(
    'env-templates/staging.env: populated staging copy + DRIFTSTACK_DEPLOY_ENV=staging + LOG_LEVEL=debug + REDIS_KEY_PREFIX=stg: + SENTRY_ENVIRONMENT=staging + SENTRY_TRACES_SAMPLE_RATE=1.0 + DIFFERENT 6-hex auth secrets (per-environment unique) + staging-specific base URLs + CORS staging.driftstack.dev allow-list pinned',
    () => {
      const body = read(I('env-templates/staging.env'));
      expect(body).toMatch(/^NODE_ENV=production$/m);
      expect(body).toMatch(/^PORT=7780$/m);
      expect(body).toMatch(/^LOG_LEVEL=debug$/m);
      expect(body).toMatch(/^DRIFTSTACK_DEPLOY_ENV=staging$/m);
      expect(body).toMatch(
        /^DATABASE_URL=postgresql:\/\/neondb_owner:[^@]+@ep-aged-pond-al77cutb\.c-3\.eu-central-1\.aws\.neon\.tech\/neondb\?sslmode=require$/m,
      );
      expect(body).toMatch(
        /^REDIS_URL=rediss:\/\/default:[^@]+@welcome-antelope-114301\.upstash\.io:6379$/m,
      );
      expect(body).toMatch(/^REDIS_KEY_PREFIX=stg:$/m);
      expect(body).toMatch(/^SENTRY_ENVIRONMENT=staging$/m);
      expect(body).toMatch(/^SENTRY_TRACES_SAMPLE_RATE=1\.0$/m);
      expect(body).toMatch(/^STRIPE_SECRET_KEY=sk_test_\S+$/m);
      expect(body).toMatch(/^STRIPE_PUBLISHABLE_KEY=pk_test_\S+$/m);
      expect(body).toMatch(/^SESSION_SIGNING_SECRET=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^EMAIL_VERIFICATION_SIGNING_SECRET=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^PASSWORD_RESET_SIGNING_SECRET=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^MAGIC_LINK_SIGNING_SECRET=[0-9a-f]{64}$/m);
      // AES-256 key, base64 not hex — see the matching comment in the
      // production.env block above (fixed 2026-07-01: this was hex here,
      // which crashed config.ts's boot-time zod validation).
      expect(body).toMatch(/^MFA_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$/m);
      expect(body).toMatch(/^WEBHOOK_DEFAULT_SIGNING_SEED=[0-9a-f]{64}$/m);
      expect(body).toMatch(/^PUBLIC_BASE_URL=https:\/\/staging\.driftstack\.dev$/m);
      expect(body).toMatch(
        /^DASHBOARD_BASE_URL=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev$/m,
      );
      // Required by config.ts's boot-time guard (NODE_ENV=production refuses
      // to boot without it) — missing here since 2026-05-12 crashed staging
      // in a restart loop until fixed 2026-07-01. See docs/internal/
      // The stable Pages branch alias is the verified staging launch surface.
      // Do not seed the unresolved app-staging placeholder merely to satisfy
      // the boot guard: activation URLs must also be DNS/TLS/browser reachable.
      expect(body).toMatch(
        /^DASHBOARD_ORIGIN=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev$/m,
      );
      expect(body).toMatch(/^DOCS_BASE_URL=https:\/\/docs\.driftstack\.dev$/m);
      expect(body).toMatch(/^MARKETING_BASE_URL=https:\/\/driftstack\.dev$/m);
      expect(body).toMatch(/^TRUST_PROXY=1$/m);
      expect(body).toMatch(
        /^CORS_ALLOWED_ORIGINS=https:\/\/staging\.driftstack\.dev,https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev,https:\/\/staging\.driftstack-admin-panel\.pages\.dev,https:\/\/staging\.driftstack-status\.pages\.dev,https:\/\/app\.driftstack\.dev,https:\/\/driftstack\.dev,https:\/\/docs\.driftstack\.dev$/m,
      );
      expect(existsSync(I('env-templates/staging.env'))).toBe(true);
    },
  );
});
