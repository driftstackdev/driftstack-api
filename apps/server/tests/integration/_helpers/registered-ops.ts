// Read the routes Fastify actually registered, as "VERB /full/path".
//
// Every cross-account isolation suite carries a hand-written table of the routes
// it probes, and a table is only as complete as the last person to re-derive it.
// The tables have drifted three times on record — `/launch` and `/transfer` were
// missing from the profile table because they are registered in
// `routes/sessions.ts` rather than `routes/profiles.ts`; `POST /profiles/:id/
// snapshots` was missing for three more days because it APPEARS in an isolation
// file as fixture setup; and five agent-session routes were missing for the same
// reading-the-file reason. Reading the registration tree instead of the source
// text is what makes a census immune to all three: it does not care which file a
// route lives in, or which files mention its URL.
//
// Extracted here because the parser had been copied into two suites and was about
// to be copied into three more. Five copies of a parser is five things to fix when
// Fastify changes its tree format, and four chances for a copy to quietly stop
// agreeing with the others.
//
// ⚠️ The prefix a census filters on must match the REGISTERED path, parameter name
// included. Customer crypto-order routes are `/v1/billing/crypto-orders/:order_id`,
// not `:id` — a census written against `:id` matches nothing and passes while
// checking nothing. `assertCensusSaw` exists so that failure cannot be silent.

/**
 * Parse `app.printRoutes({ commonPrefix: false })` into a set of `VERB /path`.
 *
 * HEAD and OPTIONS are dropped: Fastify synthesises them, so they are not routes
 * anyone wrote and not routes an isolation table should have to account for.
 */
export function registeredOps(tree: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    if (raw.trim() === '') continue;
    const markerAt = raw.search(/[├└]/);
    const depth = markerAt < 0 ? 0 : Math.floor(markerAt / 4);
    const body = markerAt < 0 ? raw.trim() : raw.slice(markerAt + 4).trim();
    const m = /^(\S*?)\s*(?:\(([A-Z, ]+)\))?$/.exec(body);
    if (m === null) continue;
    stack.length = depth;
    stack[depth] = m[1] ?? '';
    if (m[2] === undefined) continue;
    const full =
      stack
        .slice(0, depth + 1)
        .join('')
        .replace(/\/$/, '') || '/';
    for (const method of m[2].split(',')) {
      const verb = method.trim();
      if (verb === 'HEAD' || verb === 'OPTIONS') continue;
      out.add(`${verb} ${full}`);
    }
  }
  return out;
}

/** Registered ops whose path sits under `base`, either exactly or as a sub-path. */
export function opsUnder(tree: string, base: string): string[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^[A-Z]+ ${escaped}(/|$)`);
  return [...registeredOps(tree)].filter((op) => re.test(op)).sort();
}

/**
 * Guard against the vacuous census.
 *
 * A prefix that matches nothing produces an empty registered set, an empty
 * `missing` list, and a green arm that verified nothing — the same shape as a
 * measurement taken with the wrong key. Every census calls this first so a typo in
 * the base path fails loudly instead of reporting success.
 */
export function assertCensusSaw(ops: readonly string[], base: string, atLeast: number): void {
  if (ops.length < atLeast) {
    throw new Error(
      `route census under "${base}" found ${String(ops.length)} routes, expected at least ` +
        `${String(atLeast)}. The base path or its parameter name is probably wrong ` +
        `(e.g. ":id" where the route registers ":order_id"), which would make this census ` +
        `pass while checking nothing.`,
    );
  }
}
