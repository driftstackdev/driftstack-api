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
    expect(body).toMatch(/table" backing the per-signal fidelity claims/);
  });

  it("launch-blocker policy framing pinned: 'any drift from the reference phone is a launch-blocking bug' — the load-bearing commitment the page reinforces. Drift would weaken Driftstack's positioning vs Chromium-stealth tools", () => {
    // 2026-09-15 plain-language pass: same commitment, customer words
    // ("engine" / "JavaScript wrapper" were internal framing).
    expect(body).toMatch(
      /a bug that blocks release and fix the underlying browser —\s+we never patch over it/,
    );
    expect(body).toMatch(/we treat\s+it as a bug that blocks release/);
  });

  // ⛔⛔ 2026-09-14 — THIS PIN GUARDED A FALSE CLAIM AND WAS GREEN.
  //
  // The sentence read "the same methodology runs against every archetype in the
  // catalog — {archetypeCount} profiles", and `archetypeCount` rendered 81. That
  // asserts the cumulative rig WAS RUN against 81 archetypes. Measured against
  // artefacts on disk, a comprehensive fork capture exists for 5. The 81 counted
  // archetypes whose five named dimensions are verified — by direct fork
  // verification on some cells and by canvas-cluster membership for the rest,
  // which is a legitimate basis for THAT claim and not for this one.
  //
  // The pin could not see it. It asserted the number was interpolated from
  // DEVICE_SUPPORT rather than typed by hand, and a cross-source test asserted
  // the constant matched a registry length — both true of ANY number, whatever
  // verb sat next to it. Regenerating the registry would have moved it to 99 and
  // made the claim larger, still green.
  //
  // The sentence now gives each number the verb its evidence supports, and this
  // pins that separation rather than the interpolation alone.
  it('full-catalog framing BOUND to DEVICE_SUPPORT, with each count attached to the claim its evidence supports — fork-capture count for "we ran the rig", verified count for the five dimensions (naming the cluster method in the open), selectable count for breadth', () => {
    // The rig-was-run claim is bound to the fork-capture count and to nothing else.
    // 2026-09-15 plain-language pass: "comprehensive fork capture" became
    // "we have run every check on" — the same rigRun-backed claim.
    expect(body).toMatch(
      /one of\s+\{DEVICE_SUPPORT\.forkCaptureCount\} device profiles we have run every\s+check on/,
    );
    // The verification claim is bound to the verified count, and the cluster
    // basis is stated where a customer can weigh it rather than buried
    // ("matched to a directly checked profile that renders the same way" is
    // canvas-cluster membership in customer words).
    expect(body).toMatch(/verified across\s+\{DEVICE_SUPPORT\.verifiedCount\} device profiles/);
    expect(body).toMatch(
      /either checked directly\s+or matched to a directly checked profile that renders the same way/,
    );
    // Breadth is bound to the selectable count.
    expect(body).toMatch(/\{DEVICE_SUPPORT\.selectableCount\} device profiles are\s+selectable/);
    expect(body).toMatch(
      /across \{DEVICE_SUPPORT\.deviceFamilies\}, on iOS\s+\{DEVICE_SUPPORT\.iosVersions\}, Safari \{DEVICE_SUPPORT\.safariVersions\}/,
    );
    // ⛔ The retired claim must not return, in either of its two wrong forms:
    // the curated-subset-as-exhaustive phrasing, and the rig-ran-against-the-
    // whole-catalog phrasing that replaced it.
    expect(body).not.toMatch(/every launch archetype — iPhone/);
    expect(body).not.toMatch(/same methodology runs against every archetype/);
    // And no count may be hand-typed back in beside a verification verb.
    expect(body).not.toMatch(/DEVICE_SUPPORT\.archetypeCount/);
  });

  it('signal-table 10-row sampling (drift to dropping any signal would weaken the cumulative-rig claim that EVERY signal must match the iPhone): userAgent / platform / Canvas 2D / WebGL renderer / AudioContext / Font metrics / JS engine timing / TLS ClientHello / Touch-event / Screen dimensions', () => {
    // 2026-09-15 plain-language pass: every row now leads with a plain label
    // and keeps the API name in parentheses (the row-14 pattern).
    expect(body).toMatch(/Browser identity string \(navigator\.userAgent\)/);
    expect(body).toMatch(/Operating system \(navigator\.platform\)/);
    expect(body).toMatch(/Canvas drawing fingerprint \(Canvas 2D hash\)/);
    expect(body).toMatch(/Graphics engine name \(WebGL renderer\)/);
    expect(body).toMatch(/Audio fingerprint \(AudioContext\)/);
    expect(body).toMatch(/Font measurements \(font metrics\)/);
    expect(body).toMatch(/JavaScript engine timing/);
    expect(body).toMatch(/Encrypted-connection handshake \(TLS ClientHello\)/);
    expect(body).toMatch(/Touch support \(touch-event flag\)/);
    expect(body).toMatch(/Screen size and pixel density \(DPR\)/); // S20c 2026-07-06: DPR glossed
  });

  it("population-stable-vs-unique-per-session contrast pinned: the load-bearing visual signal (Driftstack = population-stable, stealth Chromium = unique-per-session). Drift would weaken the cumulative-rig argument that Driftstack 'returns the same value as millions of other iPhones'", () => {
    // 2026-09-15 plain words: "Skia" / "Core Graphics" / "population-
    // stable" were engine names; the contrast (unique per session vs
    // the value a real iPhone gives) is unchanged. The canvas cell says
    // "same as a real iPhone" rather than "stable" on purpose: Safari
    // varies canvas/audio output between sessions by design.
    expect(body).toMatch(/<td class="px-4 py-3 text-tk-ink-3">unique-per-session<\/td>/);
    expect(body).toMatch(/same as a real iPhone \(Apple's own drawing code\)/);
    expect(body).toMatch(/stable, like a real iPhone/);
    expect(body).not.toMatch(/population-stable|Core Graphics|\(Skia\)/);
    expect(body).toMatch(/returns the same\s+value as millions of other iPhones/);
  });

  it("'any single signal is easy' framing pinned: drift to dropping would let competitors-with-broader-stealth claim parity even though they can't match the cumulative rig", () => {
    expect(body).toMatch(/Any single signal is easy\. Every signal at once is the hard part\./);
  });
});
