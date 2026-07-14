// V-266 — Browser-based CLI / GUI authorization flow.
//
// Replaces the "find your API key in the dashboard, paste it into the
// GUI" flow with an OAuth-style browser handshake:
//
//   1. CLI/GUI calls /v1/auth/cli-authorize/initiate, gets a one-shot
//      `code`, a device-displayed `user_code`, and a `browser_url` to open.
//   2. CLI/GUI opens browser_url; user signs in to the dashboard if
//      not already, types the user_code shown by their device, and clicks
//      Authorize. The browser URL alone cannot approve another device.
//   3. Dashboard calls /v1/auth/cli-authorize/bind-device-code with web-session
//      bearer auth plus the user_code; server mints a scoped API key and
//      stores only its encrypted envelope under `sha256(code)` (Redis,
//      2-minute bound TTL).
//   4. CLI/GUI polls /v1/auth/cli-authorize/exchange until status
//      flips from `pending` → `bound` → returns plaintext API key.
//
// `code` is a 32+ byte random URL-safe string. `state` is a CSRF nonce
// supplied by the CLI/GUI on initiate, echoed in the browser URL,
// verified by the dashboard on bind, and re-verified by the CLI/GUI
// on exchange — defends against the dashboard binding a code that
// wasn't issued in the same session. The separate 40-bit `user_code`
// is never placed in the URL and proves access to the initiating device.

import { z } from 'zod';
import { ApiKeyScopeListRequestSchema, Iso8601Schema } from './common.js';

/** RFC 8628-style device verification code. Ambiguous I/O/0/1 symbols are
 * excluded; input is normalized so customers can type lowercase safely. */
export const CliAuthorizeUserCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

// ─── /v1/auth/cli-authorize/initiate ──────────────────────────────

export const CliAuthorizeInitiateRequestSchema = z.object({
  /** Client-supplied CSRF nonce — echoed back in the browser URL and
   *  re-verified at exchange time. Min 16 chars of URL-safe entropy
   *  (the CLI/GUI generates this via crypto-random). */
  state: z.string().min(16).max(128),
  /** Human-friendly label that appears on the dashboard's confirmation
   *  screen ("Driftstack desktop app on John's MacBook Pro") so the
   *  user knows what they're authorizing. */
  client_label: z.string().min(1).max(120).optional(),
});
export type CliAuthorizeInitiateRequest = z.infer<typeof CliAuthorizeInitiateRequestSchema>;

export const CliAuthorizeInitiateResponseSchema = z.object({
  /** One-shot opaque device code; never displayed to the user. */
  code: z.string(),
  /** Separate code displayed in the initiating app and typed into the
   *  dashboard. A copied browser URL is insufficient to authorize. */
  user_code: CliAuthorizeUserCodeSchema,
  /** URL the CLI/GUI opens in the system browser. The dashboard's
   *  /cli/authorize page reads `code` + `state` from the query string. */
  browser_url: z.string().url(),
  /** Wall-clock expiry of the code; the CLI/GUI gives up polling after this. */
  expires_at: Iso8601Schema,
});
export type CliAuthorizeInitiateResponse = z.infer<typeof CliAuthorizeInitiateResponseSchema>;

// ─── /v1/auth/cli-authorize/bind-device-code (web-session auth required) ───

export const CliAuthorizeBindRequestSchema = z.object({
  code: z.string().min(16).max(128),
  state: z.string().min(16).max(128),
  /** Must match the separate verification code shown by the device. */
  user_code: CliAuthorizeUserCodeSchema,
  /** Scopes to attach to the minted API key. Defaults to
   *  ["account_owner"] server-side if omitted. */
  scopes: ApiKeyScopeListRequestSchema.optional(),
});
export type CliAuthorizeBindRequest = z.infer<typeof CliAuthorizeBindRequestSchema>;

export const CliAuthorizeBindResponseSchema = z.object({
  ok: z.literal(true),
  /** Echoed for the dashboard's confirmation UI ("Authorized as
   *  acc_…"). The plaintext key NEVER returns through this endpoint —
   *  only the CLI/GUI receives it via /exchange. */
  account_id: z.string(),
  expires_at: Iso8601Schema,
});
export type CliAuthorizeBindResponse = z.infer<typeof CliAuthorizeBindResponseSchema>;

// ─── /v1/auth/cli-authorize/exchange ───────────────────────────────

export const CliAuthorizeExchangeRequestSchema = z.object({
  code: z.string().min(16).max(128),
  state: z.string().min(16).max(128),
});
export type CliAuthorizeExchangeRequest = z.infer<typeof CliAuthorizeExchangeRequestSchema>;

/**
 * `pending` → keep polling. `bound` → key delivered (one-shot; the
 * server deletes the code on delivery, so a subsequent poll returns
 * `{ status: 'expired' }` with HTTP 200). `expired` → user took too
 * long (or already collected the key); restart the flow.
 */
export const CliAuthorizeExchangeStatusSchema = z.enum(['pending', 'bound', 'expired']);
export type CliAuthorizeExchangeStatus = z.infer<typeof CliAuthorizeExchangeStatusSchema>;

export const CliAuthorizeExchangePendingResponseSchema = z.object({
  status: z.literal('pending'),
});
export const CliAuthorizeExchangeBoundResponseSchema = z.object({
  status: z.literal('bound'),
  api_key: z.string(),
  account_id: z.string(),
});
export const CliAuthorizeExchangeExpiredResponseSchema = z.object({
  status: z.literal('expired'),
});

export const CliAuthorizeExchangeResponseSchema = z.discriminatedUnion('status', [
  CliAuthorizeExchangePendingResponseSchema,
  CliAuthorizeExchangeBoundResponseSchema,
  CliAuthorizeExchangeExpiredResponseSchema,
]);
export type CliAuthorizeExchangeResponse = z.infer<typeof CliAuthorizeExchangeResponseSchema>;
