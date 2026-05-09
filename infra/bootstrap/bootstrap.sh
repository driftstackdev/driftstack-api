#!/usr/bin/env bash
# V-278.A — Hetzner Ubuntu 24.04 LTS bootstrap.
#
# Idempotent. Run as root over SSH:
#   scp infra/bootstrap/bootstrap.sh root@$HOST:/root/bootstrap.sh
#   ssh root@$HOST 'bash /root/bootstrap.sh production' (or 'staging')
#
# Brings a fresh CPX server to a known-good state for the Driftstack
# control-plane API + the static-asset reverse proxy. Postgres + Redis
# are managed services (Neon + Upstash); R2 / Postmark / Sentry /
# Stripe are HTTP APIs. Nothing is provisioned by this script except
# the host runtime.
#
# What it installs:
#   - apt updates + unattended-upgrades (security only)
#   - Node 22 LTS via NodeSource APT repo
#   - nginx (reverse proxy + static asset server for non-API subdomains)
#   - UFW (allow 22/tcp, 80/tcp, 443/tcp; default-deny inbound)
#   - fail2ban (default sshd profile)
#   - postgresql-client (psql for Neon admin)
#   - rsync, curl, jq, ca-certificates, gnupg
#
# What it sets up but does NOT start (separate deploy step does that):
#   - /opt/driftstack/{api,web} directories (deploy code lands here)
#   - systemd unit /etc/systemd/system/driftstack-api.service
#   - nginx vhosts copied from /opt/driftstack/api/infra/nginx/

set -euo pipefail

ROLE="${1:-}"
case "$ROLE" in
  production|staging) : ;;
  *)
    echo "usage: $0 {production|staging}" >&2
    exit 64
    ;;
esac

echo "=== V-278.A bootstrap (role=$ROLE, host=$(hostname)) ==="

# ── 1. apt update + security autoupdates ──────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -yq -o Dpkg::Options::='--force-confold'
apt-get install -yq \
  ca-certificates curl gnupg lsb-release rsync jq \
  ufw fail2ban unattended-upgrades \
  postgresql-client \
  nginx

# Configure unattended-upgrades for security updates only (no kernel
# auto-reboots; the founder triggers reboots out-of-band).
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat >/etc/apt/apt.conf.d/52unattended-upgrades-driftstack <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF

# ── 2. Node.js 22 LTS via NodeSource ──────────────────────────────────
# Idempotent: `apt-get install -yq nodejs` is a no-op when the version
# is already installed; the NodeSource setup script is safe to re-run.
if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
node --version
npm --version

# ── 3. UFW firewall ────────────────────────────────────────────────────
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (nginx; redirects to 443 for proxied subdomains)'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
ufw status verbose

# ── 4. fail2ban (default sshd profile) ────────────────────────────────
systemctl enable --now fail2ban
fail2ban-client status sshd || true

# ── 5. /opt/driftstack tree ───────────────────────────────────────────
install -d -m 0755 /opt/driftstack
install -d -m 0755 /opt/driftstack/api
install -d -m 0755 /opt/driftstack/web

# Service-account user for the API. Runs as non-root.
if ! id -u driftstack >/dev/null 2>&1; then
  useradd --system --home-dir /opt/driftstack --shell /usr/sbin/nologin driftstack
fi
chown -R driftstack:driftstack /opt/driftstack

# ── 6. nginx ──────────────────────────────────────────────────────────
# The deploy step (V-278.B onward) lays vhost configs into
# /etc/nginx/sites-available/ and symlinks to sites-enabled. We just
# make sure nginx is enabled and the default site is removed.
rm -f /etc/nginx/sites-enabled/default
systemctl enable --now nginx

# ── 7. systemd unit for the API ───────────────────────────────────────
# The unit file is laid out by the deploy step. Reload daemon now in
# case it's already present from a previous bootstrap.
systemctl daemon-reload

echo "=== V-278.A bootstrap complete (role=$ROLE) ==="
echo "Next: V-278.B–F deploy code into /opt/driftstack/{api,web}, then systemctl start driftstack-api."
