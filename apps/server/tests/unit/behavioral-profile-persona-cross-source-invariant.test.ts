// Cross-source invariant — the customer-facing BehavioralProfile enum
// (api-types session-create) must stay in lockstep with the canonical persona
// catalogue in @driftstack/behavioural-simulation (PersonaId), and the field
// must thread create-request → service (defaulted) → driver create-input →
// mock (captured for inspection). Drift would let a customer select a persona
// the harness model doesn't define, or silently drop the selection before it
// reaches the driver/harness.
//
// (api-types and behavioural-simulation are independent packages with no
// cross-dep, so the lib side is pinned by reading profiles.ts source text —
// the same pattern the other cross-source enum guards use.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BehavioralProfileSchema, DEFAULT_BEHAVIORAL_PROFILE } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');

const PERSONA_IDS = ['casual', 'regular', 'power_user'] as const;

describe('BehavioralProfile ⇔ persona-catalogue cross-source invariant', () => {
  it('CRITICAL api-types BehavioralProfileSchema = EXACTLY the 3 persona ids (casual/regular/power_user), default regular', () => {
    // EXACT canonical pin — not a subset (so a 4th persona must be added here
    // deliberately, in lockstep with the lib catalogue below).
    expect(BehavioralProfileSchema.options).toEqual([...PERSONA_IDS]);
    expect(DEFAULT_BEHAVIORAL_PROFILE).toBe('regular');
  });

  it('CRITICAL the lib persona catalogue (behavioural-simulation/profiles.ts) defines the SAME 3 ids + same default — the model is the source of truth', () => {
    const profiles = read('packages/behavioural-simulation/src/profiles.ts');
    expect(profiles).toMatch(/export type PersonaId = 'casual' \| 'regular' \| 'power_user';/);
    expect(profiles).toMatch(/DEFAULT_PERSONA_ID: PersonaId = 'regular';/);
    expect(profiles).toContain('return Object.freeze(profile);');
    expect(profiles).toContain(
      'export const PROFILE_CATALOGUE: readonly BehaviouralProfile[] = Object.freeze([',
    );
    for (const id of PERSONA_IDS) {
      expect(profiles, `PROFILE_CATALOGUE must contain id '${id}'`).toMatch(
        new RegExp(`id: '${id}'`),
      );
    }
  });

  it('CRITICAL behavioral_profile threads create-request → service (defaulted) → driver create-input → mock', () => {
    // api-types: optional on the create request.
    expect(read('packages/api-types/src/sessions.ts')).toMatch(
      /behavioral_profile: BehavioralProfileSchema\.optional\(\)/,
    );
    // service: defaulted (like purpose) + passed to the driver create-input.
    const svc = read('apps/server/src/services/sessions.ts');
    expect(svc).toMatch(/body\.behavioral_profile \?\? DEFAULT_BEHAVIORAL_PROFILE/);
    expect(svc).toMatch(/behavioralProfile,/);
    // driver contract: optional field on CreateSessionInput.
    expect(read('apps/server/src/drivers/types.ts')).toMatch(
      /behavioralProfile\?: BehavioralProfile;/,
    );
    // mock: captured for inspection (mirrors purpose; doesn't act on it).
    expect(read('apps/server/src/drivers/mock.ts')).toMatch(
      /behavioralProfile: input\.behavioralProfile/,
    );
  });

  it('CRITICAL the Go SDK exposes the persona — BehavioralProfile type + 3 consts + default + the CreateSessionRequest.BehavioralProfile field (so Go customers can select it; guards the create-field-completeness gap from re-opening)', () => {
    const goTypes = read('packages/sdk-go/types.go');
    expect(goTypes).toMatch(/type BehavioralProfile string/);
    expect(goTypes).toMatch(/PersonaCasual\s+BehavioralProfile = "casual"/);
    expect(goTypes).toMatch(/PersonaRegular\s+BehavioralProfile = "regular"/);
    expect(goTypes).toMatch(/PersonaPowerUser\s+BehavioralProfile = "power_user"/);
    expect(goTypes).toMatch(/DefaultBehavioralProfile = PersonaRegular/);
    expect(goTypes).toMatch(
      /BehavioralProfile BehavioralProfile `json:"behavioral_profile,omitempty"`/,
    );
  });
});
