#!/usr/bin/env python3
"""
Raw-SYN observer for passive OS fingerprinting of a proxy's own TCP stack (N-2).

WHY A SEPARATE OBSERVER. A SOCKS5 proxy opens its OWN TCP connection to the
destination, so the SYN that arrives here was built by the PROXY HOST's kernel.
The fields that identify a stack — IP TTL, DF, TCP window, MSS, window scale
and the ORDER of TCP options — exist only in that SYN. A connected socket has
already had them consumed by the kernel; no socket API returns them. So the
control plane's probe cannot read them, and this process sniffs them instead.

Runs on the origin (128.140.37.74), which has a public IP and is NOT behind
Cloudflare on the observer port. Cloudflare-fronted ports are useless here: the
SYN we would see is Cloudflare's, not the proxy's.

Design constraints, each deliberate:
  - Sniffs the observed ports (OBS_PORTS: the observer port, plus the web port
    added 2026-09-14 as a second vantage) and records SYNs only. Nothing else is
    parsed. Records are keyed per (address, PORT) so the two vantages can be
    compared instead of overwriting each other.
  - Keeps the last signature per source IP in a bounded LRU (MAX_ENTRIES). A
    diagnostic that grows without bound while investigating leaks is its own
    punchline.
  - Serves lookups on localhost only (LOOKUP_ADDR). The control plane reaches it
    over the existing SSH/tunnel path, never the public interface.
  - A lookup for an IP it has not seen returns 404, NEVER a default signature.
    "We did not observe this exit" must stay distinguishable from "we observed
    it and it looks like Linux" — the same absent-vs-measured rule as the
    classifier's `unknown`.
  - Requires CAP_NET_RAW / root for the raw socket. Fails loudly at start if it
    cannot open one; it must not sit there answering 404 forever.

Wire shape (GET /sig/<ip>):
  {"ttl": 54, "df": true, "window": 65535, "mss": 1460, "wscale": 6,
   "options": [2,1,3,1,1,8,4,0], "seen_at": 1725300000}
This is exactly `TcpSynSignature` in apps/server/src/lib/tcp-os-fingerprint.ts
(field names snake_case on the wire, mapped CP-side).
"""
import collections, json, os, socket, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

OBS_PORT   = int(os.environ.get("DS_OBS_PORT", "7791"))
# V-219 (2026-09-14) — a SECOND vantage, and the reason it is needed.
#
# The owner loaded browserleaks.com/ip THROUGH a residential proxy: it reads the
# arriving stack on 443 and reported Mac/iOS, while this observer on 7791 read
# the same proxy as Linux. Their provider routes web traffic through the
# residential device and odd ports through its own infrastructure, so a reading
# taken on 7791 can describe a path no website uses.
#
# 443 works as a vantage ONLY on a name that is not CDN-fronted. api.driftstack.dev
# is behind Cloudflare, so a SYN arriving there on 443 is Cloudflare's edge, not
# the proxy's — a perfectly stable reading of the wrong machine. fleet.driftstack.dev
# resolves to this host directly (128.140.37.74, nginx, no cf-* headers), and nginx
# already LISTENS on 443 here, which supplies the acceptor this file binds 7791 for
# at the bottom: without something accepting, the proxy's CONNECT is RST and the
# probe reports "tunnel refused" rather than reading anything.
#
# So this needs no new port and no new host: only the sniff filter widened, and
# records keyed per (address, port) so the two vantages can be COMPARED rather
# than overwrite each other — which is the entire point of taking the second one.
WEB_PORT   = int(os.environ.get("DS_OBS_WEB_PORT", "443"))
OBS_PORTS  = {OBS_PORT, WEB_PORT}
LOOKUP_ADDR = ("127.0.0.1", int(os.environ.get("DS_OBS_LOOKUP_PORT", "7792")))
MAX_ENTRIES = 4096
TTL_SECONDS = 15 * 60  # matches the exit-identity cache; a stale SYN is not "this exit"

_lock = threading.Lock()
_sigs: "collections.OrderedDict[tuple, dict]" = collections.OrderedDict()


def parse_syn(pkt: bytes):
    """Return (src_ip, dst_port, signature) for a TCP SYN to an observed port, else None."""
    if len(pkt) < 40:
        return None
    ver_ihl = pkt[0]
    if ver_ihl >> 4 != 4:
        return None
    ihl = (ver_ihl & 0x0F) * 4
    ttl = pkt[8]
    proto = pkt[9]
    if proto != 6:
        return None
    flags_frag = struct.unpack("!H", pkt[6:8])[0]
    df = bool(flags_frag & 0x4000)
    src_ip = socket.inet_ntoa(pkt[12:16])
    tcp = pkt[ihl:]
    if len(tcp) < 20:
        return None
    dst_port = struct.unpack("!H", tcp[2:4])[0]
    if dst_port not in OBS_PORTS:
        return None
    data_off = (tcp[12] >> 4) * 4
    tcp_flags = tcp[13]
    SYN, ACK = 0x02, 0x10
    if not (tcp_flags & SYN) or (tcp_flags & ACK):
        return None  # only the initial SYN carries the sender's untouched choices
    window = struct.unpack("!H", tcp[14:16])[0]
    opts = tcp[20:data_off]
    order, mss, wscale = [], None, None
    i = 0
    while i < len(opts):
        kind = opts[i]
        order.append(kind)
        if kind == 0:      # EOL
            break
        if kind == 1:      # NOP
            i += 1
            continue
        if i + 1 >= len(opts):
            break
        length = opts[i + 1]
        if length < 2:
            break
        body = opts[i + 2 : i + length]
        if kind == 2 and len(body) == 2:
            mss = struct.unpack("!H", body)[0]
        elif kind == 3 and len(body) == 1:
            wscale = body[0]
        i += length
    return src_ip, dst_port, {
        "ttl": ttl, "df": df, "window": window, "mss": mss, "wscale": wscale,
        "options": order, "seen_at": int(time.time()),
        # Which vantage this came from. On the wire so a reader can never mistake
        # a web-port reading for an observer-port one — the two exist precisely
        # because they can disagree.
        "dst_port": dst_port,
    }


def sniff():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)
    except PermissionError:
        print("observer: raw socket refused — needs CAP_NET_RAW/root. Refusing to run blind.", file=sys.stderr)
        sys.exit(2)
    while True:
        pkt = s.recv(65535)
        parsed = parse_syn(pkt)
        if parsed is None:
            continue
        ip, port, sig = parsed
        # Keyed per (address, PORT). Keying on the address alone would let a 443
        # SYN overwrite the same host's 7791 reading and vice versa, destroying
        # the comparison this second vantage exists to make.
        key = (ip, port)
        with _lock:
            _sigs[key] = sig
            _sigs.move_to_end(key)
            while len(_sigs) > MAX_ENTRIES:
                _sigs.popitem(last=False)


class Lookup(BaseHTTPRequestHandler):
    def log_message(self, *_):  # quiet
        pass

    def do_GET(self):
        if self.path == "/healthz":
            self._send(
                200,
                {"ok": True, "entries": len(_sigs), "port": OBS_PORT, "ports": sorted(OBS_PORTS)},
            )
            return
        if self.path == "/recent":
            # Loopback-only listing of what was actually observed. Exists for the
            # exact diagnosis it was first used for: the CP's echo saw one exit
            # IP, the SYN arrived from another (CGNAT pool), and a keyed lookup
            # alone could not show that.
            with _lock:
                items = [
                    {"ip": key[0], "port": key[1], **sig}
                    for key, sig in list(_sigs.items())[-20:]
                ]
            self._send(200, {"recent": items})
            return
        if not self.path.startswith("/sig/"):
            self._send(404, {"error": "unknown path"})
            return
        # /sig/<ip>          -> the OBSERVER port, unchanged. The control plane
        #                       calls exactly this and must keep its old answer:
        #                       a second vantage is a new question, not a
        #                       redefinition of the one already in production.
        # /sig/<ip>/<port>   -> a named vantage, for comparing the two.
        rest = self.path[len("/sig/"):]
        if "/" in rest:
            ip, _, port_s = rest.partition("/")
            try:
                port = int(port_s)
            except ValueError:
                self._send(404, {"error": "port must be an integer"})
                return
            if port not in OBS_PORTS:
                # Refuse rather than answer 404: "we do not sniff that port" and
                # "nothing came from that address" are different facts, and a
                # caller that cannot tell them apart will read a typo as a clean
                # negative.
                self._send(400, {"error": "port is not observed", "observed": sorted(OBS_PORTS)})
                return
        else:
            ip, port = rest, OBS_PORT
        with _lock:
            sig = _sigs.get((ip, port))
        if sig is None or time.time() - sig["seen_at"] > TTL_SECONDS:
            # NOT a default. Unseen and expired both mean "no measurement".
            self._send(404, {"error": "no SYN observed from this address in the window"})
            return
        self._send(200, sig)

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    threading.Thread(target=sniff, daemon=True).start()
    # The observer port itself must ACCEPT the connection so the proxy's CONNECT
    # succeeds and the probe can report "reachable"; the payload is irrelevant.
    acceptor = socket.socket(); acceptor.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    acceptor.bind(("0.0.0.0", OBS_PORT)); acceptor.listen(64)
    def drain():
        while True:
            c, _ = acceptor.accept(); c.close()
    threading.Thread(target=drain, daemon=True).start()
    HTTPServer(LOOKUP_ADDR, Lookup).serve_forever()
