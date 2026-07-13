/** Close a fetch body that the caller intentionally does not consume. */
export async function disposeResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Disposal is best-effort and must not change the observed HTTP result.
  }
}
