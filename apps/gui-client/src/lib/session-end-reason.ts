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
 * ⛔ `tunnel_setup_timeout` deliberately has NO destination. "We cannot tell
 * whether this is you or them" is a real state, and a product that guesses
 * there sends people to their provider for our own bug.
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
