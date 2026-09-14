// Which reason a terminal session shows the customer, and what it says.
//
// ⛔ THIS LIVES IN lib/ FOR A REASON THAT COST A TEST RUN. It started inside
// AgentSessionPanel.tsx, which several suites `vi.mock` wholesale — so the
// selector imported from there was `undefined` at call time in every one of
// them, the call threw inside the status handler, and the session simply never
// latched as ended. Five arms went red at once and none of them mentioned this
// file. A pure function that a non-mocked module needs must not live in a
// component other tests replace.

/**
 * A3's typed VPN bring-up reasons (closed_reason), and the ONE thing each is
 * for: telling the customer WHERE to go. A tunnel that never came up sends them
 * to their provider, to their own config, or nowhere — and those are different
 * errands. Before this, every one of them reached the same sentence.
 *
 * ⛔ THE COARSE CODES DO NOT DO THIS FOR US, which is worth writing down because
 * it was offered as free. `proxy_connection_failed` matches the `/^proxy_/`
 * branch below and `egress_bind_failed` matches `/^egress_/`, and BOTH of those
 * branches return the identical "Connection route unavailable / The secure
 * connection route for this session could not be established." So the coarse
 * pair collapses to one sentence at the only place a customer reads it. The
 * fine reason is where the distinction survives.
 *
 * ⚠️ MATCHED AS WHOLE TOKENS, never by prefix or substring. A3 owns this enum
 * and will not reuse a value for a different meaning; matching loosely would
 * re-route on a value they add later that merely starts the same way.
 *
 * ⛔ `tunnel_setup_timeout` deliberately has NO destination HERE. "We cannot
 * tell whether this is you or them" is a real state, and a product that guesses
 * there sends people to their provider for our own bug. The ONE thing that can
 * honestly give it one is the phase the bring-up stalled in — see
 * `vpnBringupEndCopy`, which refines this code, and only this code, by
 * `lastPhase`.
 */
export const VPN_BRINGUP_END_COPY: Readonly<
  Record<string, { outcome: string; explanation: string }>
> = {
  remote_unresolved: {
    outcome: 'Proxy address did not resolve',
    explanation:
      'The address this proxy points at does not exist any more, so nothing could be dialled. This is on the side that supplies the proxy — the endpoint is offline or its address has changed.',
  },
  remote_refused: {
    outcome: 'Proxy refused the connection',
    explanation:
      'The proxy endpoint answered and refused. It is down, or the port has changed — one for whoever supplies it.',
  },
  remote_unreachable: {
    outcome: 'Proxy did not respond',
    explanation:
      'Nothing answered at the proxy endpoint. It is unreachable or something on the way is filtering it.',
  },
  remote_closed_during_setup: {
    outcome: 'Proxy hung up during setup',
    explanation:
      'The proxy endpoint accepted the connection and then closed it before the tunnel was up. One for whoever supplies it.',
  },
  tls_handshake_failed: {
    outcome: 'Proxy security handshake failed',
    explanation:
      'The endpoint answered but the encrypted handshake did not complete. Usually a certificate or tls-auth key in the config that no longer matches the server.',
  },
  config_rejected: {
    outcome: 'Proxy config was rejected',
    explanation:
      'The VPN software refused the configuration itself. Open the proxy and re-paste its config — Driftstack will offer to remove anything it no longer accepts.',
  },
  auth_failed: {
    outcome: 'Proxy rejected the credentials',
    explanation: 'The endpoint refused the username or password stored with this proxy.',
  },
  tunnel_setup_timeout: {
    outcome: 'Tunnel did not finish connecting',
    explanation:
      'The proxy endpoint answered but the tunnel never finished coming up in time. There is not enough to say yet whether that is the endpoint or the configuration.',
  },
  no_output: {
    outcome: 'Tunnel could not be started',
    explanation:
      'The VPN software did not start on our side, so nothing was attempted. This one is ours, not yours.',
  },
};

/** True when this reason is one of A3's typed bring-up codes — i.e. the value
 *  that actually carries an errand. Exported for the CALLER that chooses which
 *  of two reasons to hand in; see `preferTypedEndReason`. */
export function isTypedBringupReason(reason: string | null | undefined): boolean {
  const normalized = reason?.trim().toLowerCase().replaceAll('-', '_') ?? '';
  return normalized !== '' && Object.hasOwn(VPN_BRINGUP_END_COPY, normalized);
}

/** Whose errand a stalled bring-up phase is. */
export type VpnBringupRoute = 'provider' | 'config' | 'ours';

/**
 * A3's bring-up PHASES (the `provisioning_detail` frame, emitted each time it
 * changes) and whose side each one is on. A `tunnel_setup_timeout` on its own
 * says nothing about who stalled; the phase it stalled IN does — the endpoint
 * had not answered yet (provider), the handshake hung (config), or the
 * handshake was done and OUR side did not finish bringing the session up
 * (ours).
 *
 * ⚠️ MATCHED AS WHOLE TOKENS, EXACTLY AS A3 SPELLS THEM: bare, lowercase, no
 * `vpn_` prefix, no case-folding, no hyphen aliasing — stricter than the reason
 * normalisation above, on purpose, because the failure direction of a miss is
 * the routeless sentence, which is the honest one. A phase this build does not
 * know routes NOWHERE.
 *
 * `up` is CONCEPTUAL, never an emitted token (settled with A3 2026-09-14), so
 * it is deliberately absent — routing on it would be aliasing. The token a
 * tunnel-up session actually leaves in `provisioning_detail` is the existing
 * `vpn_egress_active` frame, and a timeout whose last detail is THAT one means
 * "the tunnel was up and the browser never came" — ours, beside the four
 * post-handshake phases. It keeps its `vpn_` prefix here because that is its
 * spelling on the wire; it is not a bare phase with a prefix added.
 */
export const VPN_BRINGUP_PHASE_ROUTE: Readonly<Record<string, VpnBringupRoute>> = {
  resolving: 'provider',
  connecting: 'provider',
  handshaking: 'config',
  assigning_address: 'ours',
  configuring_routes: 'ours',
  starting_proxy: 'ours',
  verifying: 'ours',
  vpn_egress_active: 'ours',
};

/** The route for a last phase, or null when the phase is absent or not one we
 *  know. Own-key, exact-spelling lookup — never prefix, substring, or the
 *  prototype chain. */
export function vpnBringupPhaseRoute(lastPhase: string | null | undefined): VpnBringupRoute | null {
  if (typeof lastPhase !== 'string' || !Object.hasOwn(VPN_BRINGUP_PHASE_ROUTE, lastPhase)) {
    return null;
  }
  const route = VPN_BRINGUP_PHASE_ROUTE[lastPhase];
  return route === undefined ? null : route;
}

/**
 * The three sentences a `tunnel_setup_timeout` can become once the stalled
 * phase is known. Same outcome label as the routeless entry — what changed is
 * not what happened but whose errand it is, and that lives in the explanation.
 * Each names only what its phase supports: before `handshaking` the endpoint
 * had not answered; past `handshaking` the handshake was done (A3 emits the
 * phases in order, so `assigning_address` and later imply it), and the tunnel
 * itself may have been up (`vpn_egress_active`) — so "ours" says the SESSION
 * did not come up, not the tunnel. `handshaking` claims nothing about an
 * answer: over UDP (WireGuard always, OpenVPN usually) a dead endpoint and a
 * key the server drops are the same silence, and nothing in A3's contract
 * says the phase waits for a reply before it is emitted. The route (config)
 * is A3's; the sentence only stops asserting a fact the phase cannot carry.
 */
export const TUNNEL_SETUP_TIMEOUT_ROUTED_COPY: Readonly<
  Record<VpnBringupRoute, { outcome: string; explanation: string }>
> = {
  provider: {
    outcome: 'Tunnel did not finish connecting',
    explanation:
      'The tunnel timed out before the proxy endpoint answered — its address was still being looked up or the connection was still being opened. This is on the side that supplies the proxy.',
  },
  config: {
    outcome: 'Tunnel did not finish connecting',
    explanation:
      'The encrypted handshake with the proxy endpoint never completed in time. That points at the config — a key or protocol the server does not accept is dropped silently rather than refused. Open the proxy and check its config.',
  },
  ours: {
    outcome: 'Tunnel did not finish connecting',
    explanation:
      'The proxy endpoint answered and the handshake completed, but our side did not finish bringing the session up in time. This one is ours, not yours.',
  },
};

/**
 * The typed bring-up sentence for a reason, or undefined when the reason is not
 * one of A3's codes (the caller falls through to its coarse branches). Own-key
 * lookup: a reason spelled like a prototype member (`constructor`) is unknown,
 * not Object.prototype's function.
 *
 * `lastPhase` refines `tunnel_setup_timeout` and NOTHING ELSE. Every other code
 * already carries its destination, and a phase must never re-route a code that
 * has one — `remote_unresolved` with a `lastPhase` of `verifying` is still the
 * provider's errand. Absent or unknown phase → today's routeless sentence,
 * unchanged.
 *
 * `lastPhase` is DERIVED by the caller, not a wire field: A3 sends no
 * `last_phase` (`ApiSession` and the server's session serialisation have none),
 * so the window hands over the last `provisioning_detail` its status polls
 * observed (`derivedLastPhase`, SimulatorWindow). A poll can lag the daemon, so
 * the value is "the last phase we SAW", which the routeless fallback cannot
 * distinguish from the true last phase — this function trusts what it is given.
 *
 * The phase enters HERE rather than in `preferTypedEndReason` because it never
 * changes WHICH reason wins, only what one of them says.
 */
export function vpnBringupEndCopy(
  reason: string | null | undefined,
  lastPhase: string | null | undefined,
): { outcome: string; explanation: string } | undefined {
  if (!isTypedBringupReason(reason)) return undefined;
  const normalized = reason?.trim().toLowerCase().replaceAll('-', '_') ?? '';
  const base = VPN_BRINGUP_END_COPY[normalized];
  if (base === undefined || normalized !== 'tunnel_setup_timeout') return base;
  const route = vpnBringupPhaseRoute(lastPhase);
  return route === null ? base : TUNNEL_SETUP_TIMEOUT_ROUTED_COPY[route];
}

/**
 * Which of the two reasons a terminal session carries should reach the customer.
 *
 * ⛔ THE OBVIOUS ORDER IS THE WRONG ONE, and it was the shipped one:
 * `errorEvent?.code ?? closedReason` prefers the COARSE code. A failed VPN
 * bring-up emits both — a coarse `proxy_connection_failed` / `egress_bind_failed`
 * on the error event, and the FINE reason on the status frame — so the coarse
 * value would have shadowed the fine one at every call site, and the ten typed
 * sentences would never have rendered once. The table would have looked correct,
 * its tests would have passed, and the customer would have kept reading "the
 * secure connection route could not be established" forever.
 *
 * The coarse code exists to drive the control plane's retry logic
 * (customerActionable / retryable). It was never meant to carry the errand. So
 * the fine reason wins WHENEVER it is one we know, and the coarse code keeps
 * every other case exactly as before.
 */
export function preferTypedEndReason(
  errorCode: string | null | undefined,
  closedReason: string | null | undefined,
): string | null {
  if (isTypedBringupReason(closedReason)) return closedReason ?? null;
  return errorCode ?? closedReason ?? null;
}
