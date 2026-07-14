// W596.C — drift guard for packages/behavioural-simulation/src/mock.ts.
// V-127 deterministic mock simulator + Phase-3 mock/real parity for
// touch + scroll-velocity (real generators already deterministic).

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

describe('W596.C packages/behavioural-simulation/src/mock.ts content parity', () => {
  const body = read(LIB);

  it('V-127 mock framing + same-inputs-ALWAYS-same-outputs + mock-driver-discipline reference + Phase-3-non-mock-generator-behind-same-interface pinned', () => {
    expect(body).toMatch(/\/\/ V-127 mock implementation\. Deterministic outputs so tests can/);
    expect(body).toMatch(/\/\/ assert exact shape without RNG flakiness; same inputs ALWAYS/);
    expect(body).toMatch(/\/\/ produce the same outputs \(matches the mock-driver discipline used/);
    expect(body).toMatch(
      /\/\/ elsewhere in the repo: "deterministic; same inputs → same outputs"\)\./,
    );
    expect(body).toMatch(/\/\/ Phase 3 ships a non-mock generator behind the same interface\./);
  });

  it('DEFAULT_PROFILES: 2 personas (casual_browser_us + fast_typer_dev) with full BehaviouralProfile shape pinned', () => {
    expect(body).toMatch(
      /^const DEFAULT_PROFILES: readonly BehaviouralProfile\[\] = immutableProfileSnapshot\(\[/m,
    );
    expect(body).toMatch(
      /\{\s*\n\s*id: 'casual_browser_us',\s*\n\s*meanKeyDelayMs: 120,\s*\n\s*meanMouseSpeedPxPerMs: 0\.4,\s*\n\s*meanScrollPxPerTick: 80,\s*\n\s*pauseProbability: 0\.25,\s*\n\s*meanPauseMs: 800,\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /\{\s*\n\s*id: 'fast_typer_dev',\s*\n\s*meanKeyDelayMs: 60,\s*\n\s*meanMouseSpeedPxPerMs: 0\.6,\s*\n\s*meanScrollPxPerTick: 120,\s*\n\s*pauseProbability: 0\.1,\s*\n\s*meanPauseMs: 300,\s*\n\s*\}/,
    );
  });

  it('defaultSeed deterministic label+JSON.stringify(opts) helper + MockBehaviouralSimulator 6 methods (mouse linear-interp + keyboard constant-delay + scroll constant-tick + touch via touch.ts + scroll-velocity via scroll.ts + listProfiles)', () => {
    expect(body).toMatch(/^function defaultSeed\(label: string, opts: unknown\): string \{$/m);
    expect(body).toMatch(
      /\/\/ Deterministic seed = label \+ JSON-stringified opts\. Stable across/,
    );
    expect(body).toMatch(/\/\/ calls with identical args; differs when args differ\./);
    expect(body).toMatch(/return `\$\{label\}:\$\{JSON\.stringify\(opts\)\}`;/);
    expect(body).toMatch(
      /^export class MockBehaviouralSimulator implements BehaviouralSimulator \{$/m,
    );
    expect(body).toMatch(/private readonly profiles: readonly BehaviouralProfile\[\];/);
    expect(body).toMatch(
      /constructor\(profiles: readonly BehaviouralProfile\[\] = DEFAULT_PROFILES\) \{\s*\n\s*this\.profiles = immutableProfileSnapshot\(profiles\);\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /return Object\.freeze\(profiles\.map\(\(profile\) => Object\.freeze\(\{ \.\.\.profile \}\)\)\);/,
    );
    expect(body).toMatch(
      /generateMouseTrajectory\(opts: GenerateMouseTrajectoryOpts\): MouseTrajectory \{/,
    );
    expect(body).toMatch(/const samples = opts\.samples \?\? 32;/);
    expect(body).toMatch(/\/\/ Deterministic linear interpolation — the real Phase 3 path is/);
    expect(body).toMatch(/\/\/ Bezier with humanlike noise; the mock keeps it linear so tests/);
    expect(body).toMatch(/\/\/ can assert exact midpoints\./);
    expect(body).toMatch(/const durationMs = 250;/);
    expect(body).toMatch(
      /generateKeyboardCadence\(opts: GenerateKeyboardCadenceOpts\): KeyboardCadence \{/,
    );
    expect(body).toMatch(/\/\/ Deterministic constant delay — real path samples around mean/);
    expect(body).toMatch(/\/\/ with profile-tuned jitter\. Keep one delay per Unicode grapheme/);
    expect(body).toMatch(
      /const delaysMs = splitGraphemes\(opts\.text\)\.map\(\(\) => opts\.profile\.meanKeyDelayMs\);/,
    );
    expect(body).toMatch(
      /generateScrollPattern\(opts: GenerateScrollPatternOpts\): ScrollPattern \{/,
    );
    expect(body).toMatch(/\/\/ Constant per-tick delta \(no decay\) — real path applies velocity/);
    expect(body).toMatch(/\/\/ decay \+ occasional reversal jitter\./);
    expect(body).toMatch(
      /const tickCount = Math\.max\(1, Math\.ceil\(opts\.totalDistancePx \/ tickPx\)\);/,
    );
    expect(body).toMatch(/export const MAX_SCROLL_PATTERN_TICKS = 10_000;/);
    expect(body).toMatch(/if \(tickCount > MAX_SCROLL_PATTERN_TICKS\) \{/);
    expect(body).toMatch(
      /const sign = opts\.direction === 'up' \|\| opts\.direction === 'left' \? -1 : 1;/,
    );
    expect(body).toMatch(/ticks\.push\(\{ deltaPx: sign \* tickPx, tMs: i \* 16 \}\);/);
  });

  it('generateTouchEvent + generateScrollVelocityProfile delegate to real generators (mock/real parity rationale: real already deterministic+pure, callers see no behavioural shift when Phase 3 ships) + listProfiles returns the profiles array', () => {
    expect(body).toMatch(/generateTouchEvent\(opts: GenerateTouchEventOpts\): TouchEvent \{/);
    expect(body).toMatch(/\/\/ The real touch generator is already deterministic \+ pure \(see/);
    expect(body).toMatch(/\/\/ `touch\.ts`\), so the mock surface re-uses it directly rather than/);
    expect(body).toMatch(
      /\/\/ shipping a separate constant-output stub\. Mock\/real parity here means/,
    );
    expect(body).toMatch(
      /\/\/ callers don't see a behavioural shift when the real Phase 3 simulator/,
    );
    expect(body).toMatch(/\/\/ ships behind the same interface\./);
    expect(body).toMatch(/return generateTouchEvent\(opts\);/);
    expect(body).toMatch(
      /generateScrollVelocityProfile\(opts: GenerateScrollVelocityProfileOpts\): ScrollVelocityProfile \{/,
    );
    expect(body).toMatch(/\/\/ Same parity pattern as generateTouchEvent — the real generator is/);
    expect(body).toMatch(/\/\/ already deterministic \+ pure\./);
    expect(body).toMatch(/return generateScrollVelocityProfile\(opts\);/);
    expect(body).toMatch(
      /listProfiles\(\): readonly BehaviouralProfile\[\] \{\s*\n\s*return this\.profiles;\s*\n\s*\}/,
    );
  });

  it('derived spans and mock keyboard text/duration boundaries are pinned', () => {
    expect(body).toContain("import { MAX_TEXT_LENGTH } from './keyboard.js';");
    expect(body).toContain("requireFinite('generateMouseTrajectory: derived x span', dx);");
    expect(body).toContain("requireFinite('generateMouseTrajectory: derived y span', dy);");
    expect(body).toContain('if (opts.text.length > MAX_TEXT_LENGTH) {');
    expect(body).toContain(
      "requireFinite('MockBehaviouralSimulator.generateKeyboardCadence: durationMs', durationMs);",
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
