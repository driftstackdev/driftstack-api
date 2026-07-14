import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA_ID,
  generateKeyboardCadence,
  getProfile,
  listProfiles,
  PROFILE_CATALOGUE,
  type BehaviouralProfile,
} from '../src/index.js';

describe('behavioural persona catalogue', () => {
  it('contains exactly the v1 spec personas (casual / regular / power_user)', () => {
    expect(PROFILE_CATALOGUE.map((p) => p.id)).toEqual(['casual', 'regular', 'power_user']);
  });

  it('getProfile resolves by id; unknown → undefined', () => {
    expect(getProfile('casual')?.id).toBe('casual');
    expect(getProfile('power_user')?.id).toBe('power_user');
    expect(getProfile('nope')).toBeUndefined();
  });

  it('listProfiles returns the full catalogue', () => {
    expect(listProfiles()).toBe(PROFILE_CATALOGUE);
    expect(listProfiles()).toHaveLength(3);
  });

  it('deep-freezes the shared catalogue so one caller cannot rewrite every persona', () => {
    const casual = getProfile('casual')!;
    const originalDelay = casual.meanKeyDelayMs;
    expect(Object.isFrozen(PROFILE_CATALOGUE)).toBe(true);
    expect(PROFILE_CATALOGUE.every((profile) => Object.isFrozen(profile))).toBe(true);

    expect(() => {
      (casual as { meanKeyDelayMs: number }).meanKeyDelayMs = 1;
    }).toThrow(TypeError);
    expect(() => {
      (PROFILE_CATALOGUE as BehaviouralProfile[]).pop();
    }).toThrow(TypeError);
    expect(getProfile('casual')?.meanKeyDelayMs).toBe(originalDelay);
    expect(listProfiles()).toHaveLength(3);
  });

  it('DEFAULT_PERSONA_ID resolves to a catalogue member', () => {
    expect(getProfile(DEFAULT_PERSONA_ID)).toBeDefined();
  });

  it("casual mean key delay matches file 05's base_wpm 38 (12000/38)", () => {
    expect(getProfile('casual')?.meanKeyDelayMs).toBe(Math.round(12000 / 38));
  });

  it('persona progression: key delay ↓, scroll ↑, pause-probability ↓ from casual → power_user', () => {
    const [casual, regular, power] = PROFILE_CATALOGUE;
    // Typing gets faster (smaller inter-key delay).
    expect(casual!.meanKeyDelayMs).toBeGreaterThan(regular!.meanKeyDelayMs);
    expect(regular!.meanKeyDelayMs).toBeGreaterThan(power!.meanKeyDelayMs);
    // Scrolling gets more aggressive.
    expect(power!.meanScrollPxPerTick).toBeGreaterThan(regular!.meanScrollPxPerTick);
    expect(regular!.meanScrollPxPerTick).toBeGreaterThan(casual!.meanScrollPxPerTick);
    // Power users pause less.
    expect(casual!.pauseProbability).toBeGreaterThan(power!.pauseProbability);
  });

  it('every persona has sane, well-formed parameters', () => {
    for (const p of PROFILE_CATALOGUE) {
      expect(p.id).toMatch(/^[a-z_]+$/);
      expect(p.meanKeyDelayMs).toBeGreaterThan(0);
      expect(p.meanMouseSpeedPxPerMs).toBeGreaterThan(0);
      expect(p.meanScrollPxPerTick).toBeGreaterThan(0);
      expect(p.pauseProbability).toBeGreaterThanOrEqual(0);
      expect(p.pauseProbability).toBeLessThanOrEqual(1);
      expect(p.meanPauseMs).toBeGreaterThan(0);
    }
  });

  it('feeds the keyboard generator — a faster persona types the same text quicker', () => {
    const text = 'log in and check my messages';
    const casual = generateKeyboardCadence({ text, profile: getProfile('casual')!, seed: 'k' });
    const power = generateKeyboardCadence({ text, profile: getProfile('power_user')!, seed: 'k' });
    expect(power.durationMs).toBeLessThan(casual.durationMs);
  });
});
