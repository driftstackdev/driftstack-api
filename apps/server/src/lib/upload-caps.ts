// Default upload caps for the agent-session file endpoints.
//
// These were inline literals in the route's default parameters. Naming them
// buys two things:
//
//   • the docs-agreement guard can IMPORT them instead of regex-parsing
//     `sessionUploadMaxLifetimeBytes = ([\d\s*]+),` out of the route source,
//     which a prettier reflow of that parameter list would have silently
//     broken;
//   • the defaults become assertable on their own. Every behavioural arm over
//     these caps INJECTS a small value (that is the only way to drive a
//     rejection without moving gigabytes), so nothing exercised the defaults —
//     which is why doubling the lifetime cap once left the whole suite green.
//
// The per-account cap is additionally operator-configurable
// (AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES → config → bootstrap → app →
// route); these are the values that apply when it is unset.

/**
 * Decoded size of a single uploaded file — the absolute CEILING, not what a
 * device takes. An upload reaches the device as one message, and each device
 * reads messages up to its own limit (4 MiB unless its heartbeat advertises
 * more), so the size a session actually accepts is the smaller of this and what
 * fits that device's message after base64 and the envelope. See
 * services/device-frame-guard.ts; the route answers 413 above that.
 */
export const UPLOAD_MAX_FILE_BYTES_DEFAULT = 64 * 1024 * 1024;

/** Concurrent in-flight upload volume per ACCOUNT, across sessions. */
export const UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES_DEFAULT = 512 * 1024 * 1024;

/** Total upload volume per SESSION over its lifetime; never released. */
export const SESSION_UPLOAD_MAX_LIFETIME_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024;
