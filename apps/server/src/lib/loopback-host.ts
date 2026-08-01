// Is this connection string pointed at a local throwaway, or at something real?
//
// Two places need this answer and must not disagree about it: the e2e harness,
// which DROPs the public schema of whatever DATABASE_URL names, and the dev
// seed, which mints a full-admin API key in whatever database it is handed.
// Both are safe against a local instance and severe anywhere else.
//
// The classification lives here rather than in either caller because two copies
// of a safety predicate is exactly the shape that drifted the session-lock key
// into two independent locks: one copy gets a new spelling of loopback, the
// other does not, and the weaker one is the one that matters.
//
// This module answers only "is this host loopback". It deliberately does NOT
// decide what to do about it — the e2e harness refuses outright, and the seed
// refuses with a different message and a different override name, because the
// two failures need different remedies in front of an operator.

/**
 * Hostnames that cannot be a managed or remote instance.
 *
 * Managed Postgres and Redis are never reachable on loopback, so this set is
 * what makes "local or nothing" a rule that cannot fire on a legitimate run and
 * cannot fail to fire on the accident.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * The hostname of a connection string.
 *
 * Throws on anything unparseable. An unidentifiable target is not evidence of
 * safety, and returning a placeholder here would make malformed input the way
 * past every check built on top of this.
 *
 * @param raw   the connection string
 * @param label the environment variable it came from, for the message
 */
export function hostOfConnectionString(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${label} is not a parseable URL, so its target cannot be confirmed to be a ` +
        `local throwaway. Refusing rather than guessing.`,
    );
  }
  return url.hostname.toLowerCase();
}

/**
 * Connection strings whose host is not loopback, as `[label, host]` pairs.
 * Empty when every target is local.
 */
export function nonLoopbackTargets(
  targets: ReadonlyArray<readonly [label: string, raw: string]>,
): Array<readonly [string, string]> {
  return targets
    .map(([label, raw]) => [label, hostOfConnectionString(raw, label)] as const)
    .filter(([, host]) => !isLoopbackHost(host));
}
