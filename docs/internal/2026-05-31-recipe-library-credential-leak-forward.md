# 2026-05-31 — recipe-library: forward credential-leak when Phase-3 wires logging (Agent 2)

**Status: SURFACED (forward-looking, NOT a live bug).** Fresh audit of
`packages/recipe-library` — pre-Phase-3 scaffolding (recipe types + builder helpers +
a **mock** runner; types.ts: "The catalogue ships in Phase 3; the runner interface +
mock land here so callers can integrate against the seam now"). No live executor or
result-logging is wired yet, so nothing leaks today. The note is for whoever wires
the real runner.

## The forward gap

`RecipeStep` includes `{ kind: 'type', selector, text }`, and `buildLoginRecipe`
inlines the plaintext **password** into a `type` step
(`typeInto(passwordSelector, password)`). `RecipeStepResult` embeds the **full step**
(`mock.ts::stepResultFor` returns `{ step, status, durationMs }`), and `RecipeResult`
returns all step results. So once a real runner persists/logs/returns
`RecipeResult` (Phase 3), any inlined credential in a `type` step lands in
logs/DB/API responses in plaintext — the same credential-in-output class just fixed
for the SSE `?ds_token=` log leak (`2026-05-31-sse-token-in-logs.md`).

`buildLoginRecipe`'s doc-comment already flags that "production usage typically
injects credentials via a separate vault lookup rather than inlining them in the
Recipe" — good, but that addresses _storage_, not the _result-logging_ path. Even
with runtime vault-injection, a resolved secret in a `type` step would still echo
into `RecipeStepResult.step.text`.

## When wiring Phase 3 — do BOTH

1. **Redact `type`-step `text` in `RecipeStepResult`** before any log/persist/return
   (e.g. surface `text: '[redacted]'` or omit it in results; keep selectors for
   debugging). Reuse the V-494 redaction posture (`lib/redact-url.ts` pattern +
   pino/Sentry scrub) so recipe results never carry plaintext.
2. **Prefer runtime credential injection** (vault placeholders resolved by the runner,
   never stored in the `Recipe`) over inlining — as the existing comment recommends —
   and ensure the injected value never round-trips into a logged result.

## Otherwise clean

The builders (`navigation` / `forms` / `checkout` / `wizard`) are straightforward
pure data-constructors; the mock registry/runner is simple + correct (constant-time
mock durations, not-found rejects). No other issues. This is documented-aware
scaffolding, not a live defect.

Recorded in memory `project_recipe_library_credential_leak_forward`.
