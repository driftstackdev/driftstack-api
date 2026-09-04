---
layout: ../../layouts/DocLayout.astro
title: Migrating from Browserless
description: Port a Browserless workload onto Driftstack — surface mapping, the action-based model, profile persistence, and an honest list of what has no equivalent.
---

# Migrating from Browserless

You have a Browserless deployment (cloud or self-hosted) and want to
scope a port to Driftstack without surprises. The core difference:
Browserless hands you a remote Chrome to script over CDP (the
Chrome DevTools Protocol — the wire protocol Puppeteer speaks);
Driftstack is **action-based** — every browser step is a typed HTTPS
call against an iPhone Safari session, and there is no
`/function`-style endpoint that runs your JavaScript server-side.

## Surface comparison

| Browserless                                                | Driftstack                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connect Puppeteer to `wss://chrome.browserless.io?token=…` | `POST /v1/sessions`, then drive with action endpoints ([`navigate`](/api/sessions/#navigate), [`interact`](/api/sessions/#interact), [`wait`](/api/sessions/#wait), [`extract`](/api/sessions/#extract), [`capture`](/api/sessions/#capture)). No CDP passthrough. |
| `/function` (POST a JS body, get JSON back)                | No direct equivalent. Express the flow as actions; structured reads go through [`extract`](/api/sessions/#extract).                                                                                                                                                |
| `/screenshot` + `/pdf`                                     | [`POST /v1/sessions/:id/capture`](/api/sessions/#capture) with `kind`: `screenshot`, `dom_snapshot`, or `pdf`. Bytes come back inline (base64).                                                                                                                    |
| Concurrency you meter yourself                             | Tier-driven cap; going over returns a `429` with the stable `concurrency-limit` problem type — see [Concurrency & backpressure](/guides/concurrency/).                                                                                                             |
| Stealth flags / fingerprint plugins                        | Archetypes (the device + OS + browser identity a session presents) plus server-side [profiles](/guides/profile-management/).                                                                                                                                       |

## The first port: replace the WebSocket

A typical Browserless integration is a Puppeteer script pointed at
their WebSocket endpoint:

```js
const browser = await puppeteer.connect({
  browserWSEndpoint: `wss://chrome.browserless.io?token=${TOKEN}`,
});
const page = await browser.newPage();
await page.goto('https://example.com');
const title = await page.title();
await browser.close();
```

On Driftstack the same flow is discrete calls:

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

const session = await client.sessions.create({ label: 'title-check' });
try {
  await client.sessions.navigate(session.id, { url: 'https://example.com' });
  const state = await client.sessions.getState(session.id);
  console.log(state.title); // the page title; state.url is the resolved URL
} finally {
  await client.sessions.destroy(session.id);
}
```

No server-side JS anywhere: a login + scrape is a handful of POSTs
followed by a [`state`](/api/sessions/#get-state) or
[`extract`](/api/sessions/#extract) read.

## Profile persistence: the differentiator

Browserless gives you a fresh browser per connection unless you
manage your own cookie jar. Driftstack persists cookies, local
storage, and IndexedDB server-side in a named **profile**:

```ts
const profile = await client.profiles.create({ name: 'evergreen-scraper' });

// Launch a session already bound to the profile (one round trip),
// drive the login once, and destroy cleanly.
const session = await client.profiles.launch(profile.id);
try {
  await client.sessions.navigate(session.id, { url: 'https://example.com/login' });
  // … drive the login with interact / login …
} finally {
  await client.sessions.destroy(session.id);
}

// Keep a restore point of the logged-in state.
await client.profileSnapshots.capture(profile.id, { label: 'logged-in-baseline' });
```

Later sessions bind the same state by passing `profile_id` on
`POST /v1/sessions` (or `launch` again). A profile allows **one live
session at a time** — a second create against it returns
`409 profile-in-use` naming the active session, so two runs can't
overwrite each other's cookies. Snapshots restore into a _new_
profile whenever you need to fork or roll back state. Full flow:
[Profile management](/guides/profile-management/).

## Picking a tier

Concurrency is the sizing axis (see the
[full cap table](/guides/concurrency/)): `api_starter` runs 2
sessions at once, `api_builder` 8, `api_scale` 24, and Enterprise
starts at 32 with per-account overrides above that. Prices:
[driftstack.io/pricing](https://driftstack.io/pricing/).

## What Driftstack deliberately doesn't do

- **Raw WebSocket / CDP passthrough.** The action endpoints are the
  contract; arbitrary protocol messages are blocked on purpose.
- **Server-side JS execution.** No `/function` equivalent. Express
  the flow as actions, or do the computation client-side over an
  `extract` / `dom_snapshot` read.
- **Browser choice.** Driftstack is iPhone Safari (WebKit) by product
  scope — it is not a Chrome or Firefox automation service.
- **Session video recordings.** Not offered today; per-step
  [`capture`](/api/sessions/#capture) calls are the observation tool.

Self-hosting, on the other hand, does exist — as its own offering
rather than a toggle on the cloud plans. See
[driftstack.io/self-hosted](https://driftstack.io/self-hosted/).

## Migration checklist

1. **Inventory your Browserless calls** — count `/function` vs
   `/screenshot` vs raw-CDP usage.
2. **If `/function` bodies do non-trivial in-page computation**, or
   raw CDP is a large share of your traffic, email
   [support@driftstack.dev](mailto:support@driftstack.dev) before
   starting — the action surface may not cover you yet, and it's
   cheaper to learn that first.
3. **Port one job** with the [TypeScript](/sdk/typescript-quickstart/),
   [Python](/sdk/python-quickstart/), or [Go](/sdk/go-quickstart/)
   SDK.
4. **Subscribe to [webhooks](/webhooks/endpoints/)** for
   `session.completed` / `session.failed` and delete your polling
   loops.
5. **Check the usage surfaces** —
   [usage + quotas](/api/usage/) and
   [cost monitoring](/api/cost-monitoring/) — before flipping
   production traffic.

## Need help porting?

Email [support@driftstack.dev](mailto:support@driftstack.dev) with
your `/function` bodies and call volumes; that's enough to scope
whether the action surface covers the workload and which tier fits.
