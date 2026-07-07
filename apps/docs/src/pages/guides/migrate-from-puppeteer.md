---
layout: ../../layouts/DocLayout.astro
title: Migrating from Puppeteer / Playwright
description: Map Puppeteer / Playwright concepts onto the Driftstack API — sessions for browsers, actions for page methods, profiles for user-data dirs — and port one flow at a time.
---

# Migrating from Puppeteer / Playwright

Puppeteer and Playwright drive a browser process you run yourself.
Driftstack runs the browser for you — a real iPhone Safari on a
modified WebKit build — and you drive it over plain HTTPS calls. The
surface is **action-based**: instead of executing your script inside
the browser, you send discrete, typed steps (navigate, tap, type,
wait, extract). This page maps the concepts and walks an incremental
port.

## Why teams migrate

- **No browser fleet to run.** No headless containers to keep alive,
  no grid to patch, no device farm to babysit.
- **iPhone Safari, not an emulated one.** The runtime is built from
  WebKit source; you're not configuring a Chromium build to imitate
  a phone.
- **Profile persistence is built in.** Cookies, local storage, and
  IndexedDB live in a server-side [profile](/guides/profile-management/)
  you can snapshot, restore, and clone through the API — replacing
  bespoke "save the cookie jar to disk" code.
- **Concurrency is explicit.** Tier caps plus a typed 429 give you a
  real [backpressure signal](/guides/concurrency/) instead of an
  overloaded machine.

## Concept mapping

| Puppeteer / Playwright                        | Driftstack                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `puppeteer.launch()` / `browser.newContext()` | `POST /v1/sessions` — a fresh session; pass `profile_id` to start from saved state.                                                     |
| `page.goto(url)`                              | [`POST /v1/sessions/:id/navigate`](/api/sessions/#navigate) with `wait_until`: `load` / `domcontentloaded` / `networkidle`.             |
| `page.click(sel)` / `page.type(sel, text)`    | [`POST /v1/sessions/:id/interact`](/api/sessions/#interact) — `action.kind`: `tap`, `type`, `scroll`, or `press`.                       |
| `page.waitForSelector(...)`                   | [`POST /v1/sessions/:id/wait`](/api/sessions/#wait) — `condition.kind`: `selector`, `selector_hidden`, `url_matches`, or `time`.        |
| `page.$eval` / `page.$$eval`                  | [`POST /v1/sessions/:id/extract`](/api/sessions/#extract) — up to 100 named selector reads (text / attribute / list) in one round trip. |
| `page.evaluate(fn)`                           | Not exposed — arbitrary script execution is deliberately absent. Most uses are covered by `extract` + client-side post-processing.      |
| `page.content()`                              | [`POST /v1/sessions/:id/capture`](/api/sessions/#capture) with `kind: "dom_snapshot"` — the serialised DOM as text.                     |
| `page.screenshot()`                           | `capture` with `kind: "screenshot"` — PNG, base64-encoded inline in the response.                                                       |
| `page.url()` / `page.title()` / cookies       | [`GET /v1/sessions/:id/state`](/api/sessions/#get-state) — `url`, `title`, `cookies`, `local_storage`, `page_state`.                    |
| `browser.close()`                             | [`DELETE /v1/sessions/:id`](/api/sessions/#destroy)                                                                                     |
| `--user-data-dir=...`                         | [Profiles](/api/profiles/) — persistent named state a session binds to via `profile_id` or [`launch`](/api/profiles/#launch).           |
| Saving / loading `storageState.json`          | [Profile snapshots](/api/profiles/#snapshots) — capture a restore point, restore it into a new profile later.                           |
| Test parallelism via shards / workers         | Concurrent-session caps per tier; the `concurrency-limit` 429 is your [backpressure signal](/guides/concurrency/).                      |

## Side by side: a login + scrape

The Puppeteer original:

```js
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('https://app.example.com/login');
await page.type('#email', 'user@example.com');
await page.type('#password', process.env.SECRET);
await page.click('button[type=submit]');
await page.waitForSelector('#dashboard');
const kpi = await page.$eval('#kpi', (el) => el.textContent);
await browser.close();
```

The same flow on Driftstack:

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

const session = await client.sessions.create({ label: 'qa-login' });
try {
  await client.sessions.navigate(session.id, { url: 'https://app.example.com/login' });
  await client.sessions.interact(session.id, {
    action: { kind: 'type', selector: '#email', text: 'user@example.com' },
  });
  await client.sessions.interact(session.id, {
    action: { kind: 'type', selector: '#password', text: process.env.SECRET!, sensitive: true },
  });
  await client.sessions.interact(session.id, {
    action: { kind: 'tap', selector: 'button[type=submit]' },
  });
  await client.sessions.wait(session.id, {
    condition: { kind: 'selector', selector: '#dashboard' },
    timeout_ms: 10_000,
  });
  const { value } = await client.sessions.extract(session.id, {
    extractions: [{ name: 'kpi', selector: '#kpi', type: 'text' }],
  });
  console.log(value.kpi);
} finally {
  await client.sessions.destroy(session.id);
}
```

Two things to note: the `sensitive: true` flag on the password `type`
action (the typing simulation makes no visible corrections for
sensitive values — password fields get it automatically), and that
for a login specifically there's also a one-call heuristic
[`login`](/api/sessions/#login) endpoint that finds the fields
itself.

## What has no direct equivalent

- **Arbitrary `page.evaluate` script execution.** The surface is
  action-based on purpose. Structured reads are `extract`; whole-page
  reads are a `dom_snapshot` capture. If you have an extraction need
  neither covers, email
  [support@driftstack.dev](mailto:support@driftstack.dev) — don't
  work around it by scraping screenshots.
- **CDP / DevTools protocol access.** Driftstack manages WebKit out
  of process; there is no protocol passthrough. Per-step `capture`
  calls are the observation tool.
- **Zero-latency chaining.** Every action is an HTTPS round trip. For
  tight read loops, batch: one `extract` call with many named
  extractions replaces a dozen `$eval`s.
- **Browser extensions / stealth plugins.** The managed browser
  doesn't load extensions; fingerprint consistency is handled by the
  archetype layer, not by plugins you ship.

## An incremental migration path

1. **Wrap.** Keep your existing test/scrape code and write a thin
   compatibility layer that maps your `page.click` / `page.goto`
   helpers onto Driftstack calls. Port one flow at a time behind it.
2. **Profiles second.** Replace hand-rolled "save cookies, load them
   next run" persistence with a profile plus
   [snapshots](/api/profiles/#snapshots). This is usually the first
   place the port _deletes_ code.
3. **Webhooks third.** Replace completion-polling with
   [`session.completed` / `session.failed` webhooks](/webhooks/events/).
4. **Drop the wrapper.** Once the last direct Puppeteer caller is
   gone, use the [SDK](/sdk/) surface directly.

## Common gotchas

- **Prefer stable selectors.** `wait` matches on selectors, URL
  patterns, or elapsed time — there is no DOM-mutation observer. Put
  `data-test-*` attributes on anything you own.
- **Don't sleep client-side; `wait` server-side.** A client-side
  sleep holds your concurrent slot for the full duration no matter
  what; a `selector` wait returns the moment the condition is met.
- **Destroy promptly.** Sessions hold a concurrent slot until
  destroyed — always tear down in a `finally` (see
  [session lifecycle](/guides/session-lifecycle/)).
- **Scope your runtime keys narrowly.** A CI runner needs
  `read:sessions` + `write:sessions`, not `account_owner`. See
  [API key scopes](/reference/scopes/).

## Where to go next

- **[Quickstart (curl)](/quickstart-curl/)** — see the raw wire calls end to end.
- **[Sessions reference](/api/sessions/)** — every action, field by field.
- **[Profile management](/guides/profile-management/)** — the user-data-dir replacement, in depth.
- **[Concurrency & backpressure](/guides/concurrency/)** — sizing parallel workloads.
