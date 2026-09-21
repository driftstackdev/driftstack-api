// decideAiSource (services/ai-source.ts) — §4.3's six rules, for a MOVED
// account (billing_mode='credits'). Pure: no database, no clock, no request.
//
// The order is part of the answer (see the module's own header comment): each
// test below fixes every input EXCEPT the one the rule under test turns on, so
// a failure names exactly which rule regressed rather than "some combination
// of five booleans changed the answer".

import { describe, expect, it } from 'vitest';
import {
  decideAiSource,
  type AiSourceEntitlement,
  type DecideAiSourceInput,
} from '../../src/services/ai-source.js';

const AI_INCLUDED_OWN_KEY_ALLOWED: AiSourceEntitlement = { aiIncluded: true, ownKeyAllowed: true };
const AI_INCLUDED_OWN_KEY_FORBIDDEN: AiSourceEntitlement = {
  aiIncluded: true,
  ownKeyAllowed: false,
};
const AI_NOT_INCLUDED: AiSourceEntitlement = { aiIncluded: false, ownKeyAllowed: false };

function input(over: Partial<DecideAiSourceInput> = {}): DecideAiSourceInput {
  return {
    entitlement: AI_INCLUDED_OWN_KEY_ALLOWED,
    aiSource: null,
    headerKeyPresent: false,
    storedKeyUsable: false,
    ...over,
  };
}

describe('decideAiSource — rule 1 (no AI on the plan at all)', () => {
  it('CRITICAL refuses ai_not_on_plan when the plan has no AI, with no other input read', () => {
    expect(decideAiSource(input({ entitlement: AI_NOT_INCLUDED }))).toEqual({
      outcome: 'refuse',
      kind: 'ai_not_on_plan',
    });
  });

  it('CRITICAL wins over rule 2: a Free-equivalent account with a header key is still refused for having no AI, not for the key', () => {
    expect(decideAiSource(input({ entitlement: AI_NOT_INCLUDED, headerKeyPresent: true }))).toEqual(
      { outcome: 'refuse', kind: 'ai_not_on_plan' },
    );
  });

  it('applies even to an own-key request with a usable stored key and ai_source=own_key — no source is exempt', () => {
    expect(
      decideAiSource(
        input({
          entitlement: AI_NOT_INCLUDED,
          aiSource: 'own_key',
          storedKeyUsable: true,
        }),
      ),
    ).toEqual({ outcome: 'refuse', kind: 'ai_not_on_plan' });
  });
});

describe('decideAiSource — rule 2 (a header key is an explicit per-request choice)', () => {
  it('CRITICAL uses the header key when the plan allows an own key', () => {
    expect(
      decideAiSource(input({ entitlement: AI_INCLUDED_OWN_KEY_ALLOWED, headerKeyPresent: true })),
    ).toEqual({ outcome: 'use', kind: 'header_key' });
  });

  it('CRITICAL refuses own_key_not_on_plan (Personal) when the plan runs AI on credits only', () => {
    expect(
      decideAiSource(input({ entitlement: AI_INCLUDED_OWN_KEY_FORBIDDEN, headerKeyPresent: true })),
    ).toEqual({ outcome: 'refuse', kind: 'own_key_not_on_plan' });
  });

  it('wins over rule 3: a header key is honoured even when ai_source=own_key and the stored key is also usable', () => {
    expect(
      decideAiSource(
        input({
          headerKeyPresent: true,
          aiSource: 'own_key',
          storedKeyUsable: true,
        }),
      ),
    ).toEqual({ outcome: 'use', kind: 'header_key' });
  });

  it('wins over rule 5: a header key is honoured even when ai_source=credits', () => {
    expect(decideAiSource(input({ headerKeyPresent: true, aiSource: 'credits' }))).toEqual({
      outcome: 'use',
      kind: 'header_key',
    });
  });
});

describe('decideAiSource — rule 3 (ai_source=own_key never falls back to credits)', () => {
  it('CRITICAL uses the stored key when it is usable', () => {
    expect(decideAiSource(input({ aiSource: 'own_key', storedKeyUsable: true }))).toEqual({
      outcome: 'use',
      kind: 'stored_key',
    });
  });

  it('CRITICAL⛔ NEGATIVE CONTROL — a missing or expired stored key is refused, and the refusal is NEVER "use credits". This is the one promise this source makes: an explicit own-key choice does not silently start spending the account’s credits the day the key ages out (H3).', () => {
    const decision = decideAiSource(input({ aiSource: 'own_key', storedKeyUsable: false }));
    expect(decision).toEqual({ outcome: 'refuse', kind: 'own_key_missing' });
    expect(decision).not.toMatchObject({ outcome: 'use', kind: 'credits' });
  });

  it('the refusal holds even when the plan would otherwise be happy to fall back automatically (contrast with rule 4 below)', () => {
    // Same inputs as the automatic-source case except aiSource itself —
    // proving the difference in outcome is attributable to aiSource alone.
    const explicit = decideAiSource(input({ aiSource: 'own_key', storedKeyUsable: false }));
    const automatic = decideAiSource(input({ aiSource: null, storedKeyUsable: false }));
    expect(explicit).toEqual({ outcome: 'refuse', kind: 'own_key_missing' });
    expect(automatic).toEqual({ outcome: 'use', kind: 'credits' });
  });
});

describe('decideAiSource — rule 4 (automatic: reproduces the fallback a legacy account consented to)', () => {
  it('CRITICAL uses the stored key when the plan allows one and it is usable', () => {
    expect(
      decideAiSource(
        input({ entitlement: AI_INCLUDED_OWN_KEY_ALLOWED, aiSource: null, storedKeyUsable: true }),
      ),
    ).toEqual({ outcome: 'use', kind: 'stored_key' });
  });

  it('CRITICAL falls to credits when the plan allows an own key but none is usable', () => {
    expect(
      decideAiSource(
        input({ entitlement: AI_INCLUDED_OWN_KEY_ALLOWED, aiSource: null, storedKeyUsable: false }),
      ),
    ).toEqual({ outcome: 'use', kind: 'credits' });
  });

  it('CRITICAL falls to credits when the plan forbids an own key, even though a stored key happens to be on file (H3: Personal keeps a key on file but never reads it)', () => {
    expect(
      decideAiSource(
        input({
          entitlement: AI_INCLUDED_OWN_KEY_FORBIDDEN,
          aiSource: null,
          storedKeyUsable: true,
        }),
      ),
    ).toEqual({ outcome: 'use', kind: 'credits' });
  });
});

describe('decideAiSource — rule 5 (ai_source=credits, or automatic with no usable key)', () => {
  it('CRITICAL uses credits for an explicit ai_source=credits account, whatever the stored-key state', () => {
    expect(decideAiSource(input({ aiSource: 'credits', storedKeyUsable: true }))).toEqual({
      outcome: 'use',
      kind: 'credits',
    });
    expect(decideAiSource(input({ aiSource: 'credits', storedKeyUsable: false }))).toEqual({
      outcome: 'use',
      kind: 'credits',
    });
  });
});

describe('decideAiSource — exhaustiveness', () => {
  it('CONTROL every non-refuse decision names a `kind` from the three USE choices, and every refuse decision names one of the three REFUSE reasons — the function never answers with anything else', () => {
    const useKinds = new Set(['header_key', 'stored_key', 'credits']);
    const refuseKinds = new Set(['ai_not_on_plan', 'own_key_not_on_plan', 'own_key_missing']);
    const entitlements = [
      AI_INCLUDED_OWN_KEY_ALLOWED,
      AI_INCLUDED_OWN_KEY_FORBIDDEN,
      AI_NOT_INCLUDED,
    ];
    const aiSources: DecideAiSourceInput['aiSource'][] = ['credits', 'own_key', null];
    for (const entitlement of entitlements) {
      for (const aiSource of aiSources) {
        for (const headerKeyPresent of [true, false]) {
          for (const storedKeyUsable of [true, false]) {
            const decision = decideAiSource({
              entitlement,
              aiSource,
              headerKeyPresent,
              storedKeyUsable,
            });
            if (decision.outcome === 'use') {
              expect(useKinds.has(decision.kind)).toBe(true);
            } else {
              expect(refuseKinds.has(decision.kind)).toBe(true);
            }
          }
        }
      }
    }
  });
});
