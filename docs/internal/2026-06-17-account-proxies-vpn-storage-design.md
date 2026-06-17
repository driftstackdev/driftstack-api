# account_proxies → OpenVPN/WireGuard storage extension — build design

Status: DESIGN (build in a focused window once the A3 `inlineProxyConfig` VPN
wire shape is confirmed — see §6). Backlog item #1 (the ⭐⭐ A2 half of the
OpenVPN/WireGuard egress arc, planning 133 Phase 2/3). This doc settles the
schema/encryption/migration shape so the sensitive build is unambiguous and
fast — it is deliberately NOT spun up half-blind in a 20-min autopilot slot
(founder bar: "do it RIGHT across focused fires, don't rush sensitive things").

## 1. What exists today (verified 2026-06-17)

- **Type union already defined:** `packages/api-types/src/egress.ts`
  `ProxyConfigSchema = discriminatedUnion('type', [socks5 | openvpn | wireguard])`,
  matching planning 133 exactly:
  - `socks5`: `SocksProxyConfigSchema` (host/port/username?/password?/require_remote_dns).
  - `openvpn`: `{ config_blob (≤256 KB, must contain `client`+`remote <host> <port>`
directives), username?, password? }`.
  - `wireguard`: `{ private_key, peer_public_key (both 44-char b64 curve25519),
endpoint (host:port), allowed_ips (default 0.0.0.0/0), dns? }`.
- **Storage today is socks5/http only:** `account_proxies` (schema.ts:603) =
  `{ id, account_id, label, scheme('socks5'|'http'), host, port, username?,
wrapped_password, created_at, updated_at }`. The password is wrapped under the
  per-account TMK (`profile-key-hierarchy.ts`, AES-256-GCM, base64[iv|tag|ct]);
  plaintext is unwrapped server-side only at dispatch.
- **Dispatch is socks5-only:** `dispatchSessionAssignOnCreate` → `inlineProxyConfig`
  carries a `SocksProxyConfig`. The VPN forwarding is the unbuilt piece.

## 2. The secrets to encrypt-at-rest (Tier-3 — the sensitive crux)

Reuse the EXISTING per-account TMK wrap (no new crypto — `wrapDek`/`unwrapDek`
pattern, fresh random IV per call, GCM auth-tag, cross-account isolation is
cryptographic). The whole secret-bearing payload is wrapped; plaintext never
stored, never logged, scrubbed from errors/events (the egress-leak forward-guard
in fleet-control-registry already covers `direct=` node IPs).

| type        | SECRET (must wrap)                         | non-secret (plaintext ok)                   |
| ----------- | ------------------------------------------ | ------------------------------------------- |
| socks5/http | password                                   | host, port, username                        |
| openvpn     | config_blob (embeds certs/keys) + password | username                                    |
| wireguard   | private_key                                | peer_public_key, endpoint, allowed_ips, dns |

Note: the OVPN `config_blob` is itself secret (inline `<cert>`/`<key>` blocks) —
wrap the WHOLE blob, not just the password.

## 3. Schema shape (DECISION: extend account_proxies, do NOT add a pcfg table)

`account_proxies` is already THE per-account proxy store (ARC A); a parallel
`pcfg_<ulid>` table would fork the model for no gain. Extend additively:

```
ALTER TABLE account_proxies
  ADD COLUMN type text NOT NULL DEFAULT 'socks5',   -- socks5|http|openvpn|wireguard
  ADD COLUMN wrapped_secret text,                   -- TMK-wrapped secret payload (see §2); supersedes wrapped_password going forward
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}';    -- non-secret structured fields per type
```

- `host`/`port`/`username`/`wrapped_password` become **legacy/nullable** — they
  stay for the existing socks5/http rows (back-compat; no backfill needed since
  `type` defaults 'socks5' and the existing read path keeps working). New writes
  MAY consolidate into `config` + `wrapped_secret`, but the migration is
  ADDITIVE and behavior-identical until a VPN row is written (the safe-migration
  invariant — mirrors the recycle-bin 0077 partial-index approach).
- `config` jsonb holds the non-secret fields: openvpn `{username?}`; wireguard
  `{peer_public_key, endpoint, allowed_ips, dns?}`; socks5 `{}` (host/port/username
  stay in their columns for now).
- Migration is HAND-AUTHORED idempotent SQL (NOT drizzle-kit generate — corrupts;
  journal `when`=prev+3600000). Next migration # = check the journal.

## 4. Repo + service

- `AccountProxiesRepo`: widen create/update/list/findOwned to carry `type`,
  `config`, `wrapped_secret`. Keep `findOwned(id, accountId)` account-scoped
  (the ownership boundary the dispatch validation relies on — already proven).
- `AccountProxiesService.resolveForDispatch({proxyId, accountId})`: branch on
  `type` → unwrap the secret → assemble the `ProxyConfig` union value. SSRF guard
  (`classifyUnsafeHost`) applies to the CUSTOMER-resolved host (socks5 host /
  openvpn `remote` / wireguard endpoint host) in prod; the operator/dev loopback
  path stays allowed (gate on dev flag or only-guard-customer-resolved). For
  openvpn the `remote` host is inside the blob — extract it for the SSRF check,
  or rely on the harness VM's egress safeguard (decide in build; lean on both).

## 5. API + GUI

- `/v1/account/me/proxies` POST/PATCH accept the discriminated `ProxyConfig`
  (the egress.ts union) instead of the flat socks5 body. Return a REDACTED
  summary (never echo config_blob/private_key/password) — write-only secrets.
- SDK lockstep (TS/Go/Python) — the union widens the request type; mirror ARC A
  slice 3's lockstep + parity guards.
- GUI proxy editor: a `type` selector → socks5 (host/port/user/pass) | OpenVPN
  (textarea/file for the .ovpn + optional user/pass) | WireGuard (5 fields, with
  a CLIENT-SIDE wg0.conf paste→fields parser per the memory's settled decision —
  no harness/schema change). Map the harness fail-fast errors (missingField/
  malformed/oversized) to inline form errors.

## 6. Dispatch — the ONE A3-GATED piece (asked on the bus 2026-06-17)

`SessionDispatchConfig.proxy` is `SocksProxyConfig`; widen to `ProxyConfig` and
serialize the resolved union into `inlineProxyConfig`. BLOCKED pending A3's
confirmation of the exact wire shape the harness `VPNProxyConfigParser` expects
(full `ProxyConfig` JSON as-is under `proxy.openvpn`/`proxy.wireguard`?). Build
§3–§5 first (storage + API + GUI collect), wire §6 once A3 replies — the
GUI-collect half is independently shippable and useful.

## 7. Slice sequence (focused window, staging→verify→prod each)

1. Additive migration (§3) + repo/service widen (§4), tests — behavior-identical,
   no VPN write path yet. Deploy verified.
2. API + SDK lockstep (§5 server+SDK) + redacted summaries + parity. Deploy.
3. GUI editor (§5 GUI) + wg0.conf parser + Tauri rebuild.
4. Dispatch wiring (§6) — after A3 wire-shape confirm. Deploy + the egress
   integration test (SSRF on customer host; loopback allowed in dev).

## 8. Security checklist (do not skip — customer VPN keys)

- [ ] config_blob + private_key + password wrapped under the account TMK; never
      stored/logged in plaintext; scrubbed from error/event/webhook detail.
- [ ] Redacted API responses (write-only secrets).
- [ ] SSRF guard on customer-resolved hosts (prod); dev loopback preserved.
- [ ] findOwned account-scoping holds (no cross-account proxy reach — proven path).
- [ ] Cross-account TMK isolation verified (wrong-account unwrap fails GCM — the
      existing profile-key-hierarchy invariant; add a proxy-secret test mirroring it).
