/**
 * Convert low-level browser, Tauri, and API failures into safe customer copy.
 * Callers supply a task-specific fallback; known transport classes get a
 * consistent actionable explanation without exposing exception internals.
 */
export function humanizeError(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = `${name} ${message}`.toLowerCase();

  if (/abort|timed? out|timeout/.test(normalized)) {
    return 'The request took too long. Check your connection and try again.';
  }
  if (
    /failed to fetch|network(?:error| request)?|load failed|offline|internet|connection (?:failed|lost|refused)|dns/.test(
      normalized,
    )
  ) {
    return 'Check your connection and try again.';
  }
  if (/signature|checksum|integrity|verif(?:y|ied|ication)/.test(normalized)) {
    return "This download couldn't be verified. Try again later.";
  }
  const httpStatus = normalized.match(/\bhttp\s+(\d{3})\b/)?.[1];
  if (httpStatus !== undefined) {
    const status = Number(httpStatus);
    if (status === 401 || status === 403) {
      return 'Your sign-in or API key was not accepted. Check Settings and try again.';
    }
    if (status >= 500) return 'The service is temporarily unavailable. Try again shortly.';
    return "The request couldn't be completed. Check your input and try again.";
  }
  return fallback;
}
