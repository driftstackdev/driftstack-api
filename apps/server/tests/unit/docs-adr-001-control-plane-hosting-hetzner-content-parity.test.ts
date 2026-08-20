// W549.C — drift guard for /docs/adr/ADR-001-control-plane-hosting-hetzner.md.
// Architectural decision record. Drift here either weakens the
// Hetzner-vs-PaaS rationale (would mislead about why we left the
// Railway / Fly.io path), changes the V-051 + V-054 cross-reference
// (would orphan the deploy pipeline + mTLS termination contracts),
// or drops the GDPR-EU-residency / cost / VM-control / datastore-
// decoupling 4-constraint framing that justified the deviation.
//
//   • Status: Accepted, 2026-05-03, Architectural (approved deviation).
//   • Related V-entry: V-051 + V-054.
//   • Hetzner Cloud CCX13 × 2 Falkenstein, ~€50/mo staging+production.
//   • Cloudflare Tunnel for edge HTTPS + loopback-only HTTP backend.
//   • mTLS for fleet endpoint terminates directly on Hetzner VM
//     (V-054 decision 1A — skip Cloudflare API Shield).
//   • Deploy: .github/workflows/deploy.yml → ghcr.io → SSH → docker
//     compose pull && up -d → /health poll. Production gated on
//     'production' GitHub environment manual-approval.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/ADR-001-control-plane-hosting-hetzner.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W549.C /docs/adr/ADR-001-control-plane-hosting-hetzner.md content parity', () => {
  const body = read(LIB);

  it("Header + Status + Tier + V-entry framing pinned: '# ADR-001 — Control-plane hosting on Hetzner Cloud' + '**Status:** Accepted' + '**Date:** 2026-05-03' + '**Tier:** Architectural (approved deviation; vendor / structural)' + '**Related V-entry:** V-051 (network architecture doc + deploy pipeline targeting Hetzner), V-054 (revocation + JWT rotation pinned against Hetzner-side mTLS termination).' — pinned so the ADR-001-Accepted-2026-05-03 + Tier-Architectural-approved-deviation + V-051-deploy-pipeline + V-054-revocation-JWT-rotation-Hetzner-mTLS commitment survives", () => {
    expect(body).toMatch(/^# ADR-001 — Control-plane hosting on Hetzner Cloud$/m);
    expect(body).toMatch(/\*\*Status:\*\* Accepted/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(
      /\*\*Tier:\*\* Architectural \(approved deviation; vendor \/ structural\)/,
    );
    expect(body).toMatch(
      /\*\*Related V-entry:\*\* V-051 \(network architecture doc \+ deploy pipeline targeting Hetzner\),/,
    );
    expect(body).toMatch(
      /V-054 \(revocation \+ JWT rotation pinned against Hetzner-side mTLS termination\)\./,
    );
  });

  it("Context — Railway/Fly.io deviation framing pinned: 'Initial planning specced **Railway** or **Fly.io** as the control-plane host' + 'The team reconsidered before Workstream A (hosting integration scaffolding) landed and selected **Hetzner Cloud** (CCX13 VMs, Falkenstein region, Germany) instead. Two CCX13 instances at ~€25/mo each = ~€50/mo total for staging + production' — pinned so the Railway/Fly.io-initial-spec + Workstream-A-reconsidered + CCX13-Falkenstein-Germany + €25-each-€50-total-staging+production commitment survives", () => {
    expect(body).toMatch(/Initial planning specced \*\*Railway\*\* or \*\*Fly\.io\*\* as the/);
    expect(body).toMatch(/control-plane/);
    expect(body).toMatch(
      /The team reconsidered before Workstream A \(hosting integration\s*\n?scaffolding\) landed and selected \*\*Hetzner Cloud\*\* \(CCX13 VMs,/,
    );
    expect(body).toMatch(/Falkenstein region, Germany\) instead\./);
    expect(body).toMatch(/Two CCX13 instances at ~€25\/mo/);
    expect(body).toMatch(/each = ~€50\/mo total for staging \+ production/);
  });

  it("Constraints — 4-constraint framing pinned: '**GDPR posture.**' + 'Hetzner is a German company; Falkenstein and Nürnberg datacenters are EU jurisdiction.' + '**VM-level control for future build infrastructure.**' + '**Cost predictability at low scale.**' + '**Datastore decoupling.** Postgres → Neon (managed, EU Frankfurt). Redis → Upstash (managed, EU Frankfurt). Object storage → Cloudflare R2 (EU jurisdiction).' — pinned so the GDPR-EU-jurisdiction + Falkenstein/Nürnberg-EU + VM-level-control + flat-cost-predictability + Neon+Upstash+R2-EU-decoupling commitment survives", () => {
    expect(body).toMatch(/- \*\*GDPR posture\.\*\*/);
    expect(body).toMatch(
      /Hetzner is a German company; Falkenstein and Nürnberg datacenters\s*\n?\s*are EU jurisdiction\./,
    );
    expect(body).toMatch(/- \*\*VM-level control for future build infrastructure\.\*\*/);
    expect(body).toMatch(/- \*\*Cost predictability at low scale\.\*\*/);
    expect(body).toMatch(
      /- \*\*Datastore decoupling\.\*\* Postgres → Neon \(managed, EU Frankfurt\)\./,
    );
    expect(body).toMatch(/Redis → Upstash \(managed, EU Frankfurt\)\. Object storage → Cloudflare/);
    expect(body).toMatch(/R2 \(EU jurisdiction\)\./);
  });

  it("Decision — Hetzner CCX13 × 2 + Cloudflare Tunnel + mTLS framing pinned: '## Decision' + '**Host the Driftstack control plane on Hetzner Cloud, two CCX13 VMs (staging + production), Falkenstein region.** Cloudflare Tunnel fronts the VMs for edge HTTPS termination and DDoS protection; the VMs run the control plane container behind loopback-only HTTP; mTLS for the fleet endpoint terminates directly on the Hetzner VM (per V-054 decision 1A — skip Cloudflare API Shield).' + 'Deploy pipeline (`.github/workflows/deploy.yml`, V-051) builds the container image, pushes to GitHub Container Registry (`ghcr.io`), SSHes to Hetzner, runs `docker compose pull && docker compose up -d`, polls `/health`. Production deploy is gated on the `production` GitHub environment's manual-approval policy' — pinned so the CCX13-2-staging-production-Falkenstein + Tunnel-edge-HTTPS-DDoS + loopback-only-HTTP-backend + V-054-1A-skip-Cloudflare-API-Shield + ghcr.io-SSH-docker-compose-/health-poll + production-environment-manual-approval commitment survives", () => {
    expect(body).toMatch(/## Decision/);
    expect(body).toMatch(/\*\*Host the Driftstack control plane on Hetzner Cloud, two CCX13 VMs/);
    expect(body).toMatch(/\(staging \+ production\), Falkenstein region\.\*\*/);
    // V-1088 — the DECISION stands; the fronting mechanism it names does not
    // ship. Annotated rather than rewritten, matching how ADR-002/003/005/006
    // record a record overtaken by the system.
    expect(body).toMatch(/Cloudflare Tunnel fronts/);
    expect(body, 'the not-as-shipped annotation is gone').toMatch(
      /\*\*NOT AS\s*\n?\s*SHIPPED \(V-1088\): no `cloudflared` runs in `infra\/`/,
    );
    expect(body).toMatch(/the VMs for edge HTTPS termination and DDoS protection —/);
    expect(body).toMatch(
      /the VMs run\s*\n?\s*the control plane container behind loopback-only HTTP;/,
    );
    expect(body).toMatch(
      /mTLS for the\s*\n?\s*fleet endpoint terminates directly on the Hetzner VM/,
    );
    expect(body).toMatch(/\(per V-054\s*\n?\s*decision 1A — skip Cloudflare API Shield\)\./);
    expect(body).toMatch(
      /Deploy pipeline \(`\.github\/workflows\/deploy\.yml`, V-051\) builds the/,
    );
    expect(body).toMatch(/container image, pushes to GitHub Container Registry \(`ghcr\.io`\),/);
    expect(body).toMatch(/SSHes to Hetzner, runs `docker compose pull && docker compose up -d`,/);
    expect(body).toMatch(/polls `\/health`\./);
    expect(body).toMatch(/Production deploy is gated on the `production` GitHub/);
    expect(body).toMatch(/environment's manual-approval policy/);
  });

  it("Consequences — Enables + Rules out + Operational load + Cost framing pinned: 'EU-only data residency for control-plane compute' + 'Flat-rate cost predictability (~€50/mo total for staging + production)' + 'Direct mTLS termination on the VM (V-054 decision 1A)' + '**Rules out:**' + 'Zero-touch ops.' + 'Auto-scaling. CCX13 is fixed at 4 vCPU / 16 GB RAM.' + '**Operational load created:**' + 'Founder owns: SSH key rotation, OS patching cadence' + 'Agent owns: container build + deploy automation' — pinned so the EU-residency-no-footnote + flat-€50-predictability + V-054-1A-direct-mTLS + zero-touch-ops-ruled-out + 4-vCPU/16GB-fixed + founder-owns-SSH+OS-patching + agent-owns-container-build commitment survives", () => {
    expect(body).toMatch(/- EU-only data residency for control-plane compute, matching the/);
    expect(body).toMatch(/Flat-rate cost predictability \(~€50\/mo total for staging \+/);
    expect(body).toMatch(/production\) at pre-customer \/ first-customer scale\./);
    expect(body).toMatch(/Direct mTLS termination on the VM \(V-054 decision 1A\)/);
    expect(body).toMatch(/\*\*Rules out:\*\*/);
    expect(body).toMatch(/- Zero-touch ops\. Hetzner Cloud VMs require OS patching,/);
    expect(body).toMatch(/Auto-scaling\. CCX13 is fixed at 4 vCPU \/ 16 GB RAM\./);
    expect(body).toMatch(/\*\*Operational load created:\*\*/);
    expect(body).toMatch(/- Founder owns: SSH key rotation, OS patching cadence/);
    expect(body).toMatch(/- Agent owns: container build \+ deploy automation,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
