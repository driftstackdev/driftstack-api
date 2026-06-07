// Credential redaction for recipe step results.
//
// A `RecipeStepResult` embeds the executed `RecipeStep` for observability.
// `type`-step `text` can carry credentials (e.g. the password inlined by
// buildLoginRecipe), so a runner that logs / persists / returns a
// RecipeResult would leak plaintext — the same class as the SSE token-in-log
// leak (V-494 redact posture). The result is for reporting, NOT re-execution,
// so the plaintext is never needed there.
//
// `redactStepForResult` is the single chokepoint: the mock runner uses it, and
// the real Phase-3 runner MUST build its RecipeStepResult.step through it too,
// so redaction holds by construction regardless of the runner.

import type { RecipeStep } from './types.js';

/** Placeholder substituted for any secret-bearing field in a result step. */
export const REDACTED = '[redacted]';

/**
 * Return a copy of `step` safe to embed in a RecipeStepResult — secret-bearing
 * fields replaced with {@link REDACTED}. Currently redacts `type`-step `text`
 * (the credential vector). Non-secret-bearing steps are returned unchanged.
 */
export function redactStepForResult(step: RecipeStep): RecipeStep {
  if (step.kind === 'type') {
    return { ...step, text: REDACTED };
  }
  return step;
}
