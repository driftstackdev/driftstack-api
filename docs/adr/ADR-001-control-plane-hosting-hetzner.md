# ADR-001 — Control-plane hosting on Hetzner Cloud

**Status:** Accepted
**Date:** 2026-05-03
**Tier:** Architectural (approved deviation; vendor / structural)
**Related V-entry:** V-051 (network architecture doc + deploy pipeline targeting Hetzner), V-054 (revocation + JWT rotation pinned against Hetzner-side mTLS termination).

## Context

Initial planning specced **Railway** or **Fly.io** as the control-plane
host — both PaaS providers, Postgres + Redis available as managed
add-ons or via marketplace, Dockerfile-driven deploys, minimal sysadmin
surface. That plan reflected a "ship fast, optimise later" instinct: a
PaaS reduces operational load to near-zero in exchange for
higher per-resource cost and weaker control over the runtime
environment.

The team reconsidered before Workstream A (hosting integration
scaffolding) landed and selected **Hetzner Cloud** (CCX13 VMs,
Falkenstein region, Germany) instead. Two CCX13 instances at ~€25/mo
each = ~€50/mo total for staging + production, vs Railway / Fly.io
which would be cost-comparable for compute alone but stack additional
charges for managed Postgres + Redis (Driftstack uses Neon + Upstash
for those, decoupling host from datastore).

Constraints that shaped the rethink:

- **GDPR posture.** Driftstack ships an EU-jurisdiction privacy stance
  (sub-processor list locked to EU-region providers where possible).
  Hetzner is a German company; Falkenstein and Nürnberg datacenters
  are EU jurisdiction. Railway hosts on Google Cloud (multi-region but
  primary US infrastructure). Fly.io hosts on its own globally
  distributed fleet but the corporate entity is US-based. Neither
  PaaS rules out EU-only data residency, but neither makes the EU
  posture as straightforward as a German hyperscaler-adjacent provider.
- **VM-level control for future build infrastructure.** The Mac Mini
  fleet at MacStadium is the eventual session-execution surface, but
  the control plane may also need to host a CI build runner, a
  WireGuard concentrator (per V-054 v2), or other tenant
  infrastructure that's awkward on a PaaS where you don't own the VM.
  IaaS keeps that door open without a future migration.
- **Cost predictability at low scale.** PaaS pricing is per-resource +
  per-feature; IaaS is per-VM-flat. At pre-customer / first-customer
  scale, a flat €50/mo total for staging + production is an easier
  budget item than "Railway billing oscillates with usage." The
  predictability matters more than the absolute cost at this stage.
- **Datastore decoupling.** Postgres → Neon (managed, EU Frankfurt).
  Redis → Upstash (managed, EU Frankfurt). Object storage → Cloudflare
  R2 (EU jurisdiction). The host VM owns no data; it's a stateless
  application runtime. That decoupling neutralises the "managed
  Postgres add-on convenience" argument for PaaS.

## Decision

> **⚠ V-869 — what shipped is not what this decision specified.**
>
> The decision below stands as the record of what was decided. It is not what
> runs. `docs/progress/v278-final-state.md` carries the sub-processor map marked
> live and matching DPA Annex 3, and it records **Hetzner Nuremberg (NBG1),
> production CPX32 + staging CPX22** — a different region and a different machine
> class (CPX is shared-vCPU; CCX is dedicated). Four documents give four answers
> between them, and nothing recorded the supersession.
>
> Two consequences worth naming rather than leaving to be rediscovered:
>
> - The launch checklist still lists Hetzner provisioning, the Neon databases and
>   the Upstash Redis as PENDING. The repo ships `infra/bootstrap/deploy-api.sh`
>   targeting both hosts by address, `scripts/deploy-status.sh` reading the
>   running SHA off each, and a cutover script that SSH-swaps `REDIS_URL` on
>   production. Those rows describe work the tooling assumes is finished.
> - `cost-defaults` derives its compute rate from "Hetzner CCX13 averaged across
>   the fleet". If the fleet is CPX32/CPX22, that basis is a different machine
>   class. Recorded here; not changed, because a cost constant should move on a
>   measurement rather than on an inference from this note.
>
> The legal surface is unaffected and was checked: DPA Annex 3 and privacy-policy
> §7 both state Hetzner as "Germany", which is true of Nuremberg and Falkenstein
> alike, so no customer-facing document is wrong. Region granularity is exactly
> where this drift stayed harmless.
>
> Resolving which machine class and region are authoritative is an operational
> confirmation, not a documentation edit, so it is left open here.

**Host the Driftstack control plane on Hetzner Cloud, two CCX13 VMs
(staging + production), Falkenstein region.** Cloudflare Tunnel fronts
the VMs for edge HTTPS termination and DDoS protection — **NOT AS
SHIPPED (V-1088): no `cloudflared` runs in `infra/`; Cloudflare
proxies to a publicly reachable origin nginx instead, and
`bootstrap.sh` opens 80 and 443. The hosting decision stands; the
fronting mechanism differs, and `docs/network-architecture.md` §1
describes what runs.**; the VMs run
the control plane container behind loopback-only HTTP; mTLS for the
fleet endpoint terminates directly on the Hetzner VM (per V-054
decision 1A — skip Cloudflare API Shield).

Deploy pipeline (`.github/workflows/deploy.yml`, V-051) builds the
container image, pushes to GitHub Container Registry (`ghcr.io`),
SSHes to Hetzner, runs `docker compose pull && docker compose up -d`,
polls `/health`. Production deploy is gated on the `production` GitHub
environment's manual-approval policy (the configured approver gates
production deploys).

## Consequences

**Enables:**

- EU-only data residency for control-plane compute, matching the
  privacy-policy posture without a footnote.
- Flat-rate cost predictability (~€50/mo total for staging +
  production) at pre-customer / first-customer scale.
- VM-level control for future co-tenant infrastructure (CI runners,
  WireGuard concentrator, etc.) without a host migration.
- Direct mTLS termination on the VM (V-054 decision 1A) — would need
  Cloudflare API Shield (paid feature) on a PaaS that doesn't permit
  arbitrary cert-presentation customisation.

**Rules out:**

- Zero-touch ops. Hetzner Cloud VMs require OS patching, SSH key
  hygiene, manual disk-monitoring, manual log rotation. Mitigated by:
  bare-bones container-only host (the control plane runs in Docker;
  the host OS does nothing else), Hetzner's own automated security
  patches via unattended-upgrades, log rotation baked into the
  docker-compose service config (50 MB × 5 files per V-051).
- Auto-scaling. CCX13 is fixed at 4 vCPU / 16 GB RAM. Vertical scale
  is a downtime-required rebuild; horizontal scale requires manual
  fleet expansion + load balancer fronting. Acceptable at v1; revisit
  trigger documented below.

**Operational load created:**

- Founder owns: SSH key rotation, OS patching cadence (monthly
  unattended-upgrades reboot), monitoring of disk + CPU + memory,
  Hetzner-side firewall config.
- Agent owns: container build + deploy automation, application
  monitoring (Sentry + Pino logs), readiness probes.

**Cost accepted:**

- Higher operator time-on-ops than a PaaS would impose. Mitigated by
  the bare-bones host posture (the only non-Docker thing on the box
  is Cloudflare Tunnel + the unattended-upgrades agent).

## Alternatives considered

### Railway (planned)

- **Pro:** zero ops, managed Postgres + Redis available as add-ons,
  push-to-deploy workflow that integrates with GH out of the box.
- **Con:** US corporate entity (privacy posture footnoted); GCP
  underlay means the EU-only data residency claim requires explicit
  region selection per service; no support for arbitrary mTLS cert
  presentation on the fleet endpoint without a paid plan; per-resource
  billing is harder to predict at scale.
- **Why rejected:** the GDPR posture footnotes were the dominant
  factor. Driftstack's privacy policy ships the sub-processor list as
  a load-bearing customer commitment; "control plane is on Railway,
  which is on GCP, which is in the EU region we picked" is a longer
  story than "control plane is on Hetzner Falkenstein."

### Fly.io (planned)

- **Pro:** globally distributed, low ops, Docker-native, EU regions
  available, supports private networking via WireGuard out of the box
  (would have simplified V-054 v2).
- **Con:** US corporate entity; primary support relationship is in
  English over GH issues / Slack rather than EU business hours;
  reliability incidents over 2024-25 created some team concern
  about stake-our-business-on-it posture; per-VM pricing is
  competitive but stacks add-ons.
- **Why rejected:** the team weighed the corporate-entity factor +
  reliability track record + the Hetzner cost-predictability
  advantage and chose Hetzner. Fly.io's WireGuard primitive is a real
  consideration for V-054 v2 (mesh between control plane and fleet);
  if that becomes load-bearing, this ADR's revisit triggers fire.

### MacStadium (the fleet host, considered for control plane too)

- **Pro:** already in the sub-processor list (Mac Mini fleet for
  session execution); collapsing to one vendor would simplify
  procurement.
- **Con:** US jurisdiction (Las Vegas); MacStadium specialises in
  macOS hosting (the control plane runs Linux containers, not macOS);
  per-mini cost is several multiples of a Hetzner VM.
- **Why rejected:** wrong tool for the job. MacStadium's value is
  macOS-specific WebKit hosting; the control plane is jurisdictionally
  better in Germany and architecturally better on Linux.

## Revisit triggers

Re-evaluate this decision if **any** of the following fires:

- **Fleet scale ≥ 5 nodes or multi-region.** V-054 v2 design (WireGuard
  mesh) would be operationally simpler on a host with first-class
  WireGuard primitive (Fly.io) than on Hetzner where it's manual
  config. Trigger metric: fleet node count from `fleet_nodes` table
  WHERE `revoked_at IS NULL`.
- **Founder operational load exceeds 4h/month on host ops.** If SSH
  hygiene, patching, monitoring tasks consume more than 4h/month
  measured over a quarter, the PaaS-zero-ops argument re-enters.
  Trigger metric: internal review at quarterly review.
- **Hetzner adverse event** affecting EU-jurisdiction posture (e.g.,
  acquisition by a US entity, datacenter migration that crosses an
  EU border). Trigger event: legal + counsel review on any change
  to Hetzner's corporate or jurisdictional status.
- **Compliance requirement requiring SOC 2 / ISO 27001 of the host.**
  Hetzner has ISO 27001 for its datacenters but not the PaaS-style
  comprehensive certifications some enterprise customers demand. If
  the customer mix shifts toward enterprise procurement, a hyperscaler
  (AWS Frankfurt / GCP europe-west) re-enters consideration. Trigger
  event: first enterprise prospect demanding host-level compliance
  certification beyond what Hetzner provides.
- **Cost exceeds €500/mo for control plane.** At that scale, multi-VM
  - load balancer + auto-scaling tradeoffs change. Trigger metric:
    Hetzner monthly invoice.

## Notes

This ADR is the first in the directory; the pattern itself is also
new (ADR README explains the format). Future architectural deviations and
load-bearing contextual decisions land here; routine decisions
continue to use the one-paragraph `D-NNN` entries in
`docs/decisions.md`.

The decision-log entry that points at this ADR will be added when the
next D-entry is opened (numbering follows commits, not ADR landings).
