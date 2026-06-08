#!/usr/bin/env bash
# demo-egress-gost.sh — local demo SOCKS5 egress relay.
#
# Runs a local gost SOCKS5 on 127.0.0.1:1080 that CHAINS to the demo egress
# proxy. The local fleet-CP session dispatch (bootstrap sessionDispatch.proxy)
# and the harness daemon (DRIFTSTACK_SOCKS5_PROXY) both point at 127.0.0.1:1080,
# so chaining here routes all demo session egress through the real upstream proxy
# WITHOUT any component needing the upstream credentials — they live only in the
# gitignored repo-root .env (DRIFTSTACK_DEMO_SOCKS5_*), never in code or on the
# agent bus.
#
# Usage:  bash scripts/demo-egress-gost.sh
# Requires: gost on PATH; repo-root .env with DRIFTSTACK_DEMO_SOCKS5_{HOST,PORT,USER,PASS}.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "::error:: $ENV_FILE not found (need DRIFTSTACK_DEMO_SOCKS5_* — gitignored)" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${DRIFTSTACK_DEMO_SOCKS5_HOST:?set DRIFTSTACK_DEMO_SOCKS5_HOST in .env}"
: "${DRIFTSTACK_DEMO_SOCKS5_PORT:?set DRIFTSTACK_DEMO_SOCKS5_PORT in .env}"
: "${DRIFTSTACK_DEMO_SOCKS5_USER:?set DRIFTSTACK_DEMO_SOCKS5_USER in .env}"
: "${DRIFTSTACK_DEMO_SOCKS5_PASS:?set DRIFTSTACK_DEMO_SOCKS5_PASS in .env}"

if ! command -v gost >/dev/null 2>&1; then
  echo "::error:: gost not on PATH (brew install gost)" >&2
  exit 1
fi

# Reap any existing listener on :1080 (idempotent re-run).
if pid="$(lsof -nP -iTCP:1080 -sTCP:LISTEN -t 2>/dev/null | head -1)"; then
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  sleep 1
fi

UPSTREAM="socks5://${DRIFTSTACK_DEMO_SOCKS5_USER}:${DRIFTSTACK_DEMO_SOCKS5_PASS}@${DRIFTSTACK_DEMO_SOCKS5_HOST}:${DRIFTSTACK_DEMO_SOCKS5_PORT}"
nohup gost -L "socks5://:1080" -F "$UPSTREAM" >/tmp/gost-demo-egress.log 2>&1 &
sleep 2

# Verify chained egress works (does NOT print credentials).
code="$(curl -s --max-time 15 --socks5-hostname 127.0.0.1:1080 https://api.ipify.org -o /tmp/gost-egress-ip.txt -w '%{http_code}' 2>/dev/null || true)"
if [[ "$code" == "200" ]]; then
  echo "demo egress gost up on 127.0.0.1:1080 -> upstream proxy OK (egress IP $(cat /tmp/gost-egress-ip.txt))"
else
  echo "::error:: gost chain verify failed (status=$code) — check upstream proxy reachability" >&2
  exit 1
fi
