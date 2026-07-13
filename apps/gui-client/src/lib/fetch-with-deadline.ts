export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Fetch with a deadline that remains active while callers consume the response body. */
export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const cleanup = (): void => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timer = undefined;
    }
    upstream?.removeEventListener('abort', forwardAbort);
  };
  const abort = (reason?: unknown): void => {
    if (reason === undefined) controller.abort();
    else controller.abort(reason);
    cleanup();
  };
  const forwardAbort = (): void => abort(upstream?.reason);

  timer = globalThis.setTimeout(abort, timeoutMs);
  if (upstream?.aborted === true) forwardAbort();
  else upstream?.addEventListener('abort', forwardAbort, { once: true });

  try {
    // Do not clean up when headers arrive: aborting this controller also terminates
    // a stalled Response body. Cleanup happens on the deadline/caller abort, or on
    // a fetch failure before a Response is returned.
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    cleanup();
    throw error;
  }
}
