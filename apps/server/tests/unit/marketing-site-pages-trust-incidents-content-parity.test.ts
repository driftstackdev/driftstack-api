// W503.C — drift guard for apps/marketing-site/src/pages/trust/incidents.astro.
// V-477 public incident history — pre-launch the list is empty; the
// page documents the framework so customers know what to expect when
// an incident does land. Drift here either softens the incident-SLA
// commitment (24h impact summary / 7-day root-cause + remediation)
// or breaks the 'every customer-impacting event gets a public entry'
// posture that customers buy on.
//
//   • V-477 doc-comment framing + 24h/7d SLA.
//   • Incident interface 9-field shape + 3-state severity:
//     major_outage / degraded / security.
//   • INCIDENTS empty-list framing: 'No incidents to date' as honest
//     pre-launch signal.
//   • severityLabel / severityClass 3-state maps.
//   • 4-card 'What we publish' scope: Customer-impacting downtime +
//     Security events + Sub-processor incidents + Maintenance windows.
//   • Empty-list panel: 'No customer-impacting incidents to date.'
//   • CTA: notification subscription + status.driftstack.dev future.

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

  it("V-477 incident-history framing pinned: 'public incident history. Pre-launch the list is empty; the page documents the framework so customers know what to expect when an incident does land. Each future incident gets an entry here within the SLA window (24h impact summary, 7 days root-cause + remediation).' — pinned so the V-477 doc-comment + the 'pre-launch empty by design' + the 24h/7d SLA commitments all survive (drift to softening the 24h/7d window would let post-mortem timing slip without a code-tracked signal)", () => {
    expect(body).toMatch(
      /\/\/ V-477 — public incident history\. Pre-launch the list is empty;\s*\n?\s*\/\/ the page documents the framework so customers know what to expect\s*\n?\s*\/\/ when an incident does land\. Each future incident gets an entry\s*\n?\s*\/\/ here within the SLA window \(24h impact summary, 7 days root-cause\s*\n?\s*\/\/ \+ remediation\)\./,
    );
  });

  it("Incident interface 9-field shape: date + title + severity + customer_impact + duration + components + status + summary + optional root_cause + optional remediation — pinned so the per-incident disclosure surface stays consistent (drift to dropping 'root_cause' or 'remediation' would let incident entries skip the post-mortem fields V-477 commits to; drift to dropping 'customer_impact' would lose the buyer-readable impact signal)", () => {
    expect(body).toMatch(
      /interface Incident \{\s*\n?\s*date: string;\s*\n?\s*title: string;\s*\n?\s*severity: 'major_outage' \| 'degraded' \| 'security';\s*\n?\s*customer_impact: string;\s*\n?\s*duration: string;\s*\n?\s*components: string\[\];\s*\n?\s*status: 'resolved' \| 'monitoring' \| 'investigating';\s*\n?\s*summary: string;\s*\n?\s*root_cause\?: string;\s*\n?\s*remediation\?: string;\s*\n?\s*\}/,
    );
  });

  it("Pre-launch empty incidents array pinned: 'const INCIDENTS: Incident[] = [' + '// No incidents to date.' — pinned so the explicit empty-state-by-design framing survives (drift to seeding fake incidents would mislead buyers about the platform's incident history; drift to dropping the 'No incidents to date' comment would let the array look unintentionally empty)", () => {
    expect(body).toMatch(
      /const INCIDENTS: Incident\[\] = \[\s*\n?\s*\/\/ No incidents to date\.\s*\n?\s*\];/,
    );
  });

  it("severityLabel 3-state map: major_outage → 'Major outage' / degraded → 'Degraded' / security → 'Security' — pinned so the 3-severity taxonomy stays consistent (drift to merging 'degraded' into 'major_outage' would lose the partial-degradation signal customers use to assess scope; drift to dropping 'security' would lose the breach-vs-availability distinction)", () => {
    expect(body).toMatch(/case 'major_outage':\s*\n?\s*return 'Major outage';/);
    expect(body).toMatch(/case 'degraded':\s*\n?\s*return 'Degraded';/);
    expect(body).toMatch(/case 'security':\s*\n?\s*return 'Security';/);
  });

  it('severityClass 3-state color map: major_outage → red / degraded → amber / security → purple — pinned so the at-a-glance severity-color semantic (red=outage, amber=degraded, purple=security) stays consistent (drift would break the customer scan-pattern for severity)', () => {
    expect(body).toMatch(/case 'major_outage':\s*\n?\s*return 'bg-red-100 text-red-800';/);
    expect(body).toMatch(/case 'degraded':\s*\n?\s*return 'bg-amber-100 text-amber-800';/);
    expect(body).toMatch(/case 'security':\s*\n?\s*return 'bg-purple-100 text-purple-800';/);
  });

  it("Hero framing pinned: 'Every customer-impacting outage or security event gets a public entry below — including ones short enough that customers might not notice. Root cause and remediation are added within seven days of the incident closing.' — pinned so the 'even-short-incidents-published' + 7-day-post-mortem commitments survive (drift to dropping 'including ones short enough that customers might not notice' would let small outages skip publication; drift to dropping the 7-day window would let post-mortems slip without a tracked window)", () => {
    expect(body).toMatch(
      /Every customer-impacting outage or security event gets a public\s*\n?\s*entry below — including ones short enough that customers might\s*\n?\s*not notice\. Root cause and remediation are added within seven\s*\n?\s*days of the incident closing\./,
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
      /When an upstream sub-processor \(Hetzner \/ Neon \/ Upstash \/\s*\n?\s*Cloudflare \/ Postmark \/ Stripe \/ Sentry\) has an incident\s*\n?\s*affecting our customers, we summarise their post-mortem and\s*\n?\s*link the upstream report\./,
    );
  });

  it("Maintenance windows framing pinned: 'Pre-announced windows for migrations, schema changes, or certificate rotations. Notice at least 72 hours in advance' — pinned so the 72-hour-advance-notice commitment + the 3-state maintenance scope (migrations/schema-changes/cert-rotations) survive (drift to dropping the 72h window would let maintenance land without customer warning; drift to dropping cert-rotations would orphan TLS-renewal windows from the policy)", () => {
    expect(body).toMatch(
      /Pre-announced windows for planned work — database upgrades\s+or restructuring \(migrations, schema changes\) and\s+security-certificate renewals \(certificate rotations\)\.\s+Notice at least 72 hours in advance/, // S20c 2026-07-06: same 3-state scope + 72h notice, plain words lead
    );
  });

  it("Empty-list panel pinned: 'No customer-impacting incidents to date.' + 'We've kept this list honest by entering it pre-launch — every incident from the first paying customer onward will land here.' — pinned so the empty-state honest-framing (it's empty because nothing happened, not because we're hiding) survives (drift to dropping 'kept this list honest by entering it pre-launch' would let the empty state read as suspicious rather than intentional)", () => {
    expect(body).toMatch(/No customer-impacting incidents to date\./);
    expect(body).toMatch(
      // S20c 2026-07-06: same empty-because-nothing-happened framing, plain words lead.
      /This list started before launch, so it can't quietly omit\s+anything — every\s+incident from the first paying customer onward will land here\./,
    );
  });

  it("StatusBadge import + render pinned — pinned so the live-platform-status visual signal stays in the hero (drift to dropping would lose the at-a-glance 'is platform up right now' signal that's distinct from the historical-incident-list below)", () => {
    expect(body).toMatch(/import StatusBadge from '\.\.\/\.\.\/components\/StatusBadge\.astro';/);
    expect(body).toMatch(/<StatusBadge \/>/);
  });

  it("Subscribe CTA pinned: 'Get notified when status changes.' + 'Future updates: status.driftstack.dev with email + RSS subscription.' + Manage notifications → app.driftstack.dev/settings + 'Back to trust center' → /trust — pinned so the email-subscription-now + future-status.driftstack.dev + RSS planning + dual-CTA navigation all survive (drift to dropping the future status.driftstack.dev mention would orphan the roadmap commitment; drift to dropping 'Back to trust center' would break the hub-and-spoke navigation). Fleet v2 (S10): the hand-rolled CTA section became a <CtaBand> — both anchors render from the primary/secondary props, so the pins match the prop forms", () => {
    expect(body).toMatch(/title="Get notified when status changes\."/);
    expect(body).toMatch(
      /Future updates: status\.driftstack\.dev with\s*\n?\s*email \+ RSS subscription\./,
    );
    expect(body).toMatch(
      /primaryHref="https:\/\/app\.driftstack\.dev\/settings\/"\s*\n?\s*primaryLabel="Manage notifications"/,
    );
    expect(body).toMatch(/secondaryHref="\/trust\/"\s*\n?\s*secondaryLabel="Back to trust center"/);
    expect(body).not.toContain('primaryHref="https://app.driftstack.dev/settings"');
    expect(body).not.toContain('secondaryHref="/trust"');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
