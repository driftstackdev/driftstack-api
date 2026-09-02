#!/usr/bin/env bash
# Drive a LIVE agent session against the API and print the plan + per-step results.
#
#   scripts/agent-live-probe.sh "Go to https://driftstack.dev/ and stop there."
#   scripts/agent-live-probe.sh --base https://staging.driftstack.dev "prompt 1" "prompt 2"
#
# Why this exists as a named script: an ad-hoc command that reads a secret and
# sends it over the network is exactly the shape a permission classifier should
# stop. A script with a fixed path can be read, reviewed, and allow-listed by
# ONE rule — `Bash(bash scripts/agent-live-probe.sh *)` — instead of widening
# permissions for curl or the keychain in general.
#
# The key: $DRIFTSTACK_API_KEY if set, else the GUI client's own Keychain item.
# It is never printed. There is deliberately no `|| echo ""` anywhere on the key
# path — a read that fails must fail loudly, not resolve to an empty bearer that
# turns every request into a 401 the next reader misdiagnoses.
#
# Exit codes: 0 every step succeeded · 2 at least one step failed (the plan ran)
#             1 setup or transport failure (nothing to conclude about the page)
set -euo pipefail

BASE="https://api.driftstack.dev"
PROFILE_ID=""
PROXY_ID=""
PROMPTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --profile-id) PROFILE_ID="$2"; shift 2 ;;
    --proxy-id) PROXY_ID="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) PROMPTS+=("$1"); shift ;;
  esac
done
if [ "${#PROMPTS[@]}" -eq 0 ]; then
  echo "usage: $0 [--base URL] [--profile-id ID] \"prompt\" [\"prompt\" ...]" >&2
  exit 1
fi

# ── key ────────────────────────────────────────────────────────────────────
if [ -n "${DRIFTSTACK_API_KEY:-}" ]; then
  KEY="$DRIFTSTACK_API_KEY"
else
  # The GUI client's keyring entry: service = the Tauri bundle id, account =
  # "<workspace>:api_key:<host>". Same item the desktop app itself reads.
  KEY=$(security find-generic-password -s dev.driftstack.gui \
          -a 'default:api_key:api.driftstack.dev' -w 2>/dev/null) || {
    echo "no API key: DRIFTSTACK_API_KEY is unset and the Keychain item dev.driftstack.gui / default:api_key:api.driftstack.dev is absent" >&2
    exit 1
  }
fi
if [ -z "$KEY" ]; then
  echo "API key resolved to an EMPTY string — refusing to send a blank bearer" >&2
  exit 1
fi
AUTH="Authorization: Bearer $KEY"

PROBE_TMP="${DRIFTSTACK_PROBE_TMP:-/private/tmp/ds-probe}"
mkdir -p "$PROBE_TMP"
WORK=$(mktemp -d "$PROBE_TMP/agent-probe.XXXXXX")
SESSION=""
cleanup() {
  # Always tear the session down, including on Ctrl-C or a failed step, so a
  # probe cannot leave a live phone allocated behind it.
  if [ -n "$SESSION" ]; then
    code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
             -X DELETE "$BASE/v1/agent-sessions/$SESSION" -H "$AUTH" || echo "curl-failed")
    echo "  delete $SESSION: HTTP $code"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ── parse one SSE reply: print PLAN + RES lines, return 2 if any step failed ──
report() {
  if [ ! -s "$1" ]; then
    echo "    NO RESPONSE BODY — the stream wrote nothing or the scratch file vanished."
    echo "    Transport/environment failure, NOT a verdict about the page."
    return 1
  fi
  python3 - "$1" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
saw_body = False
failed = 0
for line in raw.splitlines():
    if not line.startswith("data:"):
        continue
    try:
        d = json.loads(line[5:].strip())
    except Exception:
        continue
    b = d.get("body") if isinstance(d.get("body"), dict) else d
    status = d.get("status")
    if isinstance(status, int) and status >= 400:
        print("    HTTP %s %s" % (status, json.dumps(b)[:400]))
        sys.exit(1)
    intents = b.get("intents") or []
    results = b.get("results") or []
    if not intents and not results:
        continue
    saw_body = True
    for i in intents:
        what = i.get("action") or i.get("kind")
        tgt = i.get("selector") or i.get("url") or ""
        val = i.get("value")
        print("    PLAN %-9s %s%s" % (what, tgt, ("  ⟵ %r" % val) if val not in (None, "") else ""))
    for r in results:
        # intentResultToCustomer emits { kind: 'success', summary } or
        # { kind: 'failure', reason, diagnosis } — there is no `ok` field, and
        # reading one would print every success as FAIL (it did, in the dry run).
        kind = r.get("kind")
        ok = kind == "success" if kind is not None else bool(r.get("ok"))
        msg = (r.get("summary") if ok else r.get("reason")) or r.get("error") or r.get("detail") or ""
        diag = r.get("diagnosis") or {}
        tail = ""
        if diag:
            tail = "   [%s retryable=%s]" % (diag.get("category"), diag.get("retryable"))
        # Print failures UNTRUNCATED: the harness appends the queried document's
        # url / readyState / node count / title to a miss, and that suffix is
        # the whole diagnosis.
        print("    RES  %-4s %s%s" % ("ok" if ok else "FAIL", msg if not ok else str(msg)[:160], tail))
        if not ok:
            failed += 1
if not saw_body:
    # Distinguish "nothing came back" from "everything passed" — an empty
    # stream is a transport problem, never a clean result.
    print("    NO PLAN OR RESULTS IN THE STREAM (%d bytes) — transport or auth problem, not a page verdict" % len(raw))
    sys.exit(1)
sys.exit(2 if failed else 0)
PY
}

# ── create ─────────────────────────────────────────────────────────────────
# With no proxy_id the session takes the OPERATOR-DEFAULT egress, which is a
# different proxy from anything in the account list — worth being able to pin.
BODY=$(python3 -c '
import json, sys
b = {"mode": "ai"}
if sys.argv[1]: b["profile_id"] = sys.argv[1]
if sys.argv[2]: b["proxy_id"] = sys.argv[2]
print(json.dumps(b))' "$PROFILE_ID" "$PROXY_ID")
CREATE=$(curl -sS --max-time 60 -w '\n%{http_code}' -X POST "$BASE/v1/agent-sessions" \
           -H "$AUTH" -H 'content-type: application/json' -d "$BODY")
CCODE=${CREATE##*$'\n'}
CBODY=${CREATE%$'\n'*}
SESSION=$(printf '%s' "$CBODY" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id",""))
except Exception: print("")')
if [ "$CCODE" != "201" ] || [ -z "$SESSION" ]; then
  echo "  create: HTTP $CCODE — no session id" >&2
  printf '%s\n' "$CBODY" | head -c 600 >&2; echo >&2
  SESSION=""
  exit 1
fi
echo "  base:    $BASE"
echo "  session: $SESSION"

# ── messages ───────────────────────────────────────────────────────────────
WORST=0
n=0
for p in "${PROMPTS[@]}"; do
  n=$((n + 1))
  echo "  --- [$n] $p"
  python3 -c 'import json,sys;print(json.dumps({"user_message":sys.argv[1]}))' "$p" > "$WORK/req$n.json"
  curl -sS --max-time 240 -N -X POST "$BASE/v1/agent-sessions/$SESSION/message" \
    -H "$AUTH" -H 'content-type: application/json' -H 'accept: text/event-stream' \
    --data @"$WORK/req$n.json" > "$WORK/m$n.sse" 2>"$WORK/m$n.err" || {
      echo "    curl failed: $(head -c 200 "$WORK/m$n.err")"
      WORST=1
      continue
    }
  rc=0
  report "$WORK/m$n.sse" || rc=$?
  if [ "$rc" -eq 1 ]; then WORST=1; elif [ "$rc" -eq 2 ] && [ "$WORST" -ne 1 ]; then WORST=2; fi
done

exit "$WORST"
