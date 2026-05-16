# Customer-configurable egress — server-side implementation design

**Status:** DESIGN. Implementation deferred pending founder go-ahead.

**Context:** The homepage F-2 product-differentiator strip promotes
SOCKS5 / WireGuard / OpenVPN proxies as launch features (per founder
Issue 6 directive on 2026-05-16). But four honest-disclosure
surfaces (security.astro egress card, trust/index.astro security-
overview card, trust/security-overview.astro detailed posture,
homepage code-preview comment) currently disclose "not shipped
today" — gated by parity tests against actual
`apps/server/src/` source state. See
`docs/internal/2026-05-16-frontend-overhaul-handoff.md` for the
full contradiction trace.

This doc describes the minimum-viable server-side implementation
that satisfies both sides: the homepage claim becomes truthful, the
honest-disclosure parity tests auto-skip (because the gating tokens
appear in source), and the disclaimers can drop.

## Scope

**In scope (v1):**

- Per-session SOCKS5 client config
- Per-session WireGuard tunnel config
- Per-session OpenVPN tunnel config
- Schema validation on session-create body (`proxy: { type, config }`)
- Hand-off to the browser process at session-start (egress applied
  to the WebKit fetch layer + any in-session network IO)
- Per-session metering of egress bytes routed via customer config
  (informational; not billed differently — proxies are customer-
  paid, Driftstack just forwards)

**Out of scope (v1):**

- Driftstack-managed proxy pool (we sell sessions, not bandwidth)
- Auth-fronted proxies (customer config goes through verbatim;
  any credentials are customer's responsibility per AUP)
- Per-account default proxy (always per-session)
- Mid-session proxy rotation (single proxy per session)

## Wire surface

`POST /v1/sessions` body extends with an optional `proxy` field:

```ts
proxy?: {
  type: 'socks5' | 'wireguard' | 'openvpn';
  config:
    | { url: string; username?: string; password?: string }       // socks5
    | { wg_quick_config: string }                                  // wireguard
    | { ovpn_config: string; auth_user?: string; auth_pass?: string }; // openvpn
};
```

This already exists in the homepage SDK example (`proxy: { type:
'wireguard', config: '...' }`) — V-282 schema-only landing happened
earlier; the runtime side hasn't followed.

Schema validation is the existing zod tree under
`packages/api-types/src/sessions/` — add the discriminated union
and the wire test under `tests/unit/sessions-schema-*`.

## Service layer

New service: `apps/server/src/services/session-egress.ts`

```ts
export interface SessionEgressService {
  applyToSession(args: { sessionId: string; proxy: SessionProxyConfig }): Promise<EgressHandle>;

  releaseFromSession(handle: EgressHandle): Promise<void>;
}
```

The implementation orchestrates three concrete backends:

1. **SOCKS5** — pure HTTP-CONNECT proxy. The browser process
   forwards every TCP connection via the operator-supplied proxy
   URL. Implemented as a per-session `HTTPS_PROXY` env var at
   spawn time + browser-process CLI flag. No new infrastructure
   on the host.
2. **WireGuard** — per-session network namespace; the spawn
   wrapper `ip netns add ds-<sessionId>` + `wg-quick up` against
   the customer config (written to a tmpfs file scoped to the
   namespace) + the browser process launched inside that netns
   via `ip netns exec`. Namespace torn down at session-end.
3. **OpenVPN** — per-session network namespace; `openvpn
--config` against the customer config file (tmpfs). Same
   namespace hand-off pattern as WireGuard.

Schema for tmpfs config files: never written to persistent disk
(per Privacy DPA Annex 3 — customer-supplied secrets must not
land at rest on Driftstack hardware).

## Schema additions

`session_egress_log` table tracking per-session egress configuration
(without storing the config itself — only the type + hashed
fingerprint for audit):

```sql
CREATE TABLE session_egress_log (
  session_id        uuid PRIMARY KEY REFERENCES sessions(id),
  egress_type       text NOT NULL,         -- 'socks5' | 'wireguard' | 'openvpn'
  config_hash       text NOT NULL,         -- sha256 of the config — for audit, not secret
  applied_at        timestamptz NOT NULL DEFAULT now(),
  released_at       timestamptz,
  bytes_egressed    bigint NOT NULL DEFAULT 0
);
```

`bytes_egressed` populated by the egress backend (each backend
already has a hook for byte counting). Surface via
`GET /v1/sessions/:id/egress` for the owning account.

## Security posture

- **Customer secrets** — config blobs (proxy URL, WG config, OVPN
  config) are encrypted at rest with the existing V-353b AES-256-GCM
  key for the brief moment they sit on tmpfs, and zeroed immediately
  on session-end. Driftstack staff cannot read them.
- **Egress audit** — `config_hash` lets ops correlate "this session
  ran through a customer-supplied proxy" against the audit log
  without exposing the customer's actual config.
- **Tunnel isolation** — per-session network namespaces guarantee
  cross-session leaks are impossible at the kernel level.
- **Outbound DNS** — by default, tunneled DNS through the customer
  proxy. An override `proxy.dns: 'driftstack'` keeps DNS on the
  Driftstack EU resolver (useful when the customer proxy is in a
  jurisdiction that does DNS sinkholing).
- **AUP enforcement** — the existing AUP checker runs against the
  destination URL pre-flight regardless of egress path; customer
  proxies don't bypass AUP.

## Cost model

Customer-configurable egress is **free** from a billing perspective
— Driftstack doesn't bill for the bytes (customer is paying their
own proxy provider). Driftstack DOES bill for the session-time as
normal.

The metering surface (`bytes_egressed` in the log) is informational

- surfaced on the dashboard so customers can correlate bandwidth
  usage against their proxy invoice.

## Activation gate

Same all-or-nothing posture as Postmark / LiveKit / OAuth: the
route registers when `apps/server/src/services/session-egress.ts`
is wired into `AppDeps.sessionEgressService`. Until then the
`proxy` body field on `POST /v1/sessions` is silently stripped
(no `customerEgress` / `proxyUrl` / `SOCKS5` token appears in
server source → the parity tests on security.astro / trust/\* keep
the disclaimer copy in place).

Once the impl lands:

1. Parity tests `security-page-doc-parity.test.ts:45`,
   `trust-index-doc-parity.test.ts:38`,
   `marketing-egress-claim-sweep.test.ts:48` auto-skip the
   roadmap-required clause (their `serverSourceMatches(...)` gate
   sees the new code).
2. The honest-disclosure copy on the marketing surfaces can drop
   the "(roadmap)" / "(not shipped)" framing in a follow-up PR.
3. The `# Roadmap — customer-configurable egress` code-preview
   comment in `apps/marketing-site/src/pages/index.astro` is
   removed.
4. The known-contradiction memory entry
   (`project_egress_card_contradiction.md`) is deleted.

## Estimated scope

| Slice | Description                                            | Hours |
| ----- | ------------------------------------------------------ | ----- |
| E1    | `session-egress.ts` service + interface                | 4     |
| E2    | SOCKS5 backend (simplest; HTTPS_PROXY env-var)         | 4     |
| E3    | WireGuard backend (netns + wg-quick + tmpfs)           | 12    |
| E4    | OpenVPN backend (netns + openvpn + tmpfs)              | 12    |
| E5    | `session_egress_log` migration + repo                  | 4     |
| E6    | Schema validation + `proxy` field on POST /v1/sessions | 4     |
| E7    | `GET /v1/sessions/:id/egress` endpoint + tests         | 4     |
| E8    | Bootstrap wire + AppDeps gate                          | 2     |
| E9    | Parity-test refresh + marketing copy cleanup           | 4     |
| E10   | Operator runbook + ops-doc + Annex 3 update            | 6     |

**Total: ~56h** across 2-3 weeks of dedicated work.

The two big rocks are WireGuard + OpenVPN backends — each needs a
per-session network namespace, careful tmpfs handling, byte-
metering hook, and a battery of integration tests against a real
tunnel. SOCKS5 alone is a 1-day slice; full v1 with all three
backends is a 2-3 week slice.

## Phased landing

**Phase 1 (SOCKS5 only):** Resolves the contradiction at the
homepage-strip level only if the strip is rewritten to claim just
SOCKS5 — but the founder's directive specifically named all three.
Could land as a "Phase 1 of N" with the strip + disclaimer copy
updated to "SOCKS5 today; WireGuard + OpenVPN in Q1" — but per
Issue 5, that's the kind of aspirational language we just removed.

**Phase 2 (full SOCKS5 + WireGuard + OpenVPN):** All-or-nothing
landing. Resolves the contradiction fully. Takes ~56h. Cleaner.

**Recommendation:** Phase 2 (all three together). The Issue 5 ban
on aspirational language makes Phase 1 awkward to position
truthfully.

## Risks

- **Tunnel reliability** — customer-supplied configs may be wrong
  / unreachable / mid-rotation. The session-start handshake must
  either succeed within 10s or fail the session with a clean
  4xx + `egress.tunnel.unreachable` problem-type. Don't leave the
  customer wondering whether their target URL is bad or their
  proxy is bad.
- **Provider-side abuse** — a customer with a stolen WG/OVPN
  config could route someone else's bandwidth through Driftstack.
  Not Driftstack's risk per se (the customer paid the proxy
  provider, not us) but the AUP must cover this so we don't end up
  in the loop on a third-party abuse report.
- **Performance** — per-session network namespaces have a startup
  cost (~150ms for WG, ~500ms for OVPN). Session creation latency
  budget needs to absorb that.
- **Audit log volume** — `session_egress_log` rows churn at
  session-create velocity. Same retention as `sessions` (90 days
  default, configurable per-tier).

## Out of scope explicitly

- **Driftstack-managed proxy pool** — would shift us from
  "browser-as-a-service" to "browser + bandwidth-as-a-service" and
  introduces a different cost model (bandwidth-billed) the rest
  of the product avoids.
- **Auth-fronted shared proxies** — bring-your-own-config is the
  privacy story. A shared pool that Driftstack provisions would
  weaken the "no behavioural data collection" posture by giving
  us a cross-customer egress-pattern dataset.
- **Per-account default proxy** — adds a "did this session use my
  default or what I explicitly passed?" mental load. Per-session
  explicit is simpler.
