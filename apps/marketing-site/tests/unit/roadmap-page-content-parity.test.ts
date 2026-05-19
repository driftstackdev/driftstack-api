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

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractList(src: string, name: 'NOW' | 'NEXT' | 'LATER'): string[] {
  const m = src.match(new RegExp(`const ${name}: RoadmapItem\\[\\] = \\[([\\s\\S]*?)\\];`));
  if (m === null) throw new Error(`${name} list not found`);
  return Array.from(m[1]!.matchAll(/title: '([^']+)'/g)).map((mm) => mm[1] as string);
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
    // Each title pinned verbatim.
    expect(titles).toEqual([
      'iPhone family fingerprint parity (15 Pro · 16 Pro · 17 lineup)',
      'TypeScript · Python · Go SDKs',
      'Customer dashboard at app.driftstack.dev',
      'Webhook delivery infrastructure',
      'GUI client for human operators',
      'Public status page',
      'OAuth signup (Google · GitHub)',
      'API key rotation with grace window',
      'Recipe library (write-only at v1.0)',
      'Agent sessions — natural-language automation with AI / manual / pair modes',
    ]);
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
      'Older iOS archetypes (iPhone 14 + earlier iOS)',
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
    expect(body).toMatch(/HMAC-SHA256-signed events with 5-minute timestamp tolerance/);
  });

  it('trial-pack CTA cross-link points at /pricing#trial-pack (consistent with /about + /comparison)', () => {
    expect(body).toMatch(/href="\/pricing#trial-pack"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('hero title pinned: "What\'s live, next, and further out."', () => {
    expect(body).toMatch(/What's live, next, and further out\./);
  });
});
