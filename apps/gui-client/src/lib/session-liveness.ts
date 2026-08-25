import type { AgentSession } from '@driftstack/sdk';

/**
 * What the header pill should say about a chat session, and how it should look.
 *
 * Split out of the JSX because the decision is genuinely subtle and every branch
 * of it is a claim we make to the customer about whether their session is alive.
 * Pure — no React, no clock, no I/O — so each branch is unit-testable.
 */
export interface SessionStateDescriptor {
  label: string;
  /** Drives colour only. `running` is the one worth an animated dot. */
  tone: 'running' | 'starting' | 'stopping' | 'ready' | 'error';
  /** Hover text — always says WHY, because the label alone is ambiguous. */
  title: string;
}

/**
 * ⛔ `status` IS NOT A LIVENESS SIGNAL, and this is the whole reason the
 * function exists. Per the SDK contract on `AgentSession.liveness`, `status`
 * stays `'active'` until the session is explicitly closed — **even if the
 * worker crashed or never started**. A badge reading `status === 'active'`
 * therefore reports "Running" for a dead session, which is worse than showing
 * nothing: it is the exact claim the customer would rely on.
 *
 * `liveness` is the worker-reported beat, and it is trustworthy only when
 * `fresh`. The SDK is explicit that ABSENT means "unknown, trust the binding" —
 * NOT "dead" — because deployments with no fleet control plane never populate
 * it. So absent, stale, and `state: null` all fall back to `status` rather than
 * contradicting it. We only ever let the beat OVERRULE `status` when the beat
 * is present, fresh, and has an actual state.
 */
export function describeAgentSessionState(
  session: AgentSession | null,
  aiReady: boolean,
): SessionStateDescriptor {
  if (session === null) {
    return aiReady
      ? { label: 'AI ready', tone: 'ready', title: 'Connected — the assistant is ready.' }
      : {
          label: 'Not connected',
          tone: 'error',
          title: 'No API key — connect one in Settings before sending.',
        };
  }

  if (session.status === 'closed') {
    return {
      label: 'Ended',
      tone: 'ready',
      title:
        session.closed_reason === null
          ? 'This session has ended.'
          : `This session has ended: ${session.closed_reason}`,
    };
  }

  const beat = session.liveness;
  if (beat !== undefined && beat.fresh && beat.state !== null) {
    switch (beat.state) {
      case 'active':
        return {
          label: 'Running',
          tone: 'running',
          title: 'A session is running now — the agent can act on this profile.',
        };
      case 'provisioning':
        return {
          label: 'Starting',
          tone: 'starting',
          title: 'The device is being prepared — this usually takes a few seconds.',
        };
      case 'idle':
        return {
          label: 'Idle',
          tone: 'starting',
          title: 'The session is up and waiting for your next message.',
        };
      case 'terminating':
        return { label: 'Stopping', tone: 'stopping', title: 'This session is shutting down.' };
    }
  }

  // No trustworthy beat. Report the BINDING, and say so in the hover text rather
  // than dressing an unverified session up as a confirmed-running one.
  if (session.status === 'paused') {
    return {
      label: 'Paused',
      tone: 'starting',
      title: 'This session is paused — send a message to resume it.',
    };
  }
  return {
    label: 'Session open',
    tone: 'starting',
    title: 'A session is open. Waiting on the device to report in.',
  };
}
