// V-326c — shared parser for the `X-Driftstack-Account` team-RBAC
// header.
//
// 7 routes consume this header for team-RBAC effective-account
// resolution:
//
//   - apps/server/src/routes/admin.ts
//   - apps/server/src/routes/webhooks.ts
//   - apps/server/src/routes/profiles.ts
//   - apps/server/src/routes/profile-snapshots.ts
//   - apps/server/src/routes/account-audit.ts
//   - apps/server/src/routes/sessions.ts
//   - apps/server/src/routes/email-preferences.ts
//
// Previously each route hand-rolled an identical `readEffectiveAccountHeader`
// helper. Extracted to one place so:
//   1. Drift on any one route can be caught by a parity test.
//   2. Future safety improvements (e.g. the empty-string
//      normalisation below) land everywhere at once.
//
// The empty-string normalisation matches the slice 105 BYOK fix
// pattern. Without it a customer sending `X-Driftstack-Account:`
// (empty value) would pass `""` to `resolveEffectiveAccount`, which
// happens to fall back to self-scope correctly today — but relying
// on downstream behaviour is fragile. Normalising at the read site
// pins the contract: empty header is indistinguishable from absent.

import type { FastifyRequest } from 'fastify';

export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';

/**
 * Read the `X-Driftstack-Account` team-RBAC effective-account header.
 *
 * Returns the raw account-id string (`acc_<uuid>`) when present, or
 * `undefined` when the header is absent OR empty / whitespace-only.
 *
 * Fastify presents duplicate headers as an array — first wins.
 */
export function readEffectiveAccountHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[EFFECTIVE_ACCOUNT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
