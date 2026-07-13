/** Maximum raw payload accepted from tiny GUI diagnostic endpoints. */
export const DIAGNOSTIC_JSON_MAX_BYTES = 64 * 1024;
/** Keep GUI API JSON aligned with the official SDK response ceiling. */
export const API_JSON_MAX_BYTES = 8 * 1024 * 1024;

export class DiagnosticResponseTooLargeError extends Error {
  constructor() {
    super('The diagnostic response was too large.');
    this.name = 'DiagnosticResponseTooLargeError';
  }
}

export class ApiResponseTooLargeError extends Error {
  constructor() {
    super('The API response was too large.');
    this.name = 'ApiResponseTooLargeError';
  }
}

async function readBoundedJson<T>(
  response: Response,
  maxBytes: number,
  tooLarge: () => Error,
  emptyMessage: string,
): Promise<T> {
  // Structural test doubles created before the stream contract may expose
  // json() without a body property. A real fetch Response always exposes body
  // as ReadableStream|null, so production decoding still always goes bounded.
  if ((response as { body?: ReadableStream<Uint8Array> | null }).body === undefined) {
    return response.json() as Promise<T>;
  }

  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) throw new SyntaxError(emptyMessage);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Decode a JSON response without ever buffering more than the diagnostic cap.
 * The caller owns the request AbortController and keeps its deadline armed
 * through this function, so a stalled stream follows the existing timeout path.
 */
export async function readBoundedDiagnosticJson<T>(response: Response): Promise<T> {
  return readBoundedJson(
    response,
    DIAGNOSTIC_JSON_MAX_BYTES,
    () => new DiagnosticResponseTooLargeError(),
    'Diagnostic response body is empty.',
  );
}

/** Decode a normal API JSON response within the cross-SDK 8 MiB ceiling. */
export async function readBoundedApiJson<T>(response: Response): Promise<T> {
  return readBoundedJson(
    response,
    API_JSON_MAX_BYTES,
    () => new ApiResponseTooLargeError(),
    'API response body is empty.',
  );
}
