---
layout: ../../layouts/DocLayout.astro
title: Pagination
description: Cursor-based pagination across every list endpoint — request shape, response shape, opaque cursor semantics, and the canonical drive-to-completion loop in TS / Python / Go.
---

# Pagination

Every list endpoint that can grow beyond a single page uses
**cursor-based pagination**. Cursors are opaque opaque strings the
server mints; clients pass them back to fetch the next page. This
contract is shared across `/v1/sessions`, `/v1/profiles`,
`/v1/webhooks/{id}/deliveries`, `/v1/account/audit-log`,
`/v1/admin/audit-log`, `/v1/admin/crypto-orders`, and others —
this page is the canonical reference.

> **Offset / page-number pagination is not supported.** Cursor
> pagination is stable under concurrent inserts (page 2 doesn't
> shift just because page 1 grew); offset pagination isn't, and
> we don't want to expose customers to that footgun.

## Request shape

| Query parameter | Required | Notes                                                              |
| --------------- | -------- | ------------------------------------------------------------------ |
| `limit`         | optional | Per-page size. Defaults vary per endpoint (typically 50). Bounded. |
| `cursor`        | optional | Pagination token from a prior page's `next_cursor`.                |

The first request omits `cursor`; subsequent requests pass the
prior response's `next_cursor` back.

## Response shape

```json
{
  "data": [
    { /* resource */ },
    /* … */
  ],
  "next_cursor": "<opaque-cursor>" | null
}
```

- `data` — the page's resources, ordered newest-first by default.
- `next_cursor` — opaque token. Pass on the next request to fetch
  the following page. `null` when the page is the last.

The cursor is **opaque** — do not try to parse it. Its internal
shape can change between API versions without notice; only the
"pass it back exactly as received" contract is stable.

## Canonical drive-to-completion loop

### TypeScript

```ts
import type { Driftstack } from '@driftstack/sdk';

async function listAllAuditEntries(client: Driftstack): Promise<unknown[]> {
  const all: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.account.auditLog.list({ limit: 100, cursor });
    all.push(...page.data);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return all;
}
```

### Python

```python
from driftstack import Driftstack

def list_all_audit_entries(client: Driftstack) -> list:
    out, cursor = [], None
    while True:
        page = client.account.audit_log.list(limit=100, cursor=cursor)
        out.extend(page.data)
        if not page.next_cursor:
            break
        cursor = page.next_cursor
    return out
```

### Go

```go
func ListAllAuditEntries(ctx context.Context, c *driftstack.Client) ([]any, error) {
    var out []any
    var cursor string
    for {
        page, err := c.Account.AuditLog.List(ctx, driftstack.ListAuditOpts{
            Limit:  100,
            Cursor: cursor,
        })
        if err != nil {
            return nil, err
        }
        out = append(out, page.Data...)
        if page.NextCursor == "" {
            break
        }
        cursor = page.NextCursor
    }
    return out, nil
}
```

## Ordering + stability

- **Default order** is newest-first (`created_at` desc) on every
  paginated endpoint. Endpoints with a different natural ordering
  (e.g. `/v1/admin/fleet-nodes/{id}` would order by `last_seen_at`)
  document the variation inline; cursor semantics are unchanged.

- **Stability under writes:** because cursors encode position
  relative to the underlying row identity (not an offset),
  concurrent inserts during a paginated read never shift the page
  boundary. A row inserted between page-1 and page-2 simply ends
  up on page 1 (the newer side) on a future read; the current
  walk doesn't re-emit it.

- **Stability under deletes:** if a row is deleted between
  page-1 and page-2 reads, page-2 still resolves correctly (the
  cursor points at a position, not a specific id). The deleted
  row is simply absent.

## Limit bounds

Per-endpoint `limit` ranges:

- Default: typically `50` (audit log, webhooks deliveries) or
  `20` (some admin endpoints).
- Maximum: typically `100` for customer-facing endpoints, `200`
  for admin endpoints (where ops tooling reasonably batches).
- Out-of-range values surface as `400 ValidationFailed` problem+json
  with the per-endpoint bound in the `detail` field.

## Anti-patterns

- **Don't decode the cursor.** It's opaque; we change the encoding
  freely between minor versions. Clients that try to parse it
  break on the next bump.
- **Don't combine `cursor` with a `from` / `to` time filter on the
  resumed call** unless the filter is **identical** to the original
  page-1 call. Mixing them produces undefined results (the cursor
  encodes the original filter context; you'd be asking for a
  different walk).
- **Don't loop without an exit condition.** Every paginated read
  loop must check `next_cursor` for null and break — the
  drive-to-completion examples above do this; copy them rather
  than rolling your own.

## Source of truth

Cursor encoding lives in the per-resource repo (e.g.
`apps/server/src/db/audit-log-repo.ts`). The repo is the only
place that produces or consumes the cursor format; route handlers
treat it as a pass-through string. SDKs forward `cursor` /
`next_cursor` unchanged.
