---
layout: ../../layouts/DocLayout.astro
title: Sentry integration
description: Where Sentry sits in Driftstack today — nothing to configure on our side — and how to instrument the page you automate so its errors land in your own Sentry project.
---

# Sentry integration

> **Status:** there is no customer-configurable Sentry forwarding on
> the Driftstack control plane today. The dashboard has no Sentry DSN
> setting, `POST /v1/sessions` accepts no Sentry-related field, and
> Driftstack does not fan events out to customer Sentry projects.
> This page explains what Sentry does on Driftstack's side, and the
> pattern that works today if you want in-page stack traces.

## Where Sentry sits today

Driftstack uses Sentry for its **own** server-side error tracking —
crashes and failures inside the Driftstack API, not inside your
automations. Before any event leaves our infrastructure, a scrubbing
pass redacts sensitive values (authorization headers, cookies,
passwords, API keys, signing and TOTP secrets, OAuth tokens, and
token-carrying URL parameters), so your credentials don't ride along
in our error reports. Sentry appears on Driftstack's
[sub-processor list](https://driftstack.dev/legal/sub-processors/),
using Sentry's EU ingest region.

Two things follow from that:

- Sentry is a sub-processor of _Driftstack's_, not of yours. Using
  Driftstack does not put your end-users' data in your own Sentry.
- JavaScript errors thrown by pages you automate are **not**
  collected or forwarded by Driftstack at all. If the session itself
  dies, you get a `session.failed`
  [webhook](/webhooks/events/) — but that reports the session
  failure, not the page's JS exceptions.

## Getting in-page stack traces today

If you want Sentry-quality stack traces from inside a page running
under Driftstack, instrument the page itself — exactly as you would
for any real browser traffic. This works when you own (or can deploy)
the page under test:

1. Create a Sentry project on your side and copy its DSN.
2. Add the Sentry browser SDK to the page at build time (bundler
   import or script tag).
3. Correlate each Sentry event with the Driftstack session that
   produced it. The page can't know its session ID by itself, but
   _you_ control the navigate URL — pass the ID as a query parameter
   and tag it on boot.

Driving side:

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

const session = await client.sessions.create({ label: 'sentry-tagged-run' });
await client.sessions.navigate(session.id, {
  url: `https://staging.your-app.example/checkout?ds_session=${session.id}`,
});
```

Page side, in your Sentry bootstrap:

```js
Sentry.init({ dsn: 'https://…your-dsn…' });

const dsSession = new URLSearchParams(window.location.search).get('ds_session');
if (dsSession) {
  Sentry.setTag('driftstack_session_id', dsSession);
}
```

Now every Sentry issue from an automated run carries the
`driftstack_session_id` tag, and you can drill from a stack trace
back to the exact session (its [audit-log](/api/audit-log/) entries,
[state reads](/api/sessions/#get-state), and captures).

Because the Sentry SDK runs inside the browser session, everything
Sentry can normally do in a browser — releases, source maps,
breadcrumbs, traces — works unchanged. No Driftstack-side
configuration exists or is needed.

One boundary to respect: keep automated-run traffic out of your
real-user error budgets — point pages driven by Driftstack at a
staging DSN (or a dedicated Sentry `environment`) rather than your
production project.

## When the session itself fails

Page-level instrumentation covers errors _inside_ the page. For the
session dying underneath it (driver fault, runtime crash), subscribe
a webhook to `session.failed` — and `session.completed` for clean
teardowns — via [`POST /v1/webhooks`](/webhooks/endpoints/). Routing
those into your alerting closes the loop from the other side.

## Related

- **[Webhook events](/webhooks/events/)** — `session.failed` payload shape and signature verification.
- **[Errors](/reference/errors/)** — the stable problem types for API-level failures.
- **[Session lifecycle](/guides/session-lifecycle/)** — which failures end a session.

Questions about what to build against in the meantime:
[support@driftstack.dev](mailto:support@driftstack.dev).
