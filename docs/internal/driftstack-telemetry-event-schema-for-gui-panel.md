# GUI panel telemetry event schema

**Status:** v0 scaffold (2026-05-20). Bus + types implemented; SSE
endpoint scoped for a follow-up slice once the first concrete
publisher (cost-alert) demonstrates the shape on the log channel.

## Why

The desktop GUI client's surface area has grown past what poll-and-
diff can support comfortably:

- **Cost-threshold transitions** (V-541.C) fire today as structured
  `cost.threshold_alert` log lines. Customers don't see them unless
  they grep the server logs.
- **Account lifecycle events** (V-202b/c) drop into the audit log
  and the email channel; the GUI has no panel-level surface.
- **Incident broadcasts** (V-295e) have an SSE channel for the
  status page; the GUI doesn't subscribe.

A single notification stream lets the GUI render one consolidated
"What's happening on your account right now" panel without N
poll-loops fighting each other.

## Scope (v0 — this scaffold)

- `NotificationEvent` discriminated union covering the four kinds
  the GUI cares about today.
- `NotificationEventBus` — in-process pub/sub mirroring the
  `AgentSessionEventBus` shape (Arc 2 sub-slice 8.3) so a future
  Redis-backed implementation drops in without changing call sites.
- Customer publishes are **per-account** (subscribers register by
  `accountId`); cross-account leakage is impossible by construction
  because the subscriber map is keyed on `accountId`.

## Out of scope (v0.1+)

- SSE route at `GET /v1/account/me/notifications`. Auth, retry-after
  framing, Last-Event-ID resume, and per-account rate-limit
  decisions all need their own design pass. Until that lands the
  bus is consumed only by the SSE route's stub (returns 503 with
  `feature_unavailable` problem-type — same posture as billing /
  byok-anthropic when the upstream isn't wired).
- Persistence — the bus is in-memory only. SSE consumers replay
  from a small ring buffer (sized at first-publisher wire-up); the
  durable audit log remains the source of truth for compliance.
- Mobile / web-dashboard subscribers — v0 targets the desktop GUI.

## Event kinds (v0)

```ts
type NotificationEvent =
  | {
      kind: 'cost.threshold_alert';
      accountId: string;
      severity: 'warn' | 'critical' | 'resolved';
      billingCycle: string;
      previousState: ThresholdState | null;
      currentState: ThresholdState;
      totalCents: number;
      thresholdSoftCents: number;
      thresholdHardCents: number;
      at: string; // ISO8601 — server publish time
    }
  | {
      kind: 'incident.broadcast';
      accountId: string;
      incidentId: string;
      severity: 'minor' | 'major' | 'outage'; // matches IncidentSeverity (S45 doc fix: was 'critical' — the shipped union has always used 'outage')
      title: string;
      at: string;
    }
  | {
      kind: 'audit.high_severity';
      accountId: string;
      action: string; // canonical audit action enum
      actorType: 'customer' | 'admin' | 'system';
      targetResourceId: string | null;
      at: string;
    }
  | {
      kind: 'session.errored';
      accountId: string;
      sessionId: string;
      errorClass: string; // 'driver_error' | 'timeout' | …
      at: string;
    };
```

## Bus shape

Mirrors `AgentSessionEventBus`: subscribers register with a handler,
get an unsubscribe function, publishes are best-effort (one handler's
throw can't block siblings or the publisher).

```ts
class NotificationEventBus {
  subscribe(accountId: string, handler: NotificationEventHandler): () => void;
  publish(event: NotificationEvent): void;
  subscriberCount(accountId: string): number;
}
```

## First publisher: cost-alert dispatcher

The 2026-05-20 cost-nightly wire-up (e52cb092) currently has
`sendAlert` as a logger-only sink. The v0.1 follow-up will dual-wire:

```ts
sendAlert: (alert) => {
  logger.info(/* …structured cost.threshold_alert line… */);
  notificationBus.publish({
    kind: 'cost.threshold_alert',
    accountId: alert.account_id,
    severity: alert.severity,
    // … (mapped one-to-one from the dispatcher's payload)
    at: new Date().toISOString(),
  });
  return Promise.resolve();
};
```

The logger sink stays — ops still want to grep `cost.threshold_alert`
on the production journal independent of the customer-facing channel.

## Future publishers (catalogue)

- ~~`incident-broadcast.ts` — duplicate the V-295e `IncidentEventBus`
  publish into the per-affected-account notification stream when an
  incident's `customer_visible` flag flips true.~~ **SHIPPED S45
  2026-07-07** — implemented in `lib/bootstrap.ts` (not
  incident-broadcast.ts, which stays Slack/outbound-only): every
  public-incident lifecycle hook (created / updated / resolved) calls
  `notificationEventBus.publishBroadcast` with the
  `'incident.broadcast'` frame, fanning out to every account with a
  live subscriber (per-subscriber `accountId` stamping — see
  `publishBroadcast` in notification-event-bus.ts).
- `account-audit.ts` — selective republish for audit actions whose
  catalog entry has `severity >= 'high'` (e.g. `api_key.revoked`,
  `byok_anthropic.key_set`, `team.member_removed`). Most low-severity
  actions stay in the audit log only.
- `agent-runtime.ts` — republish session-error events when the
  driver fails (`session.errored` kind above).

## Non-goals

- The notification bus is **not** a job queue. Publishes that have
  no live subscribers are dropped. Durable workflows must continue
  to use `scheduled_jobs` + the V-202d dispatcher.
- The bus does **not** replace the audit log. Audit is the legal /
  compliance trail; notifications are a UX surface.
- No backpressure / per-customer throttling in v0 — the SSE route
  layer in v0.1 will be the natural place to add that.

## Validation plan

- Unit tests: subscribe / publish / unsubscribe lifecycle + handler-
  throw isolation (mirror `agent-session-event-bus.test.ts`).
- Content-parity test: pin the event-kind discriminator list +
  bus method signatures so a refactor can't silently widen the
  schema without an explicit doc edit + new kind enumeration here.
- Cross-source-invariant test (v0.1): once the cost-alert publisher
  lands, pin that the dispatcher's `sendAlert` lambda publishes
  to the bus with the exact one-to-one field mapping above.
