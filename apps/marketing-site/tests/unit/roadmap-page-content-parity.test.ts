// W369.A — drift guard for marketing-site /roadmap page content.
// V-473. Existing roadmap-baseline + roadmap-pillars-parity +
// roadmap-structure-baseline tests pin shape; this guard pins
// the canonical 10 / 3 / 5 item ladder and the no-dates posture:
//
//   • 3 buckets present: Now / Next / Later (in order).
//   • Each bucket has the expected item count: Now=10, Next=3,
//     Later=5. A future drop/add should be a deliberate decision.
//     (Ladder was reshuffled 2026-05-17 founder Tier-3 verdicts:
//     status-page + OAuth + key-rotation + recipe-library +
//     agent-sessions promoted from NEXT to NOW; AI-agent renamed
//     to "Agent sessions" + promoted from LATER to NOW per
//     AI-chat-+-manual-live-feature-APPROVED-for-v1.0 verdict.)
//   • No-dates / ordering-only framing pinned ("We don't publish
//     dates; we publish ordering"). Falsifiable commitment.
//   • Internal V-NNN tags are NOT exposed publicly — the page
//     comment commits to "intentionally NOT exposed (they rotate
//     fast and would confuse customers)". A future leak surfaces
//     in this test.
//   • Each "Now" item is a published surface today — pin so a
//     future "we shipped 4 of these" softening can't slip in.
//   • Item titles pinned for each bucket (verbatim).
//   • "Email us — concrete demand reorders the deck" customer-
//     prioritization affordance pinned.
//   • S18 (2026-07-04): the fingerprint-parity title interpolates
//     DEVICE_SUPPORT (src/data/capabilities.ts, derived from the
//     api-types ARCHETYPE_REGISTRY). The template source is pinned
//     AND rendered here against the canonical claim string, and the
//     literal body/LATER spans are cross-checked against
//     DEVICE_SUPPORT so registry drift fails this test instead of
//     silently diverging from the prose.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVICE_SUPPORT } from '../../src/data/capabilities.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractList(src: string, name: 'NOW' | 'NEXT' | 'LATER'): string[] {
  const m = src.match(new RegExp(`const ${name}: RoadmapItem\\[\\] = \\[([\\s\\S]*?)\\];`));
  if (m === null) throw new Error(`${name} list not found`);
  // Titles are single-quoted literals or (S18) backtick templates
  // interpolating DEVICE_SUPPORT; templates are rendered with the
  // real imported values so the pinned list stays the CLAIM text.
  return Array.from(m[1]!.matchAll(/title: (?:'([^']+)'|`([^`]+)`)/g)).map((mm) => {
    const raw = (mm[1] ?? mm[2]) as string;
    return raw.replace(/\$\{DEVICE_SUPPORT\.(\w+)\}/g, (_, field: string) =>
      String(DEVICE_SUPPORT[field as keyof typeof DEVICE_SUPPORT]),
    );
  });
}

describe('W369.A marketing-site /roadmap page content parity', () => {
  const body = read(PAGE);

  it('3 buckets present in order: Now / Next / Later', () => {
    const now = body.indexOf('const NOW: RoadmapItem[]');
    const next = body.indexOf('const NEXT: RoadmapItem[]');
    const later = body.indexOf('const LATER: RoadmapItem[]');
    expect(now).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(now);
    expect(later).toBeGreaterThan(next);
  });

  it('Now bucket has exactly 10 items (canonical foundation + promoted-from-NEXT v1.0 surface)', () => {
    const titles = extractList(body, 'NOW');
    expect(titles.length).toBe(10);
    // Each title pinned verbatim (templates rendered via DEVICE_SUPPORT).
    expect(titles).toEqual([
      'iPhone family fingerprint parity (81 profiles, iPhone 13 → 17 Pro Max)',
      'TypeScript · Python · Go SDKs',
      'Customer dashboard at app.driftstack.dev',
      'Webhook delivery infrastructure',
      'GUI client for human operators',
      'Public status page',
      'OAuth signup (Google · GitHub)',
      'API key rotation with grace window',
      'Recipe library (capture + manage at v1.0)',
      'Agent sessions — natural-language automation with AI / manual / pair modes',
    ]);
  });

  it('S18 fingerprint-parity title is BOUND to DEVICE_SUPPORT (template source pinned; the page imports the fact registry)', () => {
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/data\/capabilities\.ts';/);
    expect(body).toMatch(
      /title: `iPhone family fingerprint parity \(\$\{DEVICE_SUPPORT\.archetypeCount\} profiles, \$\{DEVICE_SUPPORT\.deviceFamilies\}\)`,/,
    );
  });

  it('S18 cross-source invariant: the literal device-catalog prose (NOW body + LATER parenthetical) matches DEVICE_SUPPORT — registry drift must fail here, not silently strand the copy', () => {
    // NOW body keeps the span as literal prose (W317.B / W297.A /
    // W262.A pin those fragments in source); bind each fragment to
    // the registry-derived fact registry.
    expect(body).toContain(`across ${DEVICE_SUPPORT.archetypeCount} device profiles`);
    expect(body).toContain(`on iOS ${DEVICE_SUPPORT.iosVersions} and Safari 18.6 through 26.5`);
    expect(body).toContain(
      `The ${DEVICE_SUPPORT.archetypeCount}-profile ${DEVICE_SUPPORT.deviceFamilies} catalog (iOS ${DEVICE_SUPPORT.iosVersions}, Safari ${DEVICE_SUPPORT.safariVersions})`,
    );
    // Sanity: the Safari span endpoints of the prose match the registry span.
    expect(DEVICE_SUPPORT.safariVersions).toBe('18.6–26.5');
  });

  it('Next bucket has exactly 3 items (active engineering)', () => {
    const titles = extractList(body, 'NEXT');
    expect(titles.length).toBe(3);
    for (const t of [
      'Account deletion (GDPR Article 17)',
      'Live session WebRTC stream',
      'Workflow recording',
    ]) {
      expect(titles, `Next item missing: ${t}`).toContain(t);
    }
  });

  it('Later bucket has exactly 5 items (on the deck — AI-agent promoted to NOW as "Agent sessions")', () => {
    const titles = extractList(body, 'LATER');
    expect(titles.length).toBe(5);
    for (const t of [
      'Older iOS archetypes (iPhone 12 + earlier)',
      'Android Chrome archetypes',
      'Hardware-key MFA (WebAuthn)',
      'Public benchmark page',
      'Self-hosted parity polish',
    ]) {
      expect(titles, `Later item missing: ${t}`).toContain(t);
    }
  });

  it('no-dates / ordering-only framing pinned ("We don\'t publish dates; we publish ordering")', () => {
    expect(body).toMatch(/We don't publish dates; we publish ordering/);
  });

  it('V-473 internal-V-NNN-not-exposed posture pinned (page comment)', () => {
    expect(body).toMatch(
      /internal V-NNN tags are intentionally NOT exposed \(they\s*\n?\s*\/\/\s*rotate fast and would confuse customers\)/,
    );
    // Negative — no V-XXX tag should appear in the rendered body.
    // The page comment + V-473 in the frontmatter is OK; the
    // rendered ULs should not leak any V-NNN tokens.
    const renderedSection = body.slice(body.indexOf('<BaseLayout'));
    expect(renderedSection).not.toMatch(/V-\d{3,}/);
  });

  it('customer-prioritization affordance pinned (mailto:support — concrete demand reorders the deck)', () => {
    expect(body).toMatch(/concrete demand reorders the deck/);
    expect(body).toContain('mailto:support@driftstack.dev');
    expect(body).toMatch(/Tell us what would unlock your workload/);
  });

  it('5-minute timestamp tolerance webhook claim aligns with /security V-359 contract', () => {
    // S20c 2026-07-06 plain-language pass: same HMAC-SHA256 + 5-minute
    // tolerance facts, plain words lead.
    expect(body).toMatch(
      /cryptographically signed \(HMAC-SHA256\)[^']{0,80}5-minute clock-difference allowance \(timestamp tolerance\)/,
    );
  });

  it('free-tier CTA cross-link points at /pricing#free (consistent with /about + /comparison)', () => {
    expect(body).toMatch(/href="\/pricing\/#free"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('hero title pinned: "What\'s live, next, and further out."', () => {
    expect(body).toMatch(/What's live, next, and further out\./);
  });
});
