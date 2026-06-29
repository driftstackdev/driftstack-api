#!/usr/bin/env bash
# verify-all — ONE command, full all-at-once verdict for the live simulator experience.
# Runs the two self-test harnesses against a real session (through the autotest proxy)
# and aggregates a single PASS/FAIL, so the durable-tap + black-band + slide + video
# state can be confirmed end-to-end before asking the founder to test.
#
#   auto-verify-session.mjs  — BOX-side: tap injects/lands + scroll + nav (raw coords).
#   visual-sim-live.mjs      — GUI-side: a tap through the GUI's pointer→viewport
#                              mapping LANDS on a link (url change) + no black band +
#                              real video. Run twice: the example.com link coord AND
#                              TAP_FULLPAGE_LINK=1 (center tap, letterbox-invariant).
#
# Usage: DRIFTSTACK_PROXY_ID=<id> operations/scripts/verify-all.sh
# Env:   reads ~/.driftstack-autotest.env for the API key/base if present.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

set -a; . ~/.driftstack-autotest.env 2>/dev/null; set +a
export DRIFTSTACK_API_KEY="${DRIFTSTACK_API_KEY:-${API_KEY:-}}"
export DRIFTSTACK_BASE_URL="${DRIFTSTACK_BASE_URL:-https://api.driftstack.dev}"
PROXY="${DRIFTSTACK_PROXY_ID:-}"
if [ -z "${DRIFTSTACK_API_KEY}" ]; then echo "FAIL: DRIFTSTACK_API_KEY not set"; exit 2; fi
if [ -z "$PROXY" ]; then echo "WARN: no DRIFTSTACK_PROXY_ID — running proxyless (egress may be blocked)"; fi

pass=0; fail=0
note() { printf '  %-26s %s\n' "$1" "$2"; }
ok()   { note "$1" "✅ $2"; pass=$((pass+1)); }
bad()  { note "$1" "❌ $2"; fail=$((fail+1)); }

run_visual() { # $1=label extra-env; reads JSON verdict from stdout
  DRIFTSTACK_PROXY_ID="$PROXY" NAV_URL="${2:-https://example.com}" $1 \
    node operations/scripts/visual-sim-live.mjs 2>/dev/null
}

echo "=== verify-all : $(date -u +%H:%M:%SZ) proxy=${PROXY:-none} ==="

echo "--- [1/3] BOX-side functional (auto-verify: stream/tap/scroll/nav) ---"
AV=$(DRIFTSTACK_PROXY_ID="$PROXY" NAV_URL="https://example.com" node operations/scripts/auto-verify-session.mjs 2>&1)
echo "$AV" | grep -qaiE "PASS +STREAM"  && ok "stream"  "video published"        || bad "stream"  "no video"
echo "$AV" | grep -qaiE "PASS +SCROLL"  && ok "scroll"  "drag accepted"          || bad "scroll"  "no scroll"
echo "$AV" | grep -qaiE "PASS +TAP"     && ok "box-tap" "tap navigated"          || bad "box-tap" "tap missed (coord or inject)"

echo "--- [2/3] GUI-side end-to-end tap (visual-sim-live, full-viewport link) ---"
# TAP_FULLPAGE_LINK center-tap is letterbox-invariant + unambiguous IF the box loads
# the data: link page; falls through to the example.com link-coord run otherwise.
V1=$(TAP_FULLPAGE_LINK=1 run_visual "TAP_FULLPAGE_LINK=1" \
  'data:text/html,<body style="margin:0"><a href="https://example.org/" style="display:block;width:100vw;height:300vh;background:%23eee"></a></body>')
echo "$V1" | grep -qaiE '"gotVideo": *true'  && ok "gui-video" "<video> rendered"       || bad "gui-video" "no GUI video"
echo "$V1" | grep -qaiE '"navigated": *true' && ok "gui-tap"   "GUI tap LANDED (url changed)" || bad "gui-tap" "GUI tap did not navigate"

echo "--- [3/3] black-band + layout (visual-sim-live, example.com) ---"
V2=$(run_visual "" "https://example.com")
echo "$V2" | grep -qaiE '"bottomBandSuspected": *false' && ok "no-black-band" "video fills, no bottom band" || bad "no-black-band" "bottom band suspected"
echo "$V2" | grep -qaiE '"sideBandSuspected": *false'   && ok "no-side-band"  "no side band"               || bad "no-side-band"  "side band suspected"

echo "=== verdict: ${pass} pass / ${fail} fail ==="
[ "$fail" -eq 0 ] && { echo "ALL GREEN — safe to ask the founder to test."; exit 0; }
echo "NOT all green — fix before asking the founder. (re-run after A3's box settles if no-video/422)"; exit 1
