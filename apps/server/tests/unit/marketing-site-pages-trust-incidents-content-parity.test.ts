// W503.C — drift guard for apps/marketing-site/src/pages/trust/incidents.astro.
// V-477 public incident history and disclosure policy. Drift here
// either softens the incident-SLA
// commitment (24h impact summary / 7-day root-cause + remediation)
// or breaks the 'every customer-impacting event gets a public entry'
// posture that customers buy on.
//
//   • V-477 current-policy doc-comment framing.
//   • Incident interface 9-field shape + 3-state severity:
//     major_outage / degraded / security.
//   • INCIDENTS empty-list framing: 'No incidents to date'.
//   • severityLabel / severityClass 3-state maps.
//   • 4-card 'What we publish' scope: Customer-impacting downtime +
//     Security events + Sub-processor incidents + Maintenance windows.
//   • Empty-list panel: 'No customer-impacting incidents to date.'
//   • CTA: live status page + dashboard notification preferences.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/incidents.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W503.C apps/marketing-site/src/pages/trust/incidents.astro content parity', () => {
  const body = read(LIB);

  it('V-477 incident-history framing pins the current disclosure policy without roadmap language', () => {
    expect(body).toMatch(/\/\/ V-477 — public incident history and disclosure policy\./);
    expect(body).not.toMatch(/pre-launch|each future incident/i);
  });

  it("Incident interface 9-field shape: date + title + severity + customer_impact + duration + components + status + summary + optional root_cause + optional remediation — pinned so the per-incident disclosure surface stays consistent (drift to dropping 'root_cause' or 'remediation' would let incident entries skip the post-mortem fields V-477 commits to; drift to dropping 'customer_impact' would lose the buyer-readable impact signal)", () => {
    expect(body).toMatch(
      /interface Incident \{\s*date: string;\s*title: string;\s*severity: 'major_outage' \| 'degraded' \| 'security';\s*customer_impact: string;\s*duration: string;\s*components: string\[\];\s*status: 'resolved' \| 'monitoring' \| 'investigating';\s*summary: string;\s*root_cause\?: string;\s*remediation\?: string;\s*\}/,
    );
  });

  it("Pre-launch empty incidents array pinned: 'const INCIDENTS: Incident[] = [' + '// No incidents to date.' — pinned so the explicit empty-state-by-design framing survives (drift to seeding fake incidents would mislead buyers about the platform's incident history; drift to dropping the 'No incidents to date' comment would let the array look unintentionally empty)", () => {
    expect(body).toMatch(/const INCIDENTS: Incident\[\] = \[\s*\/\/ No incidents to date\.\s*\];/);
  });

  it("severityLabel 3-state map: major_outage → 'Major outage' / degraded → 'Degraded' / security → 'Security' — pinned so the 3-severity taxonomy stays consistent (drift to merging 'degraded' into 'major_outage' would lose the partial-degradation signal customers use to assess scope; drift to dropping 'security' would lose the breach-vs-availability distinction)", () => {
    expect(body).toMatch(/case 'major_outage':\s*return 'Major outage';/);
    expect(body).toMatch(/case 'degraded':\s*return 'Degraded';/);
    expect(body).toMatch(/case 'security':\s*return 'Security';/);
  });

  it('severityClass 3-state color map: major_outage → red / degraded → amber / security → purple — pinned so the at-a-glance severity-color semantic (red=outage, amber=degraded, purple=security) stays consistent (drift would break the customer scan-pattern for severity)', () => {
    expect(body).toMatch(/case 'major_outage':\s*return 'bg-red-100 text-red-800';/);
    expect(body).toMatch(/case 'degraded':\s*return 'bg-amber-100 text-amber-800';/);
    expect(body).toMatch(/case 'security':\s*return 'bg-purple-100 text-purple-800';/);
  });

  it("Hero framing pinned: 'Every customer-impacting outage or security event gets a public entry below — including ones short enough that customers might not notice. Root cause and remediation are added within seven days of the incident closing.' — pinned so the 'even-short-incidents-published' + 7-day-post-mortem commitments survive (drift to dropping 'including ones short enough that customers might not notice' would let small outages skip publication; drift to dropping the 7-day window would let post-mortems slip without a tracked window)", () => {
    expect(body).toMatch(
      /Every customer-impacting outage or security event gets a public\s*entry below — including ones short enough that customers might\s*not notice\. Root cause and remediation are added within seven\s*days of the incident closing\./,
    );
  });

  it("4-card 'What we publish' scope: Customer-impacting downtime + Security events + Sub-processor incidents + Maintenance windows — pinned so the 4-scope publication commitment survives (drift to dropping 'Sub-processor incidents' would let upstream Hetzner/Neon/etc outages skip publication; drift to dropping 'Maintenance windows' would let pre-announced changes go un-noticed)", () => {
    expect(body).toMatch(/Customer-impacting downtime/);
    expect(body).toMatch(/Security events/);
    expect(body).toMatch(/Sub-processor incidents/);
    expect(body).toMatch(/Maintenance windows/);
  });

  it("Sub-processor incident framing pinned: 'When an upstream sub-processor (Hetzner / Neon / Upstash / Cloudflare / Postmark / Stripe / Sentry) has an incident affecting our customers, we summarise their post-mortem and link the upstream report.' — pinned so the 7-sub-processor scope (Hetzner/Neon/Upstash/Cloudflare/Postmark/Stripe/Sentry) + the summarise-and-link commitment survive (drift to dropping a sub-processor from the list would leave its incidents unhandled by the published policy)", () => {
    expect(body).toMatch(
      /When an upstream sub-processor \(Hetzner \/ Neon \/ Upstash \/\s*Cloudflare \/ Postmark \/ Stripe \/ Sentry\) has an incident\s*affecting our customers, we summarise their post-mortem and\s*link the upstream report\./,
    );
  });

  it("Maintenance windows framing pinned: 'Pre-announced windows for migrations, schema changes, or certificate rotations. Notice at least 72 hours in advance' — pinned so the 72-hour-advance-notice commitment + the 3-state maintenance scope (migrations/schema-changes/cert-rotations) survive (drift to dropping the 72h window would let maintenance land without customer warning; drift to dropping cert-rotations would orphan TLS-renewal windows from the policy)", () => {
    expect(body).toMatch(
      /Pre-announced windows for planned work — database upgrades\s+or restructuring \(migrations, schema changes\) and\s+security-certificate renewals \(certificate rotations\)\.\s+Notice at least 72 hours in advance/, // S20c 2026-07-06: same 3-state scope + 72h notice, plain words lead
    );
  });

  it("Empty-list panel pinned: 'No customer-impacting incidents to date.' + current-history and live-status framing", () => {
    expect(body).toMatch(/No customer-impacting incidents to date\./);
    expect(body).toMatch(
      /No incidents are recorded in the public history\. The live\s+platform status above reflects the current moment\./,
    );
    expect(body).not.toMatch(/first paying customer|before launch/i);
  });

  it("StatusBadge import + render pinned — pinned so the live-platform-status visual signal stays in the hero (drift to dropping would lose the at-a-glance 'is platform up right now' signal that's distinct from the historical-incident-list below)", () => {
    expect(body).toMatch(/import StatusBadge from '\.\.\/\.\.\/components\/StatusBadge\.astro';/);
    expect(body).toMatch(/<StatusBadge \/>/);
  });

  it('Subscribe CTA pins the live status page and dashboard notification preferences', () => {
    expect(body).toMatch(/title="Get notified when status changes\."/);
    expect(body).toMatch(
      /lead="Subscribe by email from the status page, or manage account notification preferences from the dashboard\."/,
    );
    expect(body).toMatch(
      /primaryHref="https:\/\/status\.driftstack\.io"\s*primaryLabel="Open status page"/,
    );
    expect(body).toMatch(
      /secondaryHref="https:\/\/app\.driftstack\.io\/settings\/"\s*secondaryLabel="Manage notifications"/,
    );
    expect(body).not.toMatch(/future updates|future-status/i);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
