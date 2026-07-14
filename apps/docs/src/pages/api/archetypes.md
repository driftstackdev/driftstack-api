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
