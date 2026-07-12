/** True for LiveKit/WebRTC errors produced by harmless teardown or reconnect races. */
export function isBenignTeardownError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /PC manager is closed|client initiated disconnect|engine (is )?closed|not connected|Publisher connection not set|could not establish Publisher connection/i.test(
    message,
  );
}
