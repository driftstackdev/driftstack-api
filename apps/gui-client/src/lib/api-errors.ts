// V-534.BV — shared helper for surfacing the server's problem+json
// detail in GUI error states. The Driftstack API returns RFC 7807
// problem+json bodies on 4xx; without this helper, hooks would
// surface only "HTTP 400" which is unhelpful.

import { readBoundedDiagnosticJson } from './read-bounded-json';

/**
 * Best-effort parse a fetch Response's body into a human-readable
 * error message. Tries problem+json (.detail then .title) first,
 * falls back to "HTTP <status>" if the body isn't JSON or doesn't
 * carry either field.
 */
export async function readApiErrorMessage(res: Response): Promise<string> {
  try {
    // Older hook tests use structural response doubles with json() but no
    // body/headers. A real fetch Response always has a body property, so only
    // production responses take the bounded stream path.
    const body =
      (res as { body?: ReadableStream<Uint8Array> | null }).body === undefined
        ? ((await res.json()) as { detail?: unknown; title?: unknown })
        : await readBoundedDiagnosticJson<{ detail?: unknown; title?: unknown }>(res);
    if (typeof body.detail === 'string' && body.detail.length > 0) return body.detail;
    if (typeof body.title === 'string' && body.title.length > 0) return body.title;
  } catch {
    /* body wasn't JSON; fall through */
  }
  // Shared across the dashboard + admin panel (not just the live-session GUI); the
  // server almost always sends a friendly problem+json `detail`, and where it
  // doesn't the bare status is a useful debugging signal for those surfaces. The
  // founder's "no raw codes in the operator's face" applies to the live Simulator
  // surface, which friendly-izes its own copy (page-error-copy / friendlyConnectError).
  return `HTTP ${res.status.toString()}`;
}
