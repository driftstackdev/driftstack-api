# CF-Connecting-IP spoof via direct origin exposure — SURFACED (ops/founder-gated)

**Status:** CONFIRMED EXPLOITABLE in production (SSH-verified 2026-06-13).
HIGH severity. Surfaced, **not** auto-fixed — remediation touches the prod
firewall + nginx real-ip config, where a wrong Cloudflare-range list causes a
full API outage, so it needs founder/ops sign-off.

**Punch-list:** item #8. **Related memory:** the Fastify `trustProxy` gap
(`project_trustproxy_ip_resolution_gap`) was resolved at the nginx→Fastify
hop; this is the layer above it (world→nginx).

## The gap

Production topology is `client → Cloudflare → nginx (Hetzner origin) → Fastify`.
The IP-rate-limit defense (login / signup / magic-link / oauth / password-reset
/ `/v1/egress/echo`) and the audit trail both key on `req.ip`, which now
resolves to the rightmost `X-Forwarded-For` entry (Fastify `TRUST_PROXY=1`).
That entry is set by nginx from the `CF-Connecting-IP` header:

```nginx
# infra/nginx/api.driftstack.dev.conf:48-52
set_real_ip_from 0.0.0.0/0;        # trust the real-ip header from ANY peer
real_ip_header    CF-Connecting-IP;
...
proxy_set_header  X-Forwarded-For $proxy_add_x_forwarded_for;  # appends it
```

`set_real_ip_from 0.0.0.0/0` tells nginx to trust `CF-Connecting-IP` from **any**
source, not only Cloudflare. That is only safe if non-Cloudflare traffic cannot
reach nginx. It can:

- ufw (SSH-verified 2026-06-13): `443/tcp ALLOW IN Anywhere` (v4 **and** v6).
- nginx listens on `0.0.0.0:443`; the server block has no `allow`/`deny`.
- No Cloudflare Authenticated Origin Pulls (mTLS) on the origin.

So the Hetzner origin IP (`128.140.37.74:443`) answers the whole internet.

## Exploit

```
$ openssl s_client -connect 128.140.37.74:443 -servername api.driftstack.dev
GET /v1/egress/echo HTTP/1.1
Host: api.driftstack.dev
CF-Connecting-IP: 198.51.100.77      # attacker-chosen
```

nginx (`set_real_ip_from 0.0.0.0/0`) trusts the header → real-ip = `198.51.100.77`
→ appended to XFF → Fastify takes the rightmost entry → `req.ip = 198.51.100.77`.

Impact:

1. **IP-rate-limit bypass.** Every `ipRateLimit` gate buckets per `req.ip`.
   Rotating `CF-Connecting-IP` yields a fresh bucket per spoofed value →
   unbounded credential-stuffing / brute force on the auth gates and unbounded
   scraping of `/v1/egress/echo`. This nullifies the defense the `TRUST_PROXY`
   fix was meant to enable.
2. **Forged geo.** Anything reading the caller IP/geo (echo endpoint, future
   geo logic) accepts attacker-controlled input.
3. **Audit poisoning.** Session `issuedFromIp` / `sourceIp` record
   attacker-chosen IPs for requests sent through the direct path.

Cloudflare WAF / Cloudflare-side rate limiting is also bypassed entirely, since
the request never transits Cloudflare.

## Remediation (founder/ops — pick one or, ideally, all three)

- **A — Firewall the origin to Cloudflare (strongest, also hides the origin).**
  Restrict ufw `:443` + `:80` to Cloudflare's published ranges
  (`https://www.cloudflare.com/ips-v4`, `.../ips-v6`). Direct origin hits are
  dropped before nginx. Caveat: the list changes occasionally — automate a
  refresh (Cloudflare's `/client/v4/ips` API) so it doesn't go stale and
  silently start dropping real edge traffic.
- **B — Tighten nginx real-ip to Cloudflare ranges.** Replace
  `set_real_ip_from 0.0.0.0/0` with one `set_real_ip_from <cidr>;` line per
  Cloudflare range. A forged `CF-Connecting-IP` from a non-CF peer is then
  ignored (real-ip stays the attacker's actual socket address, which the rate
  limiter correctly buckets). Less catastrophic failure mode than A if the list
  is stale (coarser IPs, not an outage).
- **C — Cloudflare Authenticated Origin Pulls (mTLS).** Configure the origin to
  require Cloudflare's client certificate for the TLS handshake, so only
  Cloudflare can establish a connection at all. Best paired with A + B.

The same change applies to `infra/nginx/staging.driftstack.dev.conf:37-38`
(identical `set_real_ip_from 0.0.0.0/0`).

## Verification after the fix

- From a non-Cloudflare host, a direct `https://128.140.37.74` request with a
  forged `CF-Connecting-IP` should be dropped (A) or have its header ignored so
  `req.ip` is the real socket IP (B).
- Normal traffic through `api.driftstack.dev` (via Cloudflare) keeps the correct
  client IP (the `/v1/egress/echo` echo should still return the caller's real
  IP).
- Re-run the IP-rate-limit integration checks against the live stack.
