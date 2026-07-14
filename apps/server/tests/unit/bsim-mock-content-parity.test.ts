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
//   • Phase-3 seam rationale: 'Phase 3 ships a non-mock generator
//     behind the same interface.'
//   • DEFAULT_PROFILES: 2-entry catalogue (casual_browser_us +
//     fast_typer_dev) with 5 numeric fields each.
//   • defaultSeed: deterministic seed = label + JSON-stringified
//     opts framing pinned.
//   • generateMouseTrajectory: linear interpolation rationale 'real
//     Phase 3 path is Bezier with humanlike noise; the mock keeps it
//     linear so tests can assert exact midpoints.' + samples default
//     32 + duration 250ms.
//   • generateKeyboardCadence: 'Deterministic constant delay — real
//     path samples around mean with profile-tuned jitter.' + delaysMs
//     = repeat profile.meanKeyDelayMs.
//   • generateScrollPattern: 'Constant per-tick delta (no decay) —
//     real path applies velocity decay + occasional reversal jitter.'
//     + tick interval 16ms.
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
      /\/\/ V-127 mock implementation\. Deterministic outputs so tests can\s*\n?\s*\/\/ assert exact shape without RNG flakiness; same inputs ALWAYS\s*\n?\s*\/\/ produce the same outputs \(matches the mock-driver discipline used\s*\n?\s*\/\/ elsewhere in the repo: "deterministic; same inputs → same outputs"\)\./,
    );
    expect(body).toMatch(/\/\/ Phase 3 ships a non-mock generator behind the same interface\./);
  });

  it('imports: interface/types, real touch/scroll delegates, and the shared grapheme splitter', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*BehaviouralSimulator,\s*\n?\s*GenerateKeyboardCadenceOpts,\s*\n?\s*GenerateMouseTrajectoryOpts,\s*\n?\s*GenerateScrollPatternOpts,\s*\n?\s*GenerateScrollVelocityProfileOpts,\s*\n?\s*GenerateTouchEventOpts,\s*\n?\s*\} from '\.\/interfaces\.js';/,
    );
    expect(body).toMatch(
      /import \{ generateScrollVelocityProfile, type ScrollVelocityProfile \} from '\.\/scroll\.js';/,
    );
    expect(body).toMatch(/import \{ generateTouchEvent \} from '\.\/touch\.js';/);
    expect(body).toMatch(/import \{ splitGraphemes \} from '\.\/graphemes\.js';/);
    expect(body).toMatch(
      /import \{ requireFinite, requireIntegerInRange, requirePositiveFinite \} from '\.\/validation\.js';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*BehaviouralProfile,\s*\n?\s*KeyboardCadence,\s*\n?\s*MouseTrajectory,\s*\n?\s*ScrollPattern,\s*\n?\s*TouchEvent,\s*\n?\s*\} from '\.\/types\.js';/,
    );
  });

  it('DEFAULT_PROFILES: 2-entry catalogue (casual_browser_us with meanKeyDelayMs:120 + fast_typer_dev with meanKeyDelayMs:60); each has 5 numeric fields (meanKeyDelayMs + meanMouseSpeedPxPerMs + meanScrollPxPerTick + pauseProbability + meanPauseMs)', () => {
    expect(body).toMatch(
      /const DEFAULT_PROFILES: readonly BehaviouralProfile\[\] = \[\s*\n?\s*\{\s*\n?\s*id: 'casual_browser_us',\s*\n?\s*meanKeyDelayMs: 120,\s*\n?\s*meanMouseSpeedPxPerMs: 0\.4,\s*\n?\s*meanScrollPxPerTick: 80,\s*\n?\s*pauseProbability: 0\.25,\s*\n?\s*meanPauseMs: 800,\s*\n?\s*\},\s*\n?\s*\{\s*\n?\s*id: 'fast_typer_dev',\s*\n?\s*meanKeyDelayMs: 60,\s*\n?\s*meanMouseSpeedPxPerMs: 0\.6,\s*\n?\s*meanScrollPxPerTick: 120,\s*\n?\s*pauseProbability: 0\.1,\s*\n?\s*meanPauseMs: 300,\s*\n?\s*\},\s*\n?\s*\];/,
    );
  });

  it("defaultSeed framing pinned: 'Deterministic seed = label + JSON-stringified opts. Stable across calls with identical args; differs when args differ.' + return `${label}:${JSON.stringify(opts)}`", () => {
    expect(body).toMatch(
      /function defaultSeed\(label: string, opts: unknown\): string \{\s*\n?\s*\/\/ Deterministic seed = label \+ JSON-stringified opts\. Stable across\s*\n?\s*\/\/ calls with identical args; differs when args differ\.\s*\n?\s*return `\$\{label\}:\$\{JSON\.stringify\(opts\)\}`;\s*\n?\s*\}/,
    );
  });

  it('MockBehaviouralSimulator class implements BehaviouralSimulator; constructor profiles default = DEFAULT_PROFILES; readonly modifier', () => {
    expect(body).toMatch(
      /export class MockBehaviouralSimulator implements BehaviouralSimulator \{\s*\n?\s*constructor\(private readonly profiles: readonly BehaviouralProfile\[\] = DEFAULT_PROFILES\) \{\}/,
    );
  });

  it("generateMouseTrajectory framing pinned: linear interpolation rationale 'Deterministic linear interpolation — the real Phase 3 path is Bezier with humanlike noise; the mock keeps it linear so tests can assert exact midpoints.' + samples default 32 + durationMs 250", () => {
    expect(body).toMatch(
      /const samples = opts\.samples \?\? 32;\s*\n?\s*const seed = opts\.seed \?\? defaultSeed\('mouse', opts\);/,
    );
    expect(body).toMatch(
      /\/\/ Deterministic linear interpolation — the real Phase 3 path is\s*\n?\s*\/\/ Bezier with humanlike noise; the mock keeps it linear so tests\s*\n?\s*\/\/ can assert exact midpoints\./,
    );
    expect(body).toMatch(/const durationMs = 250;/);
    expect(body).toMatch(/return \{ from: opts\.from, to: opts\.to, points, durationMs, seed \};/);
  });

  it("generateKeyboardCadence uses deterministic constant delay over shared Unicode graphemes + seed = defaultSeed('kb', {text, profileId})", () => {
    expect(body).toMatch(
      /const seed = opts\.seed \?\? defaultSeed\('kb', \{ text: opts\.text, profileId: opts\.profile\.id \}\);/,
    );
    expect(body).toMatch(
      /\/\/ Deterministic constant delay — real path samples around mean\s*\n?\s*\/\/ with profile-tuned jitter\. Keep one delay per Unicode grapheme so the\s*\n?\s*\/\/ mock cannot hide lone-surrogate events that the real path rejects\./,
    );
    expect(body).toMatch(
      /const delaysMs = splitGraphemes\(opts\.text\)\.map\(\(\) => opts\.profile\.meanKeyDelayMs\);/,
    );
  });

  it('generateScrollPattern framing pinned: constant per-tick magnitude + bounded tick count + physical direction sign + 16ms tick interval', () => {
    expect(body).toMatch(
      /\/\/ Constant per-tick delta \(no decay\) — real path applies velocity\s*\n?\s*\/\/ decay \+ occasional reversal jitter\./,
    );
    expect(body).toMatch(
      /const tickPx = opts\.profile\.meanScrollPxPerTick;\s*\n?\s*const tickCount = Math\.max\(1, Math\.ceil\(opts\.totalDistancePx \/ tickPx\)\);/,
    );
    expect(body).toMatch(/export const MAX_SCROLL_PATTERN_TICKS = 10_000;/);
    expect(body).toMatch(/if \(tickCount > MAX_SCROLL_PATTERN_TICKS\) \{/);
    expect(body).toMatch(
      /const sign = opts\.direction === 'up' \|\| opts\.direction === 'left' \? -1 : 1;/,
    );
    expect(body).toMatch(/ticks\.push\(\{ deltaPx: sign \* tickPx, tMs: i \* 16 \}\);/);
  });

  it("generateTouchEvent + generateScrollVelocityProfile: parity-by-reuse framing pinned 'mock surface re-uses it directly rather than shipping a separate constant-output stub. Mock/real parity here means callers don't see a behavioural shift when the real Phase 3 simulator ships behind the same interface.' + 'Same parity pattern as generateTouchEvent — the real generator is already deterministic + pure.'", () => {
    expect(body).toMatch(
      /\/\/ The real touch generator is already deterministic \+ pure \(see\s*\n?\s*\/\/ `touch\.ts`\), so the mock surface re-uses it directly rather than\s*\n?\s*\/\/ shipping a separate constant-output stub\. Mock\/real parity here means\s*\n?\s*\/\/ callers don't see a behavioural shift when the real Phase 3 simulator\s*\n?\s*\/\/ ships behind the same interface\./,
    );
    expect(body).toMatch(
      /generateTouchEvent\(opts: GenerateTouchEventOpts\): TouchEvent \{[\s\S]*?return generateTouchEvent\(opts\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Same parity pattern as generateTouchEvent — the real generator is\s*\n?\s*\/\/ already deterministic \+ pure\./,
    );
    expect(body).toMatch(
      /generateScrollVelocityProfile\(opts: GenerateScrollVelocityProfileOpts\): ScrollVelocityProfile \{[\s\S]*?return generateScrollVelocityProfile\(opts\);\s*\n?\s*\}/,
    );
  });

  it('listProfiles: returns this.profiles unchanged', () => {
    expect(body).toMatch(
      /listProfiles\(\): readonly BehaviouralProfile\[\] \{\s*\n?\s*return this\.profiles;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
