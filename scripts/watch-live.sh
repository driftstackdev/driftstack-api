#!/usr/bin/env bash
# watch-live.sh — one command to watch a live Driftstack session stream.
#
# Creates an agent session (which dispatches to the local harness over the fleet
# control plane), waits until the harness publishes its video track, writes a
# self-contained LiveKit viewer to /tmp/watch-live.html, and (with --open) opens
# it in the default browser. Each run is a FRESH session — re-run anytime the
# previous viewer goes blank (sessions idle-reap after ~5 min).
#
# Usage:   bash scripts/watch-live.sh [--open]
# Requires: local stack up (server :3000 fleet-CP-enabled, LiveKit :7880, gost
#   :1080, harness daemon connected) + repo-root .env with DRIFTSTACK_DEMO_API_KEY
#   (a read+write key) — gitignored, never committed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SERVER="${DRIFTSTACK_DEMO_SERVER:-http://localhost:3000}"
LIVEKIT_HTTP="${DRIFTSTACK_DEMO_LIVEKIT_HTTP:-http://localhost:7880}"
VIEWER="/tmp/watch-live.html"

[[ -f "$ENV_FILE" ]] || { echo "::error:: $ENV_FILE not found (need DRIFTSTACK_DEMO_API_KEY)" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${DRIFTSTACK_DEMO_API_KEY:?set DRIFTSTACK_DEMO_API_KEY in .env (a read+write API key)}"

# Create a session + render the viewer from its livekit subscriber block.
SID="$(
  DRIFTSTACK_DEMO_API_KEY="$DRIFTSTACK_DEMO_API_KEY" SERVER="$SERVER" VIEWER="$VIEWER" python3 - <<'PY'
import os, json, urllib.request
key, server, viewer = os.environ["DRIFTSTACK_DEMO_API_KEY"], os.environ["SERVER"], os.environ["VIEWER"]
req = urllib.request.Request(server + "/v1/agent-sessions", data=b"{}",
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
d = json.load(urllib.request.urlopen(req, timeout=10))
lk = d.get("livekit")
if not lk:
    raise SystemExit("no livekit block in create response (fleet control plane not active?)")
html = '''<!DOCTYPE html><html><head><meta charset=utf-8><title>Driftstack live session</title>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js"></script>
<style>body{margin:0;background:#0b0b0b;color:#eee;font-family:-apple-system,sans-serif}
#s{padding:10px 14px;font-size:14px}#v{max-width:100%%;height:auto;display:block;margin:0 auto;background:#000}</style>
</head><body><div id=s>connecting…</div><video id=v autoplay playsinline muted></video><script>
const WS=%s,TOKEN=%s,ROOM=%s;const s=document.getElementById('s'),v=document.getElementById('v');
(async()=>{const r=new LivekitClient.Room({adaptiveStream:true});
r.on(LivekitClient.RoomEvent.TrackSubscribed,t=>{if(t.kind==='video'){t.attach(v);s.textContent='● LIVE — '+ROOM;}});
r.on(LivekitClient.RoomEvent.Disconnected,()=>s.textContent='disconnected (session ended / idle-reaped — re-run watch-live.sh)');
await r.connect(WS,TOKEN);s.textContent='connected, waiting for video track… '+ROOM;})().catch(e=>s.textContent='error: '+e.message);
</script></body></html>''' % (json.dumps(lk["ws_url"]), json.dumps(lk["token"]), json.dumps(lk["room"]))
open(viewer, "w").write(html)
print(d["id"])
PY
)"
echo "session: $SID"

# Mint a roomList admin JWT (devkey/secret) to poll num_publishers until the
# harness publishes (so we open the viewer only once there's a track).
poll_publishers() {
  DEVKEY="${LIVEKIT_API_KEY:-devkey}" DEVSECRET="${LIVEKIT_API_SECRET:-secret}" \
  LIVEKIT_HTTP="$LIVEKIT_HTTP" ROOM="$SID" python3 - <<'PY'
import os, json, time, hmac, hashlib, base64, urllib.request
key, secret, base, room = os.environ["DEVKEY"], os.environ["DEVSECRET"], os.environ["LIVEKIT_HTTP"], os.environ["ROOM"]
def b64(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")
def mint():
    now = int(time.time())
    h = b64(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
    p = b64(json.dumps({"iss":key,"nbf":now-10,"exp":now+600,"video":{"roomList":True}}).encode())
    sig = b64(hmac.new(secret.encode(), (h+"."+p).encode(), hashlib.sha256).digest())
    return h+"."+p+"."+sig
req = urllib.request.Request(base+"/twirp/livekit.RoomService/ListRooms", data=json.dumps({"names":[room]}).encode(),
    headers={"Authorization":"Bearer "+mint(),"Content-Type":"application/json"}, method="POST")
j = json.load(urllib.request.urlopen(req, timeout=8))
rooms = j.get("rooms") or []
print(rooms[0].get("num_publishers", 0) if rooms else 0)
PY
}
echo -n "waiting for video track"
for _ in $(seq 1 15); do
  np="$(poll_publishers 2>/dev/null || echo 0)"
  if [[ "${np:-0}" -ge 1 ]]; then echo " — LIVE (num_publishers=$np)"; break; fi
  echo -n "."; sleep 4
done

echo "viewer: $VIEWER"
if [[ "${1:-}" == "--open" ]]; then
  command -v open >/dev/null 2>&1 && open "$VIEWER" || echo "(open $VIEWER in a browser)"
else
  echo "(re-run with --open to launch it in your browser, or open the file above)"
fi
