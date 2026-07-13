/**
 * Keep copyable crash details useful without putting credentials, customer
 * endpoints, or the operator's local username on screen. Raw exceptions stay
 * in the local developer log; this helper is only for rendered diagnostics.
 *
 * Redact before bounding so a secret cannot straddle the truncation edge.
 */
export function sanitizeUiDiagnostic(
  value: unknown,
  fallback = '(no additional details)',
  maxChars = 4_000,
): string {
  let text: string;
  try {
    if (typeof value === 'string') text = value;
    else if (value instanceof Error) text = value.message;
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      text = String(value);
    } else text = '';
  } catch {
    return fallback;
  }

  text = text.trim();
  if (text === '') return fallback;

  const redacted = text
    // Authorization headers and inline auth diagnostics.
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    // URL userinfo (https://user:password@example.test/path).
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    // Credential-shaped query/fragment parameters.
    .replace(
      /([?&#](?:api[_-]?key|access[_-]?token|auth(?:orization)?|code|password|secret|session|token)=)[^&#\s"')]+/gi,
      '$1[redacted]',
    )
    // Quoted JSON/config values may contain spaces; consume through the matching quote.
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|session[_-]?(?:id|token)|token)["']?)\s*[:=]\s*)(["'])[^\r\n]*?\2/gi,
      '$1$2[redacted]$2',
    )
    // Common key/value and JSON-style credential diagnostics.
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|session[_-]?(?:id|token)|token)["']?)\s*[:=]\s*["']?)(?!\[redacted\])[^\s,;"'}\]]+/gi,
      '$1[redacted]',
    )
    // Operator usernames in native stack paths; retain the useful relative tail.
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '~')
    // Private/loopback node addresses do not belong in screenshots or support copy.
    .replace(
      /\b(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
      '[private-host]',
    )
    .replace(/\[(?:::1|fc[0-9a-f:]+|fd[0-9a-f:]+)\]/gi, '[private-host]')
    .replace(
      /\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|lan|local|private))(?::\d+)?\b/gi,
      '[private-host]',
    );

  const safeLimit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 4_000;
  return redacted.length > safeLimit ? `${redacted.slice(0, safeLimit)}…` : redacted;
}
