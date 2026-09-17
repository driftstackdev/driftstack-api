# A2 2026-09-17 — the request-timeout chain, and audit batch 3

Written after finding a production defect that three careful reviews had walked
past. Records what was fixed, what was **refuted**, and what is verified but
deliberately left open with its fix written down.

---

## 1. The finding: an ordering invariant that named two of four layers

**Status: FIXED and DEPLOYED (prod + staging), guarded by a test.**

`apps/gui-client/src/lib/account-proxies.ts` carried this rule above the desktop
deadline, written when it was raised 30s → 90s:

> "Keep this ABOVE the control plane's fleet wait. If the server's wait ever
> exceeds this, the bug returns in full and looks exactly like a server fault."

The reasoning was sound and the fix it justified was correct. But the chain has
**four** layers and the rule names two:

| layer                           | budget  |                                                     |
| ------------------------------- | ------- | --------------------------------------------------- |
| server handler (VPN proxy test) | 80s     | node's published 70s bring-up budget + 10s slack    |
| **nginx `location /`**          | **60s** | ⛔ the hole — below _both_ neighbours               |
| desktop client deadline         | 90s     | reconciled against the handler, not the edge        |
| Cloudflare 524                  | 100s    | hard outer bound; nothing in this repo can raise it |

A VPN tunnel that was merely **slow** to come up died at a wall neither side
names, and the customer got a gateway error page for a proxy nobody had finished
measuring — the exact symptom the 30s → 90s change was made to kill, relocated
one layer inward and invisible to the argument that fixed it.

WireGuard reaches the 60–80s band routinely, not as a rare tail: up to 12s for
the utun device, up to 15s for the handshake poll, the QUIC leg's 20s ceiling, a
teardown, and two post-tunnel exit fetches.

`POST /v1/profiles/:id/trim` was worse-shaped: budgeted at **exactly** 60s, tied
with the edge. nginx starts its clock first — auth, the ownership lookup and the
relay reservation all precede the handler's own timer — so the handler always
lost and its discriminated timeout body was unreachable _in principle_, not just
in the tail. **A prior audit cleared this figure** by asking whether 60s was
enough for a trim: the right question about the wrong layer.

### Fix

- `infra/nginx` (prod + staging): a location for the two long-blocking relay
  routes at `proxy_read_timeout 90s`.
- `gui-client`: desktop deadline 90s → 95s, so it still outlasts the new edge.
- Final ordering: **handler 80s < nginx 90s < desktop 95s < Cloudflare 100s.**
- `apps/server/tests/unit/edge-timeout-vs-handler-budget-cross-source-invariant.test.ts`
  parses the shipped nginx config the way nginx resolves a location (exact →
  regex in file order → longest prefix) and asserts the ordering for all nine
  blocking relay routes.

### How it was verified (not by reasoning)

- The repo conf is a **view**; the live box is the artefact. `ssh` confirmed prod
  nginx matched the repo before any change.
- Which location matches was proved by **asking nginx**, not by comparing my
  regex to my own resolver — two instruments of mine agreeing is not corroboration.
  On staging, both candidate locations were tagged with a temporary response
  header: the two intended paths resolved to the new location, two control paths
  to the catch-all, all four still reaching the app (401, not 404/502).
- Deployed behind `nginx -t` with a restore-on-failure path.
- ⚠️ **`systemctl reload` returning 0 means the signal was sent, not that the new
  config is serving.** A curl issued immediately after the reload still hit the
  old workers and read the probe header back from a config that was no longer on
  disk. The evidence that a reload took effect is **worker PID turnover**
  (2176380/81 → 2195012/13 on prod), not the reload command's exit code.
- Post-deploy: prod `/version` = `51d458df6`, relay routes answer 401 through the
  new location, `check-infra-drift` reports 7/7 matching.

---

## 2. Refuted — claims from the audit list that did not survive reading the code

Recorded because a refuted finding re-enters the list next time unless the
refutation is written down.

- **"`DISPATCH_DEADLINE_RESULT_DRAIN_MS = 10_000` is declared but never used, and
  was meant to be added to the dispatch deadline."** False. It and
  `DISPATCH_DEADLINE_BROWSER_CLEANUP_MS` **decompose** `DISPATCH_TIMEOUT_SLACK_MS`
  (4s cleanup + 10s drain + 1s margin = 15s), and
  `harness-dispatch-correlator.test.ts:85-89` pins that arithmetic. They are
  intentional mirrors of the harness's terminal-deadline budget, not dead code.

- **"7 intents sit at a bare 30s, below the node's 45s script timeout."** The
  first half is exactly right — `press_key`, `execute_script`, `detect_challenge`,
  `extract`, `screenshot`, `get_page_source`, `perceive` all fall through to
  `DISPATCH_TIMEOUT_BASE_MS`. The second half is **UNVERIFIABLE HERE**: no 45s
  script-timeout constant exists anywhere in this repo. That number lives in A3's
  harness, which A2 does not read or write. Not asserted either way.

- **"The SLA endpoint's `total === 0 ? 100` scores unprobed targets as perfect."**
  The branch is **unreachable**: `countByTargetSince` is a `GROUP BY target` over
  existing probe rows, so every group has ≥1 row and `okCount + failCount ≥ 1`.
  A latent trap if that query ever becomes a left join — not a live defect. (The
  _omission_ half of the same finding is real; see §3.)

---

## 3. Verified, NOT fixed — the public SLA endpoint omits targets it never probed

**Status: CONFIRMED, open. Fix written down; deliberately not attempted at the
tail of a session because it changes a public API contract.**

`GET /v1/status/sla` (public, no auth) builds its report from
`countByTargetSince`, a `GROUP BY` over probe history. A configured target with
**no rows in the 30-day window is absent from the response entirely.**

So if probing for a target stops — misconfiguration, a crashed prober, a renamed
target — the target does not degrade on the status page. It **disappears**, and a
page listing only the surviving targets reads as all-good. Monitoring failing is
indistinguishable from nothing being wrong, which is this codebase's recurring
defect class in its most customer-visible position.

**Fix:** build the report from the configured target list
(`HealthProbeServiceConfig.targets`) left-joined onto probe history, so a target
with no data appears with an explicit no-data state rather than vanishing.

**Blast radius (why it is a considered change, not a quick one):** `uptimePct` is
`z.number()` in the public OpenAPI (`apps/server/src/lib/openapi.ts:7465`).
Making it nullable changes the published contract and requires
`npm run sdk:python:dump-spec` + `npm run sdk:python:generate` in the same change,
or the repo guards red. An alternative that avoids the contract change is to add
a separate field naming the unprobed targets, leaving `uptimePct` alone.

---

## 4. Verified, correctly handled already — `dns_remote_resolve`

Not a defect to fix blind. `session-capability-report-relay.ts:312` hardcodes
`true`, but it is a **structural** claim with its source cited (the harness proxy
chain installs no local resolver, so hostnames go upstream), not an invented
measurement. `SessionsHistoryView.tsx:245-254` already documents the writer as
broken, keeps the consumer branch correct, and names the real per-proxy
measurement (ATYP=DOMAINNAME support) as the intended source.

The one thing worth watching: the structural claim holds only if the upstream
**accepts** hostnames. A SOCKS5 proxy that rejects ATYP=DOMAINNAME forces local
resolution, and `dns_atyp_domainname_supported` already measures exactly that.
When that value is reachable per session, it should feed this field.

---

## 5. Also fixed — the drift checker compared the wrong host's artefacts

`scripts/check-infra-drift.mjs` told you to "point DRIFT_HOST at staging". Doing
that compared **production's** five artefacts against the staging box, reported
all five as drift because they are absent there, and skipped the one file that
belongs to staging — while standing on it. Five false positives and the true
question never asked, from the documented invocation.

Ownership is now a property of each artefact (a role per entry in `TRACKED`, plus
a `HOSTS` map). An unrecognised `DRIFT_HOST` with no `DRIFT_ROLE` is refused with
exit 2 rather than defaulted. The staging vhost becomes a first-class tracked
artefact — it had been "tracked" while never once being compared to anything.

---

## The through-line

Every item here is one shape: **an instrument that cannot express the answer
returns one anyway, and its silence reads as a pass.** The edge timeout, the
omitted SLA target, the drift checker pointed at the wrong host, and the four
fixes pushed earlier today (a TTL naming an OS with nothing corroborating it, a
tile saying "all healthy" before anything was checked, a proxy count asking only
whether the host answered, a jitter buffer treating an unmeasured link as
perfect) are the same defect wearing different clothes.

The specific lesson of §1 is sharper and worth keeping separate: **an ordering
invariant verified between two layers proves nothing about a layer neither of
them names**, and a comment asserting an invariant is not a check. The previous
version of that rule was a comment. It held, for the two layers it mentioned,
while the route stayed broken.
