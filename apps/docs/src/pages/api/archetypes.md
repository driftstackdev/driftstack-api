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
never included. `default_archetype_id` is the launch default — what
`POST /v1/sessions` or `POST /v1/profiles` gets when an archetype is omitted on
a tier entitled to every device. A tier with a device entitlement (the free
tier: iPhone 13 and iPhone 13 mini) gets its own default instead: the newest
archetype of its first entitled device.

Direct session creation, profile creation, and profile import accept only an
`id` present in the current response. Any other id returns
`400 ValidationFailed` on the `archetype` field before a browser, profile row,
or driver allocation is attempted.

## Generate a create payload from the live catalog

Resolve capabilities to an id at runtime instead of constructing or guessing a
slug. This helper can generate the body for either `POST /v1/sessions` or
`POST /v1/profiles`:

```ts
type ArchetypeFilter = {
  id?: string;
  device?: string;
  ios_version?: string;
  safari_version?: string;
};

async function archetypeCreatePayload(filter: ArchetypeFilter = {}) {
  const requested = Object.entries(filter).filter(([, value]) => value !== undefined);
  if (requested.length === 0) return {};

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
  const matches = catalog.data.filter(
    (entry) =>
      (filter.id === undefined || entry.id === filter.id) &&
      (filter.device === undefined || entry.device === filter.device) &&
      (filter.ios_version === undefined || entry.ios_version === filter.ios_version) &&
      (filter.safari_version === undefined || entry.safari_version === filter.safari_version),
  );

  if (matches.length === 0) {
    throw new Error('No currently selectable archetype matches those capabilities.');
  }
  if (matches.length > 1) {
    throw new Error(
      'More than one archetype matches. Add another capability or use an exact catalog id.',
    );
  }
  return { archetype: matches[0]!.id };
}

const sessionBody = await archetypeCreatePayload({
  device: 'iPhone 17',
  ios_version: '18.7',
  safari_version: '26.4',
});
```

If no capability filter is needed, omit `archetype` and let the server use
the tier's default (`default_archetype_id` on tiers entitled to every device). Existing stored profiles keep their pinned archetype
even if it later leaves the selectable catalog; compatibility operations on
those profiles remain available, but new direct creates and imports must choose
from the live response.

The route and its inline response schema are also published in
[`/openapi.json`](https://api.driftstack.dev/openapi.json). Do not copy returned
IDs into a separate application constant; refresh the catalog after its
five-minute response lifetime.
