# 2026-05-31 — Webhook delivery SSRF: customer-controlled outbound target (Agent 2)

**Status: redirect-follow bypass FIXED this wave; the direct-internal-target + DNS-
rebind layer SURFACED.** Found by a fresh audit of webhook delivery (existing memories
cover delivery _mechanics_ — retry/cursor/signature/reclaim — but not outbound-target
SSRF). The server makes outbound POSTs to a **customer-controlled** URL, the classic
SSRF surface.

## What the audit found

Webhook endpoint URLs are customer-supplied. Validation:

- **Create/update** (`packages/api-types/src/webhooks.ts`): `z.string().url().refine(u
=> u.startsWith('https://'))`. This blocks `http://` (incl. plain-HTTP cloud-metadata
  like `http://169.254.169.254`) and non-HTTP schemes — a real first layer — but it
  **allows HTTPS pointed at internal/private hosts**: `https://localhost`,
  `https://127.0.0.1`, `https://10.x`, `https://192.168.x`, `https://[::1]`,
  `https://<internal-host>`. No private-IP/loopback/link-local block.
- **Delivery** (three independent fetch sites — `packages/webhook-delivery/src/in-memory.ts`,
  `apps/server/src/services/durable-webhook-delivery.ts`,
  `apps/server/src/services/webhook-worker.ts`): plain `fetch(endpoint.url, …)` with
  **no `redirect` option** ⇒ default `follow`. So `https://attacker.com → 30x →
http://169.254.169.254/` (or any internal target) was followed, bypassing the
  create-time https-only check.
- **Oracle:** `POST /v1/webhooks/:id/test` returns `202` immediately (async), but the
  per-attempt outcome (status code, success/fail, latency) lands in the readable
  delivery-attempts log → a _semi-blind_ oracle (no response-body exfiltration, but
  internal-host reachability/status/timing is observable).

## Severity: MEDIUM

Blind / semi-blind: the response body is never returned to the customer (delivery
records only status + timing), so no direct data exfiltration. The POST carries a
signed body to the customer URL; metadata services usually need GET + a header, so a
useful metadata _read_ is unlikely. The real risk is internal-network probing
(which hosts/ports answer, via the delivery log) and reaching internal services that
act on a POST. Bounded → MEDIUM. (The prod box is Hetzner, whose metadata service is
at `169.254.169.254` over HTTP — reachable only via the now-closed redirect bypass.)

## FIXED this wave — no redirect following

All three delivery fetch sites now pass `redirect: 'error'` (do not follow 3xx; a
redirect surfaces as a failed attempt — matches Stripe's webhook behavior). This
closes the `https → 30x → internal` bypass. Pinned in all three content-parity tests
(`webhook-delivery-in-memory` / `services-durable-webhook-delivery` /
`services-webhook-worker`) + a behavioral test in
`packages/webhook-delivery/tests/in-memory.test.ts` asserting the option is passed.
Safe: a well-behaved webhook receiver returns 2xx directly; pre-launch there are no
customer endpoints relying on redirect-following.

## FIXED — wave (create/update-time literal-IP block)

The direct case (`https://10.0.0.5`, `https://localhost`, `https://[::1]`,
`https://169.254.169.254`, IPv4-mapped `::ffff:…`) is now **rejected at create + PATCH**
via `apps/server/src/lib/webhook-target-guard.ts::unsafeWebhookTargetReason`, wired
into `routes/webhooks.ts` (400 `BadRequestError`). Built on Node's `net.BlockList`
(vetted range math). Two non-obvious traps were caught empirically + pinned in the
exhaustive unit test (`webhook-target-guard.test.ts`, incl. public-IP boundary cases
so a typo'd CIDR can't false-positive): `new URL('https://[::1]/').hostname` keeps the
brackets (strip before `isIP`), and `::ffff:0.0.0.0/96` in a BlockList matches EVERY
IPv4 (so `::ffff:` mapped is rejected outright instead). Integration test asserts the
metadata/private/loopback/localhost/IPv6-loopback cases → 400; content-parity pins the
guard wiring. Zero legit false-positives (no real webhook targets an internal IP; DNS
hostnames pass through to the connection-time layer below).

## REMAINING (surfaced — needs careful, well-tested impl)

1. **Connection-time resolution + pinning (DNS-rebind-complete):** a create-time
   hostname check is insufficient — a hostname can resolve to a public IP at create
   and a private IP at delivery (DNS rebinding). Resolve at delivery, reject private
   targets, and connect to the _resolved_ IP (pin it) so the check and the connection
   agree. Easiest via undici with a custom `lookup`/connector, or a vetted
   SSRF-safe-fetch dependency.
2. Reconcile the semi-blind oracle: the delivery-attempts log exposes per-attempt
   status/timing for a customer-controlled target — acceptable once the redirect +
   literal-IP + connection-time-pinning layers restrict
   the target set to public hosts.

Recorded in memory `project_webhook_ssrf_outbound_target`.
