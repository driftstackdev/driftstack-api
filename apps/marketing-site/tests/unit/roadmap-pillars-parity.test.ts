// W262.A — drift-guard for /roadmap page. Pins:
// 1. Locked-archetype label matches LOCKED_ARCHETYPE_ID (no fictional "iOS 26.4" claim).
// 2. NOW / NEXT / LATER buckets each contain at least one item.
// 3. AI-agent and live-streaming items remain LATER (roadmap, not live).
// 4. SDK trio (TS / Python / Go) is in NOW per the live package state.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W262.A /roadmap ↔ live LOCKED_ARCHETYPE_ID + roadmap framing parity', () => {
  const page = read(PAGE);

  it('LOCKED_ARCHETYPE_ID slug iphone17_ios18_7_safari26_4 is in the schema', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone17_ios18_7_safari26_4');
  });

  it('roadmap names the live iOS 18.6 / 18.7 + Safari 18.6–26.5 span, not the legacy "iOS 26.4"', () => {
    // The launch catalog spans iOS 18.6 / 18.7 and Safari 18.6
    // through 26.5; the live LOCKED_ARCHETYPE_ID combo
    // (iphone17_ios18_7_safari26_4) sits inside that span. The
    // roadmap names the iOS + Safari versioning correctly rather
    // than the legacy conflated "iOS 26.4".
    expect(page).toMatch(/iOS 18\.6 \/ 18\.7/);
    expect(page).toMatch(/Safari 18\.6/);
    expect(page).toMatch(/26\.5/);
    // The legacy mistake conflated iOS and Safari versions.
    expect(page).not.toMatch(/iOS 26\.4/);
  });

  it('NOW bucket includes the SDK trio + Webhook delivery + dashboard rows', () => {
    const nowStart = page.indexOf('const NOW: RoadmapItem[]');
    const nextStart = page.indexOf('const NEXT: RoadmapItem[]');
    expect(nowStart).toBeGreaterThan(-1);
    expect(nextStart).toBeGreaterThan(nowStart);
    const now = page.slice(nowStart, nextStart);
    expect(now).toMatch(/TypeScript.*Python.*Go SDK/s);
    expect(now).toMatch(/Webhook delivery/);
    expect(now).toMatch(/Customer dashboard at app\.driftstack\.dev/);
  });

  it('AI agent layer is in NOW (promoted to v1.0 per 2026-05-17 founder Tier-3 verdict)', () => {
    // Founder verdict: AI chat + manual live feature APPROVED for
    // v1.0 (primary differentiator). The "AI agent layer" entry
    // moved from LATER → NOW and was renamed to "Agent sessions
    // — natural-language automation with AI / manual / pair modes"
    // (the canonical title in the current page).
    const nowStart = page.indexOf('const NOW: RoadmapItem[]');
    const nextStart = page.indexOf('const NEXT: RoadmapItem[]');
    expect(nowStart).toBeGreaterThan(-1);
    const now = page.slice(nowStart, nextStart);
    expect(now).toMatch(/Agent sessions.*AI \/ manual \/ pair modes/);
    const laterStart = page.indexOf('const LATER: RoadmapItem[]');
    const close = page.indexOf('];', laterStart);
    const later = page.slice(laterStart, close);
    // Old "AI agent layer" framing is gone from LATER.
    expect(later).not.toMatch(/AI agent layer/);
  });

  it('live-session WebRTC stream is in NEXT (not NOW)', () => {
    const nowStart = page.indexOf('const NOW: RoadmapItem[]');
    const nextStart = page.indexOf('const NEXT: RoadmapItem[]');
    const laterStart = page.indexOf('const LATER: RoadmapItem[]');
    const now = page.slice(nowStart, nextStart);
    const next = page.slice(nextStart, laterStart);
    expect(next).toMatch(/Live session WebRTC stream/);
    expect(now).not.toMatch(/Live session WebRTC stream/);
  });

  it('NOW / NEXT / LATER framing matches the live constant-bucket naming', () => {
    expect(page).toMatch(/const NOW: RoadmapItem\[\]/);
    expect(page).toMatch(/const NEXT: RoadmapItem\[\]/);
    expect(page).toMatch(/const LATER: RoadmapItem\[\]/);
  });
});
