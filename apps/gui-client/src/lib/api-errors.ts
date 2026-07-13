// Shared boundary for turning API failures into fixed customer-safe copy.
// Problem `type` is contractual; `detail` and `title` are diagnostic input and
// must never be reflected into the installed client.

import { readBoundedDiagnosticJson } from './read-bounded-json';

/**
 * Best-effort parse a fetch Response's bounded problem body, then map its stable
 * type and HTTP status to fixed actionable copy. Unknown bodies are classified
 * only by status; upstream prose is never reflected.
 */
export async function readApiErrorMessage(res: Response): Promise<string> {
  let problemType = '';
  try {
    // Older hook tests use structural response doubles with json() but no
    // body/headers. A real fetch Response always has a body property, so only
    // production responses take the bounded stream path.
    const body =
      (res as { body?: ReadableStream<Uint8Array> | null }).body === undefined
        ? ((await res.json()) as { type?: unknown })
        : await readBoundedDiagnosticJson<{ type?: unknown }>(res);
    if (typeof body.type === 'string' && body.type.startsWith(PROBLEM_TYPE_PREFIX)) {
      problemType = body.type;
    }
  } catch {
    /* Invalid or oversized body; classify from the status only. */
  }
  return fixedApiErrorMessage(problemType, res.status);
}

const PROBLEM_TYPE_PREFIX = 'https://errors.driftstack.dev/';

function fixedApiErrorMessage(problemType: string, status: number): string {
  const kind = problemType.startsWith(PROBLEM_TYPE_PREFIX)
    ? problemType.slice(PROBLEM_TYPE_PREFIX.length)
    : '';
  const exact: Record<string, string> = {
    'email-already-registered': 'An account with this email already exists. Sign in instead.',
    'email-not-verified': 'Verify your email address before signing in.',
    'invalid-credentials': 'The email or password was not accepted.',
    'invalid-auth-token': 'This sign-in link is invalid, expired, or already used.',
    'legal-acceptance-required': 'Review and accept the required terms before continuing.',
    'mfa-step-up-required': 'Confirm this action with a fresh authenticator code.',
    'profile-in-use': 'End the profile’s other live session before launching it again.',
    'proxy-validation-failed': 'The proxy could not be verified. Check its details and try again.',
    'storage-quota-exceeded': 'Profile storage is full. Trim or delete a profile, then try again.',
    'byok-anthropic-required': 'Connect your AI provider key in Settings, then try again.',
    'bundled-llm-consent-required':
      'Enable bundled AI in Settings or connect your own provider key.',
    'bundled-llm-budget-exhausted':
      'Your monthly AI budget has been reached. Review it in Settings.',
  };
  if (Object.prototype.hasOwnProperty.call(exact, kind)) {
    return exact[kind] ?? 'The request could not be completed.';
  }
  if (['unauthorized', 'invalid-key', 'revoked-key', 'expired-key'].includes(kind)) {
    return 'Your sign-in or API key was not accepted. Check Settings and try again.';
  }
  if (['rate-limited', 'concurrency-limit', 'tier-limit'].includes(kind)) {
    return 'A usage limit was reached. Wait a moment or review your plan, then try again.';
  }
  if (['bad-request', 'validation-failed'].includes(kind)) {
    return 'Some information was not accepted. Check your input and try again.';
  }
  if (['conflict', 'pair-mode-conflict', 'pair-mode-invalid-transition'].includes(kind)) {
    return 'The item changed or is busy. Refresh and try again.';
  }
  if (kind === 'not-found') return 'The requested item was not found. Refresh and try again.';
  if (kind === 'forbidden') return 'You do not have permission to perform this action.';
  if (kind === 'session-destroyed') return 'This session has ended and can no longer be used.';
  if (kind === 'session-timeout') return 'The session took too long to respond. Try again.';
  if (['driver-error', 'driver-not-integrated', 'feature-unavailable', 'internal'].includes(kind)) {
    return 'The service is temporarily unavailable. Try again shortly.';
  }

  if (status === 401) {
    return 'Your sign-in or API key was not accepted. Check Settings and try again.';
  }
  if (status === 403) return 'You do not have permission to perform this action.';
  if (status === 404) return 'The requested item was not found. Refresh and try again.';
  if (status === 409) return 'The item changed or is busy. Refresh and try again.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The service is temporarily unavailable. Try again shortly.';
  return 'The request could not be completed. Check your input and try again.';
}
