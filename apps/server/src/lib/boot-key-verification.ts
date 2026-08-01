// Boot-time encryption-key verification, with an error an operator can act on.
//
// Every envelope migration in `bootstrap` opens with a probe: read one already-
// encrypted row with the configured key and throw if it cannot be decrypted.
// That check is deliberate and correct — it refuses to serve with unreadable
// secrets, and it fires precisely when a key no longer matches the data.
//
// What it did NOT do is say so. Rotating a key produced this, and nothing else:
//
//   "msg":"bootstrap failed — exiting"
//   "message":"Unsupported state or unable to authenticate data"
//
// That is a raw Node crypto error. It never mentions a key, an env var, or
// which subsystem failed; the only clue is a stack frame. An operator meets it
// during a key rotation — by definition the moment they are least able to guess
// — and has to infer the cause from the trace.
//
// This wrapper changes the message and nothing else.
//
// TWO INVARIANTS, both load-bearing, both guarded:
//
//   1. It NEVER swallows. A failing probe still throws, so the server still
//      refuses to boot. A wrapper that converted a loud failure into a silent
//      one would be strictly worse than the cryptic message it replaced — which
//      is exactly why this was written as its own function with its own tests
//      rather than inlined nine times.
//   2. It NEVER names the key. The message carries the subsystem and the env
//      var to check; the key material and any decrypted plaintext stay out of
//      it. The original error is attached as `cause` on the thrown Error.
//
// One thing this deliberately does NOT do, verified by running a real rotation
// rather than assumed: the underlying crypto text does not reach the log. Pino's
// default error serializer emits name/message/stack/type and drops `cause`, so
// "Unsupported state or unable to authenticate data" is no longer in the boot
// output. That is acceptable — the replacement message states the cause and the
// remedy, which the crypto string never did — but it IS a trade, and the earlier
// draft of this comment claimed the detail was still logged, which was wrong.
// Quoting the cause into the message instead was rejected: an underlying error
// is not guaranteed to be free of data, and this wrapper sits on paths that
// handle credentials.

/**
 * Run a boot-time key-verification probe, rethrowing any failure with an
 * actionable message.
 *
 * @param subsystem human-readable name of what could not be read
 * @param envVar the environment variable holding the key for that subsystem
 * @param probe the read that authenticates the key; throws on mismatch
 */
export function verifyBootEncryptionKey(
  subsystem: string,
  envVar: string,
  probe: () => void,
): void {
  try {
    probe();
  } catch (cause) {
    throw new Error(
      `${subsystem}: stored data could not be decrypted with the configured ${envVar}. ` +
        `The key does not match the data already in this database — most often because ` +
        `it was rotated without re-encrypting the existing rows. The server is refusing ` +
        `to start rather than serve with unreadable secrets; restore the previous ` +
        `${envVar} to boot.`,
      { cause },
    );
  }
}
