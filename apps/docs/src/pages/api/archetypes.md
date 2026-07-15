---
layout: ../../layouts/DocLayout.astro
title: Archetypes
description: Discover the currently selectable Driftstack device, iOS, and Safari combinations from the public API.
---

# Archetypes

An archetype is the exact device, iOS, and Safari combination used to
create a session or persistent profile. Do not hard-code a copied catalog:
use this endpoint to populate selectors and validate configuration. The
response is generated from the same canonical registry used by the server,
desktop app, dashboard, and OpenAPI code generator.

## List available archetypes

`GET /v1/archetypes`

No API key is required. Responses are cacheable for five minutes:
`Cache-Control: public, max-age=300`.

```bash
curl https://api.driftstack.dev/v1/archetypes
```

Response (`200`):

```json
{
  "default_archetype_id": "iphone17_ios18_7_safari26_4",
  "data": [
    {
      "id": "iphone17_ios18_7_safari26_4",
      "display_label": "iPhone 17 / iOS 18.7 / Safari 26.4",
      "device": "iPhone 17",
      "ios_version": "18.7",
      "safari_version": "26.4",
      "canvas_family": "B",
      "status": "launch",
      "is_default": true
    }
  ]
}
```

Only customer-selectable entries are returned:

- `launch` — selectable and used when a request omits `archetype`
- `available` — selectable, but not the default

Internal fingerprint-reference baselines and other non-selectable entries are
never included. `default_archetype_id` is the value the platform currently
chooses when `POST /v1/sessions` or `POST /v1/profiles` omits an archetype.

Direct session creation, profile creation, and profile import accept only an
`id` present in the current response. A well-formed but unknown, reference-only,
or planned id returns `400 ValidationFailed` on the `archetype` field before a
browser, profile row, or driver allocation is attempted.

## Generate a create payload from the live catalog

Resolve capabilities to an id at runtime instead of constructing or guessing a
slug. This helper can generate the body for either `POST /v1/sessions` or
`POST /v1/profiles`:

```ts
type ArchetypeFilter = {
  device?: string;
  ios_version?: string;
  safari_version?: string;
};

async function archetypeCreatePayload(filter: ArchetypeFilter = {}) {
  const response = await fetch('https://api.driftstack.dev/v1/archetypes');
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);

  const catalog = (await response.json()) as {
    default_archetype_id: string;
    data: Array<{
      id: string;
      device: string;
      ios_version: string;
      safari_version: string;
    }>;
  };
  const match = catalog.data.find(
    (entry) =>
      (filter.device === undefined || entry.device === filter.device) &&
      (filter.ios_version === undefined || entry.ios_version === filter.ios_version) &&
      (filter.safari_version === undefined || entry.safari_version === filter.safari_version),
  );

  if (match === undefined) {
    throw new Error('No currently selectable archetype matches those capabilities.');
  }
  return { archetype: match.id };
}

const sessionBody = await archetypeCreatePayload({
  device: 'iPhone 17',
  ios_version: '18.7',
});
```

If no capability filter is needed, omit `archetype` and let the server use
`default_archetype_id`. Existing stored profiles keep their pinned archetype
even if it later leaves the selectable catalog; compatibility operations on
those profiles remain available, but new direct creates and imports must choose
from the live response.

The same response schema is published in
[`/openapi.json`](https://api.driftstack.dev/openapi.json), so generated clients
can expose it without maintaining a separate hand-written model.

## SDKs

All official SDKs read the same live catalog:

```ts
const catalog = await client.archetypes.list();
```

```python
catalog = client.archetypes.list()
```

```go
catalog, err := client.Archetypes.List(ctx)
```

Use `catalog.default_archetype_id` (Go: `DefaultArchetypeID`) when presenting a
recommended choice. Do not copy the returned IDs into a separate application
constant; refresh the cache after its five-minute response lifetime.
