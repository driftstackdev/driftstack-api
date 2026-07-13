export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Fetch with a timer-cleaned deadline while preserving an optional caller signal. */
export function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  const forwardAbort = (): void => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) forwardAbort();
  else upstream?.addEventListener('abort', forwardAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    globalThis.clearTimeout(timer);
    upstream?.removeEventListener('abort', forwardAbort);
  });
}
