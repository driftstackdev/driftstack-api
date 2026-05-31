# 2026-05-31 — `req.ip` is `127.0.0.1` in prod: broken IP rate-limit buckets + audit IPs (Agent 2)

**Status: SURFACED, not fixed — architecture/infra decision (global `req.ip`
semantics + the LOCKED `readClientIp` stance + origin firewall posture).** Found by
a fresh critical audit of the rate-limit subsystem (algorithm/store/middleware were
never audited at this level — prior memories only cover rate-limit _headers_ and
_bucket-enum membership_).

## Root cause (confirmed)

The production topology is **Cloudflare → nginx (Hetzner) → Fastify**:

- Prod API response headers prove the Cloudflare proxy: `server: cloudflare` +
  `cf-ray: …-AMS` on `https://api.driftstack.dev/health`.
- `infra/nginx/api.driftstack.dev.conf` `proxy_pass http://127.0.0.1:7780;` — nginx
  forwards to Fastify over loopback. It sets the real client IP correctly
  (`real_ip_header CF-Connecting-IP; set_real_ip_from 0.0.0.0/0;` →
  `proxy_set_header X-Real-IP $remote_addr;` + appends it to `X-Forwarded-For`). Its
  own comment says: _"The Fastify trustProxy config reads X-Forwarded-For; we set
  both so the audit log + rate-limit buckets see the actual customer IP."_
- **But Fastify never sets `trustProxy`.** `apps/server/src/lib/app.ts:581`
  `Fastify({ loggerInstance, disableRequestLogging, genReqId })` — no `trustProxy`
  key. A repo-wide search finds `trustProxy` only in _comments_ (auth.ts:56,
  legal.ts:144) — the "plumbing in app.ts" those comments reference does not exist.

With `trustProxy` defaulting to `false`, Fastify ignores `X-Forwarded-For` /
`X-Real-IP` and resolves `req.ip` from the **socket peer**, which is nginx on
**`127.0.0.1`**. So **`req.ip === '127.0.0.1'` for every real (proxied) request.**

## Impact

Two distinct prod bugs, one root cause:

1. **IP brute-force gate collapses to a single global bucket.**
   `apps/server/src/middleware/ip-rate-limit.ts` keys on
   `` `${cfg.bucketPrefix}:${ip}` `` where `ip = req.ip = '127.0.0.1'`. So EVERY
   client shares one bucket per endpoint. With the locked `AUTH_IP_LIMITS`
   (login 10/min, signup 5/min, password-reset 3/min, oauth-client 5/min, …), the
   limit is enforced **globally across all customers**, not per-IP:
   - **Reliability / latent outage:** at launch scale the global bucket is exhausted
     by normal aggregate traffic → legitimate users get 429s they didn't cause. The
     small capacities were sized for "one IP completes its flow," not "all of
     humanity shares 5 signups/min." Currently invisible only because pre-launch
     traffic is below the global cap.
   - **Security:** brute-force protection no longer isolates an attacker; per-IP
     gating (the stated launch-blocker, V-251) is effectively absent.

2. **Session/audit IPs are recorded as `127.0.0.1`.**
   `apps/server/src/routes/auth.ts` `clientIp(req) = req.ip ?? null` feeds
   `issuedFromIp` / `requestedFromIp` / `sourceIp` on login/signup/verify/reset/
   magic-link (9+ call sites: auth.ts:157,184,208,226,256,311,329,347,365…). Every
   password-flow session's origin IP is `127.0.0.1` — useless for forensics, anomaly
   detection, or "where was this session created" surfacing. (Note: the
   oauth-client routes use `readClientIp` (X-Forwarded-For leftmost) instead, so OAuth
   sessions record a real-ish — but client-spoofable — IP. The two paths disagree.)

## Why this is SURFACE-only (not an autopilot auto-fix)

The clean fix is a **global change to how `req.ip` resolves**, which:

- Interacts with the **LOCKED** `client-ip.ts` XFF-leftmost decision
  (`[[project_disk_pressure_trend]]` — "XFF-first leftmost is DELIBERATE, 10+ pins").
  Changing IP resolution is an architecture-level stance, not a mechanical fix.
- Affects audit semantics globally (every session IP), geo in legal.ts, etc.
- The _correct_ `trustProxy` value depends on the **exact `X-Forwarded-For` chain
  that actually reaches Fastify in prod** (CF's XFF handling + nginx's append), which
  must be verified empirically before choosing — a wrong value either keeps it broken
  or makes `req.ip` client-**spoofable** (e.g. `trustProxy: true` ⇒ leftmost XFF ⇒
  attacker rotates `X-Forwarded-For` to defeat the gate AND forge audit IPs).
- `config.host` defaults to `0.0.0.0` (HOST unset in prod env templates) ⇒ Fastify
  binds all interfaces and may be reachable **directly**, bypassing nginx, unless
  port 7780 is firewalled. So `X-Real-IP` is only spoof-proof if the origin is
  locked to the nginx/CF path — an infra fact to confirm, not assume.

## Fix design (founder/infra to choose; verify the prod XFF chain first)

Recommended order:

1. **Empirically capture** what `X-Forwarded-For` + `X-Real-IP` actually look like on
   a request that traversed CF→nginx→Fastify (one-line debug log of both headers +
   `req.socket.remoteAddress` on any route, or `tcpdump`/nginx `$http_…` log). This
   determines the right hop count.
2. Pick ONE resolution strategy and apply it once:
   - **(A) `trustProxy` = the nginx hop only** (e.g. `trustProxy: '127.0.0.1'` or
     `trustProxy: 1`), NOT `true`. proxy-addr then returns the rightmost untrusted
     XFF entry = the real client nginx appended (unspoofable, since the client can
     prepend XFF entries but not control the rightmost nginx adds). Fixes `req.ip`
     globally → both bugs at once. **Confirm the leftmost-vs-rightmost semantics
     against step 1's evidence.**
   - **(B) Bind Fastify to `127.0.0.1` + key rate-limit (and `clientIp`) on
     `X-Real-IP`** (nginx-authoritative; nginx overwrites it). Contained, but bakes
     in the nginx-specific header and requires the localhost bind to be spoof-proof.
   - **(C) Enforce rate limiting at the Cloudflare edge** (CF rate-limiting rules)
     and treat the origin gate as best-effort defense-in-depth. Doesn't fix the
     audit-IP bug.
3. Whichever is chosen: add an integration test that asserts `req.ip` (or the
   rate-limit key) reflects a forwarded client IP and is NOT `127.0.0.1`/spoofable,
   and update `infra-*-content-parity` + `routes-auth-content-parity` pins if the
   nginx/Fastify config changes. Reconcile the two audit-IP paths (`clientIp` vs
   `readClientIp`) onto one resolver while respecting the locked XFF stance.

## Notes from the same audit (rate-limit core is otherwise sound)

- Redis Lua token bucket (`redis-rate-limit-store.ts`) is atomic (single `EVAL`),
  refill math is correct, `elapsed` is clamped ≥0 (clock-skew safe), and div-by-zero
  is guarded (`math.max(refill_per_sec, 0.0001)`).
- `memory-rate-limit-store.ts` (TEST-only) has NO div-by-zero guard on its deny path
  (`deficit / refillPerSecond`) — a `refillPerSecond: 0` bucket would return
  `Infinity` retry vs Redis's finite value. **Latent only**: no tier default uses a
  0 refill (all are ≥1) and it's not the prod store. Worth a one-line `Math.max`
  parity guard if touched.
- The float-vs-int `remaining` divergence between the two stores (Redis truncates
  Lua number replies to int; memory store returns the float) is **cosmetic** — the
  middleware `Math.floor`s `remaining` before the `x-ratelimit-remaining` header
  (rate-limit.ts:65, ip-rate-limit.ts:82), so it never reaches a customer.

Recorded in memory `project_trustproxy_ip_resolution_gap`.
