/**
 * Read an HTTP response as text without allowing an upstream to allocate an
 * unbounded buffer. The limit is measured in wire bytes, not UTF-16 string
 * length, so multi-byte input cannot evade the ceiling.
 */
export class ResponseBodyLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeded ${maxBytes.toString()}-byte limit`);
    this.name = 'ResponseBodyLimitError';
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (bytes > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ResponseBodyLimitError(maxBytes);
    }
  }

  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        throw new ResponseBodyLimitError(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}
