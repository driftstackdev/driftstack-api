// GUI control plane — coordinate primitives for the manual-control GUI.
//
// This schema is **server-internal only**. Per L-001
// (docs/locked-decisions.md), coordinate-level mechanics never appear
// on the customer-facing surface (`@driftstack/api-types`). The GUI's
// live viewport — where a human is literally clicking pixels in a
// screenshot — has a different stealth posture from automation: the
// human's own cadence IS the behavioral simulation, so bypassing the
// automation simulation layer is correct, not a regression.
//
// Endpoint: POST /v1/sessions/:id/gui-input.
// Auth: requires the `gui_control` scope. No broad scope satisfies it, so
// a key only carries it when the mint request asks for it explicitly.
//
// V-788 — the second half of this sentence used to read "only keys minted
// for the self-hosted GUI workflow (enterprise tier) get it", and that was
// false: services/api-keys.ts withholds only `admin` and
// `driftstack_internal_admin` from an account_owner caller, so any
// account_owner on an apiAccess tier can request this scope. Reserving it
// for the self-hosted GUI is convention, not enforcement.

import { z } from 'zod';

export const GUIInputActionSchema = z.discriminatedUnion('kind', [
  // Tap at viewport pixel coordinates (origin top-left).
  z.object({
    kind: z.literal('tap_at'),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }),
  // Type into the currently-focused element (no selector). Pairs with
  // tap_at — tap focuses, type_focused enters text.
  z.object({
    kind: z.literal('type_focused'),
    text: z.string().max(10_000),
    delay_ms: z.number().int().min(0).max(500).optional(),
  }),
]);
export type GUIInputAction = z.infer<typeof GUIInputActionSchema>;

export const GUIInputRequestSchema = z.object({
  action: GUIInputActionSchema,
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
});
export type GUIInputRequest = z.infer<typeof GUIInputRequestSchema>;

// The response shape mirrors InteractResponse — we keep it identical
// so the client-side handling is the same.
export const GUIInputResponseSchema = z.object({
  ok: z.literal(true),
  duration_ms: z.number().int().nonnegative(),
});
export type GUIInputResponse = z.infer<typeof GUIInputResponseSchema>;
