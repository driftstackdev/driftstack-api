// W451.C — drift guard for packages/behavioural-simulation/src/mock.ts.
// V-127 MockBehaviouralSimulator. Drift here either drops the
// deterministic seed contract (test snapshots flake on identical
// inputs producing different outputs) or breaks the
// generateTouchEvent + generateScrollVelocityProfile re-use of the
// pure deterministic real implementations (introducing a parity
// gap where the mock returns different data than what production
// would emit, so consumer tests pass under mock but fail under
// Phase 3 real generator).
//
//   • V-127 framing pinned: 'Deterministic outputs so tests can
//     assert exact shape without RNG flakiness; same inputs ALWAYS
//     produce the same outputs (matches the mock-driver discipline
//     used elsewhere in the repo: "deterministic; same inputs →
//     same outputs").'
//   • Pure-generator delegation seam pinned.
//   • DEFAULT_PROFILES: 2-entry catalogue (casual_browser_us +
//     fast_typer_dev) with 5 numeric fields each.
//   • defaultSeed: deterministic seed = label + JSON-stringified
//     opts framing pinned.
//   • generateMouseTrajectory delegates to the pure mouse generator.
//   • generateKeyboardCadence: 'Deterministic constant delay — real
//     path samples around mean with profile-tuned jitter.' + delaysMs
//     = repeat profile.meanKeyDelayMs.
//   • generateScrollPattern: constant ticks plus exact final remainder,
//     physical signs, exact requested total, and 16ms cadence.
//   • generateTouchEvent: parity-by-reuse rationale 'mock surface
//     re-uses it directly rather than shipping a separate constant-
//     output stub. Mock/real parity here means callers don't see a
//     behavioural shift when the real Phase 3 simulator ships behind
//     the same interface.'
//   • generateScrollVelocityProfile: 'Same parity pattern as
//     generateTouchEvent — the real generator is already
//     deterministic + pure.'
//   • listProfiles: returns this.profiles unchanged.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/mock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W451.C packages/behavioural-simulation/src/mock.ts content parity', () => {
  const body = read(LIB);

  it('V-127 framing pinned: \'V-127 mock implementation. Deterministic outputs so tests can assert exact shape without RNG flakiness; same inputs ALWAYS produce the same outputs (matches the mock-driver discipline used elsewhere in the repo: "deterministic; same inputs → same outputs").\'', () => {
    expect(body).toMatch(
      /\/\/ V-127 mock implementation\. Deterministic outputs so tests can\s*\/\/ assert exact shape without RNG flakiness; same inputs ALWAYS\s*\/\/ produce the same outputs \(matches the mock-driver discipline used\s*\/\/ elsewhere in the repo: "deterministic; same inputs → same outputs"\)\./,
    );
    expect(body).toMatch(
      /\/\/ Pure deterministic mouse, touch and scroll-velocity generators already\s*\/\/ exist, so this reference simulator delegates to them for mock\/real parity\./,
    );
  });

  it('imports: interface/types, real touch/scroll delegates, and the shared grapheme splitter', () => {
    expect(body).toMatch(
      /import type \{\s*BehaviouralSimulator,\s*GenerateKeyboardCadenceOpts,\s*GenerateMouseTrajectoryOpts,\s*GenerateScrollPatternOpts,\s*GenerateScrollVelocityProfileOpts,\s*GenerateTouchEventOpts,\s*\} from '\.\/interfaces\.js';/,
    );
    expect(body).toMatch(
      /import \{ generateScrollVelocityProfile, type ScrollVelocityProfile \} from '\.\/scroll\.js';/,
    );
    expect(body).toMatch(/import \{ generateTouchEvent \} from '\.\/touch\.js';/);
    expect(body).toMatch(/import \{ splitGraphemes \} from '\.\/graphemes\.js';/);
    expect(body).toMatch(/import \{ generateMouseTrajectory \} from '\.\/mouse\.js';/);
    expect(body).toMatch(
      /import \{ requireFinite, requirePositiveFinite \} from '\.\/validation\.js';/,
    );
    expect(body).toMatch(
      /import type \{\s*BehaviouralProfile,\s*KeyboardCadence,\s*MouseTrajectory,\s*ScrollPattern,\s*TouchEvent,\s*\} from '\.\/types\.js';/,
    );
  });

  it('DEFAULT_PROFILES: 2-entry catalogue (casual_browser_us with meanKeyDelayMs:120 + fast_typer_dev with meanKeyDelayMs:60); each has 5 numeric fields (meanKeyDelayMs + meanMouseSpeedPxPerMs + meanScrollPxPerTick + pauseProbability + meanPauseMs)', () => {
    expect(body).toMatch(
      /const DEFAULT_PROFILES: readonly BehaviouralProfile\[\] = immutableProfileSnapshot\(\[\s*\{\s*id: 'casual_browser_us',\s*meanKeyDelayMs: 120,\s*meanMouseSpeedPxPerMs: 0\.4,\s*meanScrollPxPerTick: 80,\s*pauseProbability: 0\.25,\s*meanPauseMs: 800,\s*\},\s*\{\s*id: 'fast_typer_dev',\s*meanKeyDelayMs: 60,\s*meanMouseSpeedPxPerMs: 0\.6,\s*meanScrollPxPerTick: 120,\s*pauseProbability: 0\.1,\s*meanPauseMs: 300,\s*\},\s*\]\);/,
    );
  });

  it("defaultSeed framing pinned: 'Deterministic seed = label + JSON-stringified opts. Stable across calls with identical args; differs when args differ.' + return `${label}:${JSON.stringify(opts)}`", () => {
    expect(body).toMatch(
      /function defaultSeed\(label: string, opts: unknown\): string \{\s*\/\/ Deterministic seed = label \+ JSON-stringified opts\. Stable across\s*\/\/ calls with identical args; differs when args differ\.\s*return `\$\{label\}:\$\{JSON\.stringify\(opts\)\}`;\s*\}/,
    );
  });

  it('MockBehaviouralSimulator snapshots injected profiles into a frozen readonly catalogue', () => {
    expect(body).toMatch(
      /function immutableProfileSnapshot\([\s\S]*?return Object\.freeze\(profiles\.map\(\(profile\) => Object\.freeze\(\{ \.\.\.profile \}\)\)\);/,
    );
    expect(body).toMatch(
      /export class MockBehaviouralSimulator implements BehaviouralSimulator \{\s*private readonly profiles: readonly BehaviouralProfile\[\];\s*constructor\(profiles: readonly BehaviouralProfile\[\] = DEFAULT_PROFILES\) \{\s*this\.profiles = immutableProfileSnapshot\(profiles\);\s*\}/,
    );
  });

  it('generateMouseTrajectory delegates to the deterministic pure generator', () => {
    expect(body).toMatch(
      /generateMouseTrajectory\(opts: GenerateMouseTrajectoryOpts\): MouseTrajectory \{[\s\S]*?\/\/ The real mouse generator is deterministic \+ pure, so delegating keeps[\s\S]*?return generateMouseTrajectory\(opts\);\s*\}/,
    );
  });

  it("generateKeyboardCadence uses deterministic constant delay over shared Unicode graphemes + seed = defaultSeed('kb', {text, profileId})", () => {
    expect(body).toMatch(
      /const seed = opts\.seed \?\? defaultSeed\('kb', \{ text: opts\.text, profileId: opts\.profile\.id \}\);/,
    );
    expect(body).toMatch(
      /\/\/ Deterministic constant delay — real path samples around mean\s*\/\/ with profile-tuned jitter\. Keep one delay per Unicode grapheme so the\s*\/\/ mock cannot hide lone-surrogate events that the real path rejects\./,
    );
    expect(body).toMatch(
      /const delaysMs = splitGraphemes\(opts\.text\)\.map\(\(\) => opts\.profile\.meanKeyDelayMs\);/,
    );
  });

  it('generateScrollPattern framing pinned: constant ticks + exact final remainder + bounded count + physical sign + 16ms cadence', () => {
    expect(body).toMatch(
      /\/\/ Constant per-tick delta \(no decay\) except for the exact final remainder —\s*\/\/ real path applies velocity decay \+ occasional reversal jitter\./,
    );
    expect(body).toMatch(
      /const tickPx = opts\.profile\.meanScrollPxPerTick;\s*const tickCount = Math\.max\(1, Math\.ceil\(opts\.totalDistancePx \/ tickPx\)\);/,
    );
    expect(body).toMatch(/export const MAX_SCROLL_PATTERN_TICKS = 10_000;/);
    expect(body).toMatch(/if \(tickCount > MAX_SCROLL_PATTERN_TICKS\) \{/);
    expect(body).toMatch(
      /const sign = opts\.direction === 'up' \|\| opts\.direction === 'left' \? -1 : 1;/,
    );
    expect(body).toMatch(
      /let emittedDistancePx = 0;[\s\S]*?const magnitudePx =\s*i === tickCount - 1 \? opts\.totalDistancePx - emittedDistancePx : tickPx;\s*ticks\.push\(\{ deltaPx: sign \* magnitudePx, tMs: i \* 16 \}\);\s*emittedDistancePx \+= magnitudePx;/,
    );
    expect(body).toMatch(/totalDistancePx: opts\.totalDistancePx,/);
  });

  it("generateTouchEvent + generateScrollVelocityProfile: parity-by-reuse framing pinned 'mock surface re-uses it directly rather than shipping a separate constant-output stub. Mock/real parity here means callers don't see a behavioural shift when the real Phase 3 simulator ships behind the same interface.' + 'Same parity pattern as generateTouchEvent — the real generator is already deterministic + pure.'", () => {
    expect(body).toMatch(
      /\/\/ The real touch generator is already deterministic \+ pure \(see\s*\/\/ `touch\.ts`\), so the mock surface re-uses it directly rather than\s*\/\/ shipping a separate constant-output stub\. Mock\/real parity here means\s*\/\/ callers don't see a behavioural shift when the real Phase 3 simulator\s*\/\/ ships behind the same interface\./,
    );
    expect(body).toMatch(
      /generateTouchEvent\(opts: GenerateTouchEventOpts\): TouchEvent \{[\s\S]*?return generateTouchEvent\(opts\);\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Same parity pattern as generateTouchEvent — the real generator is\s*\/\/ already deterministic \+ pure\./,
    );
    expect(body).toMatch(
      /generateScrollVelocityProfile\(opts: GenerateScrollVelocityProfileOpts\): ScrollVelocityProfile \{[\s\S]*?return generateScrollVelocityProfile\(opts\);\s*\}/,
    );
  });

  it('listProfiles: returns this.profiles unchanged', () => {
    expect(body).toMatch(
      /listProfiles\(\): readonly BehaviouralProfile\[\] \{\s*return this\.profiles;\s*\}/,
    );
  });

  it('mouse delegation and mock keyboard allocation boundaries are pinned', () => {
    expect(body).toContain("import { MAX_TEXT_LENGTH } from './keyboard.js';");
    expect(body).toContain("import { generateMouseTrajectory } from './mouse.js';");
    expect(body).toContain('if (opts.text.length > MAX_TEXT_LENGTH) {');
    expect(body).toContain(
      "requireFinite('MockBehaviouralSimulator.generateKeyboardCadence: durationMs', durationMs);",
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
