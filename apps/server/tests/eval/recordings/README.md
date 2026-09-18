# Eval recordings — deliberately empty

This directory holds one JSON file per task under `plannerMode: recorded`:

```jsonc
{
  "taskId": "P1",
  "recordedAt": "…",
  "model": "…",
  "promptSha256": "…",
  "requestDigest": "…",
  "responseBody": {
    /* the Anthropic envelope */
  },
}
```

**It is empty, and that is a measurement, not an omission.** A recording is the
model's own output on a given day. Producing one needs a live call against the
fictional `.test` sites through the recorder; nothing in this change made one. A
hand-written file here would be a fabricated record that verifies green —
internally consistent and externally false — so the `recorded` tier is
UNAVAILABLE rather than approximated, and `eval-baseline.json` declares
`plannerMode: scripted`.

`agent-eval-recordings-are-current.test.ts` enforces exactly that: with no
recordings present, the baseline must not claim a recorded number.

## When recordings do exist

- `promptSha256` is recomputed from the live system prompt every run. On a
  mismatch the repair is **re-record**, never "update the pin" — an edited pin
  certifies stale evidence as current.
- `requestDigest` is compared against the request the decomposer actually builds.
  A recorded answer is never served to a different question.
- Superseded recordings are **kept**, not overwritten. When a prompt change flips
  a task's outcome, the pair of recordings is the evidence.
- Every recording is captured against the fictional `.test` sites through the
  fake device, so a re-record never touches a real site.
