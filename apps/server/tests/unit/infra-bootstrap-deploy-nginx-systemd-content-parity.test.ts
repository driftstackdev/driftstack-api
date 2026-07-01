// W806 — infra/ bootstrap + deploy + nginx + systemd content parity.
// One-hundred-thirty-second in the drift-guard series. Pins the
// production-deploy surface: V-278.A bootstrap.sh + V-278.B
// deploy-api.sh + V-278.A systemd unit + V-278.B/M nginx vhosts.
// Drift in TLS ciphers, sandboxing directives, or rsync includes
// would either break security posture or fail the deploy silently.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const BOOTSTRAP = resolve(REPO_ROOT, 'infra/bootstrap/bootstrap.sh');
const DEPLOY = resolve(REPO_ROOT, 'infra/bootstrap/deploy-api.sh');
const SYSTEMD = resolve(REPO_ROOT, 'infra/systemd/driftstack-api.service');
const NGINX_PROD = resolve(REPO_ROOT, 'infra/nginx/api.driftstack.dev.conf');
const NGINX_STG = resolve(REPO_ROOT, 'infra/nginx/staging.driftstack.dev.conf');

describe('W806 infra bootstrap + deploy + nginx + systemd parity', () => {
  it('all 5 infra files exist at canonical paths', () => {
    for (const f of [BOOTSTRAP, DEPLOY, SYSTEMD, NGINX_PROD, NGINX_STG]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  // ─── systemd unit — V-278.A sandboxing ────────────────────────

  it('CRITICAL systemd unit V-278.A anchor + service identity pinned. Description + Documentation + WorkingDirectory + EnvironmentFile + ExecStart shape define the canonical service boot.', () => {
    const p = read(SYSTEMD);
    expect(p).toMatch(/# V-278\.A — systemd unit for the Driftstack control-plane API\./);
    expect(p).toMatch(/Description=Driftstack API \(Fastify control plane\)/);
    expect(p).toMatch(/Documentation=https:\/\/github\.com\/driftstackdev\/driftstack-api/);
    expect(p).toMatch(/User=driftstack\nGroup=driftstack/);
    expect(p).toMatch(/WorkingDirectory=\/opt\/driftstack\/api/);
    expect(p).toMatch(/EnvironmentFile=\/opt\/driftstack\/api\/\.env/);
    expect(p).toMatch(/ExecStart=\/usr\/bin\/node apps\/server\/dist\/index\.js/);
  });

  it("CRITICAL systemd 9-sandbox-directive set pinned — NoNewPrivileges + PrivateTmp + ProtectSystem=strict + ProtectHome + ProtectKernelTunables + ProtectKernelModules + ProtectControlGroups + RestrictSUIDSGID + RestrictRealtime + LockPersonality. Drift to dropping any would weaken the sandbox; drift to enabling MemoryDenyWriteExecute would break Node's V8 JIT.", () => {
    const p = read(SYSTEMD);
    expect(p).toMatch(/^NoNewPrivileges=true$/m);
    expect(p).toMatch(/^PrivateTmp=true$/m);
    expect(p).toMatch(/^ProtectSystem=strict$/m);
    expect(p).toMatch(/^ProtectHome=true$/m);
    expect(p).toMatch(/^ProtectKernelTunables=true$/m);
    expect(p).toMatch(/^ProtectKernelModules=true$/m);
    expect(p).toMatch(/^ProtectControlGroups=true$/m);
    expect(p).toMatch(/^RestrictSUIDSGID=true$/m);
    expect(p).toMatch(/^RestrictRealtime=true$/m);
    expect(p).toMatch(/^LockPersonality=true$/m);
  });

  it("CRITICAL systemd MemoryDenyWriteExecute incompatibility comment pinned. The 'incompatible with Node\\'s V8 JIT (V8 maps code pages with PROT_EXEC then PROT_WRITE for baseline-tier compilation; the directive causes SIGTRAP at startup)' wording is the load-bearing 'don\\'t enable this' anchor.", () => {
    const p = read(SYSTEMD);
    expect(p).toMatch(
      /# MemoryDenyWriteExecute is incompatible with Node's V8 JIT \(V8 maps\s*\n# code pages with PROT_EXEC then PROT_WRITE for baseline-tier\s*\n# compilation; the directive causes SIGTRAP at startup\)\./,
    );
  });

  it('CRITICAL systemd NODE_ENV=production + NODE_OPTIONS=--enable-source-maps pinned. Source maps are required for human-readable stack traces in Sentry; drift would either lose them or downgrade NODE_ENV.', () => {
    const p = read(SYSTEMD);
    expect(p).toMatch(/Environment=NODE_ENV=production/);
    expect(p).toMatch(/Environment=NODE_OPTIONS=--enable-source-maps/);
  });

  it('CRITICAL systemd crash-loop guard pinned — StartLimitIntervalSec=60 + StartLimitBurst=5 + Restart=always + RestartSec=2. More than 5 restarts in 60s flips to failed; drift would either thrash the host or never recover.', () => {
    const p = read(SYSTEMD);
    expect(p).toMatch(/Restart=always/);
    expect(p).toMatch(/RestartSec=2/);
    expect(p).toMatch(/StartLimitIntervalSec=60/);
    expect(p).toMatch(/StartLimitBurst=5/);
  });

  // ─── nginx vhosts — V-278.B / V-278.M ─────────────────────────

  it("CRITICAL prod nginx vhost V-278.B/V-278.M anchor + 'Full (strict)' Cloudflare-origin-TLS framing pinned. Drift to plaintext origin (Cloudflare 'Flexible') would let attackers MitM the origin leg even with Universal SSL at the edge.", () => {
    const p = read(NGINX_PROD);
    expect(p).toMatch(
      /# V-278\.B \/ V-278\.M — nginx vhost for api\.driftstack\.dev with origin TLS\./,
    );
    expect(p).toMatch(/Cloudflare's SSL\/TLS mode is set to "Full \(strict\)"/);
  });

  it('CRITICAL both nginx vhosts use TLS 1.2 + 1.3 only with Mozilla intermediate ciphers. Drift to TLS 1.0/1.1 or weaker ciphers would fail security scans.', () => {
    for (const f of [NGINX_PROD, NGINX_STG]) {
      const p = read(f);
      expect(p).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
      expect(p).toMatch(
        /ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384/,
      );
      expect(p).toMatch(/ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305/);
    }
  });

  it("CRITICAL both nginx vhosts resolve CF-Connecting-IP as the real client IP ONLY when trust is scoped to Cloudflare's actual edge ranges (infra/nginx/cloudflare-real-ip.conf, installed to conf.d). Drift to a 0.0.0.0/0 wildcard (the 2026-07-01-fixed CF-Connecting-IP origin-spoof gap) or an arbitrary upstream would let any direct-to-origin client forge their IP and defeat every IP-keyed rate limit; drift to dropping the header would break audit log + rate-limit buckets that need the actual customer IP.", () => {
    for (const f of [NGINX_PROD, NGINX_STG]) {
      const p = read(f);
      expect(p).not.toMatch(/^\s*set_real_ip_from 0\.0\.0\.0\/0;/m);
      expect(p).toMatch(/\/etc\/nginx\/conf\.d\/cloudflare-real-ip\.conf/);
    }
    const snippet = read(resolve(REPO_ROOT, 'infra/nginx/cloudflare-real-ip.conf'));
    expect(snippet).toMatch(/real_ip_header CF-Connecting-IP;/);
    expect(snippet).toMatch(/set_real_ip_from 173\.245\.48\.0\/20;/);
    expect(snippet).not.toMatch(/^\s*set_real_ip_from 0\.0\.0\.0\/0;/m);
  });

  it('CRITICAL both nginx vhosts proxy to 127.0.0.1:7780 with 5-header proxy_set_header set — Host + X-Real-IP + X-Forwarded-For + X-Forwarded-Proto + Connection "". Drift would either break Fastify trustProxy or lose Host-routing.', () => {
    for (const f of [NGINX_PROD, NGINX_STG]) {
      const p = read(f);
      expect(p).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:7780;/);
      expect(p).toMatch(/proxy_set_header Host \$host;/);
      expect(p).toMatch(/proxy_set_header X-Real-IP \$remote_addr;/);
      expect(p).toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
      expect(p).toMatch(/proxy_set_header X-Forwarded-Proto https;/);
      expect(p).toMatch(/proxy_set_header Connection "";/);
    }
  });

  it("CRITICAL both nginx vhosts use Let's Encrypt cert paths under /etc/letsencrypt/live/. Drift to a different cert path would break the certbot auto-renewal.", () => {
    expect(read(NGINX_PROD)).toMatch(
      /ssl_certificate +\/etc\/letsencrypt\/live\/api\.driftstack\.dev\/fullchain\.pem;/,
    );
    expect(read(NGINX_PROD)).toMatch(
      /ssl_certificate_key \/etc\/letsencrypt\/live\/api\.driftstack\.dev\/privkey\.pem;/,
    );
    expect(read(NGINX_STG)).toMatch(
      /ssl_certificate +\/etc\/letsencrypt\/live\/staging\.driftstack\.dev\/fullchain\.pem;/,
    );
  });

  it('CRITICAL staging nginx vhost server_name has 2-SAN coverage — staging.driftstack.dev + api.staging.driftstack.dev. The 2-SAN LE cert is the cost-saving alternative to 2 separate certs.', () => {
    const p = read(NGINX_STG);
    expect(p).toMatch(/server_name staging\.driftstack\.dev api\.staging\.driftstack\.dev;/);
    expect(p).toMatch(
      /Cert covers staging\.driftstack\.dev \+ api\.staging\.driftstack\.dev\s*\n# \(single LE cert with 2 SAN entries\)\./,
    );
  });

  it('CRITICAL both nginx vhosts have port-80 HTTP→HTTPS redirect + /nginx-health bypass. The /nginx-health endpoint stays accessible on plain HTTP so monitoring can probe it without TLS overhead.', () => {
    for (const f of [NGINX_PROD, NGINX_STG]) {
      const p = read(f);
      expect(p).toMatch(/listen 80;\s*\n\s*listen \[::\]:80;/);
      expect(p).toMatch(/return 301 https:\/\/\$host\$request_uri;/);
      expect(p).toMatch(/location = \/nginx-health \{/);
      expect(p).toMatch(/return 200 "ok\\n";/);
    }
  });

  // ─── bootstrap.sh — V-278.A ────────────────────────────────────

  it('CRITICAL bootstrap.sh V-278.A anchor + production/staging role gate + idempotent framing pinned. The role-gate (case "$ROLE" in production|staging) prevents running with garbage input.', () => {
    const p = read(BOOTSTRAP);
    expect(p).toMatch(/# V-278\.A — Hetzner Ubuntu 24\.04 LTS bootstrap\./);
    expect(p).toMatch(/Idempotent\./);
    expect(p).toMatch(/case "\$ROLE" in\s*\n\s+production\|staging\) : ;;/);
    expect(p).toMatch(/usage: \$0 \{production\|staging\}/);
  });

  it('CRITICAL bootstrap.sh UFW firewall pinned — deny-incoming default + allow 22/80/443/tcp + comment-tags. Drift to default-allow or opening more ports would dramatically widen the attack surface.', () => {
    const p = read(BOOTSTRAP);
    expect(p).toMatch(/ufw default deny incoming/);
    expect(p).toMatch(/ufw default allow outgoing/);
    expect(p).toMatch(/ufw allow 22\/tcp comment 'SSH'/);
    expect(p).toMatch(
      /ufw allow 80\/tcp comment 'HTTP \(nginx; redirects to 443 for proxied subdomains\)'/,
    );
    expect(p).toMatch(/ufw allow 443\/tcp comment 'HTTPS'/);
    expect(p).toMatch(/ufw --force enable/);
  });

  it('CRITICAL bootstrap.sh Node 22 LTS install pinned. The NodeSource setup_22.x APT repo + idempotent version-check pattern. Drift to a different Node version would either lag behind LTS or pull a non-LTS release.', () => {
    const p = read(BOOTSTRAP);
    expect(p).toMatch(
      /if ! command -v node >\/dev\/null 2>&1 \|\| \[\[ "\$\(node --version\)" != v22\.\* \]\]; then/,
    );
    expect(p).toMatch(/curl -fsSL https:\/\/deb\.nodesource\.com\/setup_22\.x \| bash -/);
    expect(p).toMatch(/apt-get install -yq nodejs/);
  });

  it("CRITICAL bootstrap.sh fail2ban enable-now + service-account 'driftstack' useradd with --system + --shell /usr/sbin/nologin pinned. The non-root, non-login user is the load-bearing 'API can't shell-exec into host' boundary.", () => {
    const p = read(BOOTSTRAP);
    expect(p).toMatch(/systemctl enable --now fail2ban/);
    expect(p).toMatch(
      /if ! id -u driftstack >\/dev\/null 2>&1; then\s*\n\s+useradd --system --home-dir \/opt\/driftstack --shell \/usr\/sbin\/nologin driftstack/,
    );
  });

  it("CRITICAL bootstrap.sh unattended-upgrades config: Automatic-Reboot=false + security-only updates. The 'team triggers reboots out-of-band' rationale is the load-bearing 'don't ever auto-reboot prod' safety.", () => {
    const p = read(BOOTSTRAP);
    expect(p).toMatch(/Unattended-Upgrade::Automatic-Reboot "false";/);
    expect(p).toMatch(/no kernel\s*\n# auto-reboots; the founder triggers reboots out-of-band/);
  });

  // ─── deploy-api.sh — V-278.B ──────────────────────────────────

  it('CRITICAL deploy-api.sh V-278.B + 2-host map pinned — production:128.140.37.74 + staging:116.203.22.197. Drift to a different IP would deploy to the wrong machine.', () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/# V-278\.B — Deploy the Fastify control-plane API to a Hetzner host\./);
    expect(p).toMatch(
      /production\)\s*\n\s+HOST=128\.140\.37\.74\s*\n\s+NGINX_VHOST=infra\/nginx\/api\.driftstack\.dev\.conf/,
    );
    expect(p).toMatch(
      /staging\)\s*\n\s+HOST=116\.203\.22\.197\s*\n\s+NGINX_VHOST=infra\/nginx\/staging\.driftstack\.dev\.conf/,
    );
  });

  it("CRITICAL deploy-api.sh env-template-not-template-file guard pinned. The pre-flight refuses if infra/env-templates/$ROLE.env (no .template suffix) doesn't exist — drift would let the deploy run with REDACTED secrets in production.", () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/ENV_FILE_LOCAL="infra\/env-templates\/\$ROLE\.env"/);
    expect(p).toMatch(/Copy infra\/env-templates\/\$ROLE\.env\.template to \$ENV_FILE_LOCAL/);
    expect(p).toMatch(/fill in the REDACTED secrets before deploying/);
  });

  it('CRITICAL deploy-api.sh .env file mode 0600 + chown driftstack:driftstack pinned. Drift to a permissive mode would let any local user read the production secrets.', () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/chown driftstack:driftstack \/opt\/driftstack\/api\/\.env/);
    expect(p).toMatch(/chmod 600 \/opt\/driftstack\/api\/\.env/);
  });

  it("CRITICAL deploy-api.sh GIT_SHA injection over PLACEHOLDER pinned. The 'inject the actual deploy-time SHA over any PLACEHOLDER_GIT_SHA' wording threads the V-NNN deploy-version-tracking convention.", () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/GIT_SHA=\$\(git rev-parse --short HEAD\)/);
    expect(p).toMatch(/Inject the actual deploy-time SHA over any PLACEHOLDER_GIT_SHA/);
    expect(p).toMatch(/sed -i 's\|\^GIT_SHA=\.\*\|GIT_SHA=\$GIT_SHA\|'/);
  });

  it('CRITICAL deploy-api.sh npm ci --omit=dev --ignore-scripts --no-audit --no-fund pinned. The 4-flag combo skips dev deps + husky prepare hook + audit/funding spam. Drift to dropping --ignore-scripts would run husky on the production host.', () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  });

  it('CRITICAL deploy-api.sh rsync --include pattern pinned — apps/server/dist/*** + packages/api-types/dist/*** + docs/legal/*.md (DPA/Terms/etc on disk for V-NNN compliance routes) + every package.json + the workspace lockfile. Drift would either ship source code (security risk) or strip files the runtime needs.', () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/--include 'package\.json' --include 'package-lock\.json'/);
    expect(p).toMatch(/--include 'apps\/server\/dist\/\*\*\*'/);
    expect(p).toMatch(/--include 'packages\/api-types\/dist\/\*\*\*'/);
    expect(p).toMatch(
      /--include 'docs\/' --include 'docs\/legal\/' --include 'docs\/legal\/\*\.md'/,
    );
    expect(p).toMatch(/--exclude '\*'/);
  });

  it('CRITICAL deploy-api.sh nginx vhost symlink + nginx -t + systemctl reload pattern pinned. nginx -t MUST run before reload — a bad config would 502 the entire site.', () => {
    const p = read(DEPLOY);
    expect(p).toMatch(/ln -sf \/etc\/nginx\/sites-available\/\$NGINX_VHOST_NAME\.conf/);
    expect(p).toMatch(
      /nginx -t\s*\n\s+systemctl daemon-reload\s*\n\s+systemctl enable driftstack-api\s*\n\s+systemctl restart driftstack-api\s*\n\s+systemctl reload nginx/,
    );
  });

  it('CRITICAL deploy-api.sh auto-installs the fleet.driftstack.dev control-WS vhost on PRODUCTION, cert-guarded — a fresh-box bootstrap must not silently lose the -1011 fix (bus W2863/W2866). An UNconditional symlink would 502 the box when the LE cert is absent, so the symlink+reload is gated on the cert existing, else a loud skip with the provisioning command.', () => {
    const p = read(DEPLOY);
    // Prod-only guard + the two scp's (the $connection_upgrade map is always safe; the vhost references the cert).
    expect(p).toMatch(/if \[ "\$ROLE" = production \]; then/);
    expect(p).toMatch(/scp -q infra\/nginx\/ws_upgrade_map\.conf/);
    expect(p).toMatch(/scp -q infra\/nginx\/fleet\.driftstack\.dev\.conf/);
    // Cert guard BEFORE the symlink (else `nginx -t` fails on the missing cert and 502s the box).
    expect(p).toMatch(
      /if \[ -f \/etc\/letsencrypt\/live\/fleet\.driftstack\.dev\/fullchain\.pem \]; then/,
    );
    expect(p).toMatch(/ln -sf \/etc\/nginx\/sites-available\/fleet\.driftstack\.dev\.conf/);
    // The skip path must guide provisioning rather than silently degrade.
    expect(p).toMatch(/certbot certonly --dns-cloudflare .* -d fleet\.driftstack\.dev/);
  });

  it('CRITICAL deploy-api.sh 5-retry health probe pinned — curl /health on localhost:7780 with sleep 2 between retries. 10-second total budget; drift to fewer retries would flake the deploy verification.', () => {
    const p = read(DEPLOY);
    expect(p).toMatch(
      /for _i in 1 2 3 4 5; do\s*\n\s+if ssh "root@\$HOST" 'curl -fsS http:\/\/127\.0\.0\.1:7780\/health' >\/dev\/null 2>&1; then/,
    );
    expect(p).toMatch(/sleep 2/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/infra-bootstrap-deploy-nginx-systemd-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
