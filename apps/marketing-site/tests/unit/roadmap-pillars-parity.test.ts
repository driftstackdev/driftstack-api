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

  it('LOCKED_ARCHETYPE_ID slug iphone16pro_ios18_7_safari26_4 is in the schema', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone16pro_ios18_7_safari26_4');
  });

  it('roadmap names the live iOS 18.7 / Safari 26.4 combo, not the legacy "iOS 26.4"', () => {
    expect(page).toMatch(/iOS 18\.7/);
    expect(page).toMatch(/Safari 26\.4/);
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

  it('AI agent layer is in LATER, not NOW', () => {
    const laterStart = page.indexOf('const LATER: RoadmapItem[]');
    const close = page.indexOf('];', laterStart);
    expect(laterStart).toBeGreaterThan(-1);
    const later = page.slice(laterStart, close);
    expect(later).toMatch(/AI agent layer/);
    const nowEnd = page.indexOf('const NEXT: RoadmapItem[]');
    const now = page.slice(0, nowEnd);
    expect(now).not.toMatch(/AI agent layer/);
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
