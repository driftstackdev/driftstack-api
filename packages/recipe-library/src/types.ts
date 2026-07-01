// Phase 3 recipe types — V-127 stub.
//
// Recipes are pre-built scripts that orchestrate a sequence of session
// operations (navigate, interact, wait, capture). The catalogue ships
// in Phase 3; the runner interface + mock land here so callers can
// integrate against the seam now.

/** A single step in a recipe — a typed driver action with arguments. */
export type RecipeStep =
  | { kind: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { kind: 'tap'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pixels: number }
  | { kind: 'wait'; condition: 'selector' | 'url' | 'time'; value: string | number }
  | { kind: 'capture'; what: 'screenshot' | 'dom' | 'pdf' };

/** A named recipe — sequence of steps with optional metadata for catalogue display. */
export interface Recipe {
  /** Stable identifier (e.g. `'login_to_example_com'`). */
  id: string;
  /** Human-readable name surfaced in the GUI catalogue. */
  name: string;
  /** Optional category for catalogue grouping. */
  category?: string;
  /** Ordered steps. */
  steps: readonly RecipeStep[];
}

/** Per-step run state. Surfaced to the runner caller as the recipe progresses. */
export interface RecipeStepResult {
  step: RecipeStep;
  /** Step outcome. */
  status: 'ok' | 'failed' | 'skipped';
  /** Wall-clock duration of this step (ms). */
  durationMs: number;
  /** Error detail when status === 'failed'. */
  error?: { message: string; cause?: unknown };
}

/** Aggregate result for a complete recipe run. */
export interface RecipeResult {
  recipeId: string;
  status: 'ok' | 'failed' | 'partial';
  /** Per-step results in execution order. */
  steps: readonly RecipeStepResult[];
  /** Wall-clock duration of the whole run (ms). */
  durationMs: number;
}

/** Context the runner needs to execute against a session. */
export interface RecipeContext {
  /** Session ID the recipe runs against. */
  sessionId: string;
  /**
   * Optional per-run metadata surfaced into result/log. Can carry credentials
   * (e.g. an auth token or a credential-bearing URL stashed by the caller) —
   * route through `redactMetadata` (redact.ts) before surfacing, same as
   * `RecipeStepResult.step` is routed through `redactStepForResult`.
   */
  metadata?: Record<string, unknown>;
}
