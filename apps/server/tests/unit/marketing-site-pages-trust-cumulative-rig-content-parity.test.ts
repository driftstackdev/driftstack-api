// Drift guard for apps/marketing-site/src/pages/trust/cumulative-
// rig.astro. Pins the V-668 doc-comment framing + the signal-by-
// signal table + the launch-blocker policy + the population-stable
// vs unique-per-session contrast.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/cumulative-rig.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('marketing-site trust/cumulative-rig content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("V-668 doc-comment framing pinned: 'Cumulative rig methodology page. The homepage repeatedly references /trust/cumulative-rig as the full signal-by-signal table backing the Indistinguishable claim'. Drift to dropping V-668 would orphan the homepage's repeated references", () => {
    expect(body).toMatch(/\/\/ V-668 — Cumulative rig methodology page\. The homepage repeatedly/);
    expect(body).toMatch(/references \/trust\/cumulative-rig as "the full signal-by-signal/);
    expect(body).toMatch(/table" backing the Indistinguishable claim/);
  });

  it("launch-blocker policy framing pinned: 'any drift from the reference phone is a launch-blocking bug' — the load-bearing commitment the page reinforces. Drift would weaken Driftstack's positioning vs Chromium-stealth tools", () => {
    expect(body).toMatch(
      /launch-blocking bug and fix the engine — not a JavaScript\s+wrapper over it/,
    );
    expect(body).toMatch(/we treat it as a/);
  });

  it('M.6 multi-archetype framing pinned: iPhone 15 Pro + 16 Pro + 17 lineup on iOS 18.7 / Safari 26.4 + 26.5. Drift to single-archetype framing would re-introduce the v1.0 scope mismatch slice 121 already corrected on roadmap.astro', () => {
    expect(body).toMatch(/iPhone\s*\n?\s*15 Pro, iPhone 16 Pro, and the current iPhone 17 lineup/);
    expect(body).toMatch(/iOS 18\.7 \/ Safari 26\.4 and Safari 26\.5/);
  });

  it('signal-table 10-row sampling (drift to dropping any signal would weaken the cumulative-rig claim that EVERY signal must match the iPhone): userAgent / platform / Canvas 2D / WebGL renderer / AudioContext / Font metrics / JS engine timing / TLS ClientHello / Touch-event / Screen dimensions', () => {
    expect(body).toMatch(/navigator\.userAgent/);
    expect(body).toMatch(/navigator\.platform/);
    expect(body).toMatch(/Canvas 2D hash/);
    expect(body).toMatch(/WebGL renderer/);
    expect(body).toMatch(/AudioContext fingerprint/);
    expect(body).toMatch(/Font metric outputs/);
    expect(body).toMatch(/JavaScript engine timing/);
    expect(body).toMatch(/TLS ClientHello fingerprint/);
    expect(body).toMatch(/Touch-event support flag/);
    expect(body).toMatch(/Screen dimensions \+ DPR/);
  });

  it("population-stable-vs-unique-per-session contrast pinned: the load-bearing visual signal (Driftstack = population-stable, stealth Chromium = unique-per-session). Drift would weaken the cumulative-rig argument that Driftstack 'returns the same value as millions of other iPhones'", () => {
    expect(body).toMatch(/unique-per-session \(Skia\)/);
    expect(body).toMatch(/population-stable \(Core Graphics\)/);
    expect(body).toMatch(/returns the same\s+value as millions of other iPhones/);
  });

  it("'any single signal is easy' framing pinned: drift to dropping would let competitors-with-broader-stealth claim parity even though they can't match the cumulative rig", () => {
    expect(body).toMatch(/Any single signal is easy\. Every signal at once is the hard part\./);
  });
});
