// A step-failure category added after this SDK was released must still type-check.
//
// The server adds categories over time. While `AgentFailureDiagnosis.category`
// was a closed union, a caller who stored, forwarded or re-typed a result the
// server actually sent could not hold a newer category without a cast. The type
// is now "the known values, or any other string".
//
// The first arm is checked by `tsc` (this directory is in the SDK's tsconfig):
// against a closed union the assignment below is a type error. The second keeps
// the known values as literals, which a plain `string` would lose.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentFailureDiagnosis,
  AgentIntentResult,
} from '../../src/resources/agent-sessions.js';

const NEWER_CATEGORY = 'a_category_added_after_this_sdk_was_released';

describe('a failure category newer than the SDK', () => {
  it('is still an AgentIntentResult a caller can hold and read', () => {
    const step: AgentIntentResult = {
      kind: 'failure',
      intent: { kind: 'interact', action: 'tap', selector: '#buy' },
      reason: 'the tap was not made',
      diagnosis: { category: NEWER_CATEGORY, retryable: false },
    };
    expect(step.kind === 'failure' ? step.diagnosis?.category : undefined).toBe(NEWER_CATEGORY);
  });

  it('keeps the known categories as literals, so editors still suggest them', () => {
    type Category = AgentFailureDiagnosis['category'];
    expectTypeOf<Extract<Category, 'target_unverified'>>().toEqualTypeOf<'target_unverified'>();
    expectTypeOf<Extract<Category, 'element_covered'>>().toEqualTypeOf<'element_covered'>();
    expectTypeOf<Extract<Category, 'unknown'>>().toEqualTypeOf<'unknown'>();
  });
});
