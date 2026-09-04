# V-545 — status-page enhancements

**Date:** 2026-05-11
**Wave:** 23
**Status:** DESIGN — V-295c shipped the basic status site at
status.driftstack.io. V-545 designs the next-layer features (incident
posting workflow, subscriber notification, history view).

## Current state

`apps/status-site/` ships a Cloudflare Pages static site at
status.driftstack.io. It currently shows:

- Overall platform status (operational / degraded / outage), driven by
  the `/v1/status` endpoint (V-295c).
- Per-component status (API / dashboard / docs / marketing).
- Most recent incidents (last 5).

Existing admin endpoints (V-516):

- `POST /v1/admin/incidents` — open an incident.
- `PATCH /v1/admin/incidents/:id` — update / close.
- `GET /v1/admin/status-subscribers` — list email subscribers.

## V-545 scope

Three enhancement clusters, each landing as its own sub-slice.

### V-545.A — incident posting workflow polish

The admin can already CRUD incidents via the API. The status-site UX
gap: each incident UPDATE should generate a "what changed" delta
visible on the status page. Today the status page shows current state;
visitors can't see "incident was raised → 10 min ago expanded to
include /docs → 30 min ago fixed".

Implementation:

1. Each `PATCH /v1/admin/incidents/:id` writes a new row to
   `incident_updates` (proposed table).
2. Status site renders the timeline per incident in reverse-chrono
   order.
3. Admin can mark an update as "operator-only" (skipped from the
   status-site render) for internal notes.

### V-545.B — subscriber notification

Subscribers already exist (V-516 admin endpoint). Need:

1. **Email-on-incident-open** — Postmark template
   `incident-opened` sent to all subscribers when incident state goes
   to `'open'`.
2. **Email-on-update** — `incident-updated` template per update,
   throttled to max 1 per subscriber per incident per hour (avoid
   inbox flooding).
3. **Email-on-resolve** — `incident-resolved` template when state
   transitions to `'resolved'`.

Subscriber preferences:

- Unsubscribe-all link in every email.
- Per-component subscribe (subscribe only to API outages, not docs).

### V-545.C — history view

Static-site additions:

1. `/status/history/2026-05` — month-archive view showing all incidents
   that opened, closed, or had updates within the month.
2. Permalink per incident: `/status/incidents/incident-id-slug`.
3. RSS feed at `/status/feed.xml` for programmatic consumers.

## Schema additions (V-545.A target)

```sql
CREATE TABLE incident_updates (
  id            uuid PRIMARY KEY,
  incident_id   uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  body          text NOT NULL,
  operator_only boolean NOT NULL DEFAULT false,
  posted_by     uuid REFERENCES accounts(id) ON DELETE SET NULL,

  CONSTRAINT incident_updates_body_nonempty CHECK (length(body) > 0)
);

CREATE INDEX incident_updates_incident_id_posted_at_idx
  ON incident_updates (incident_id, posted_at DESC);
```

`incidents.id` already exists per V-516. Just the new updates child
table.

## Open questions for team review

1. **Email throttling default.** 1-per-hour per subscriber per incident
   for updates — too chatty during a long-running incident?
   Recommendation: 1-per-hour is fine for the first incident; if usage
   shows it's too chatty, fall back to "digest" hourly mode.
2. **Per-component subscribe granularity.** Coarse (API / dashboard /
   docs / marketing — 4 buckets) vs fine (per-route)? Recommendation:
   coarse. Per-route is over-engineered for the volume.
3. **RSS feed scope.** Open incidents only, or include resolved
   history? Recommendation: include history (programmatic consumers
   typically want the full timeline).

## Sub-slices

- **V-545.A** — incident-update timeline + schema + admin route to
  post updates. **DONE** (2026-05-15 → 2026-05-16). Surface includes:
  server routes GET /v1/status/incidents (list) + /:id (detail),
  recent*incidents on /v1/status (top 5), 30s Cache-Control on all
  three, status-site detail page /incident?id=inc*<uuid> +
  card-linking on the index, OpenAPI typed responses, 9-invariant
  post-deploy verifier.
- **V-545.B** — subscriber notification (3 Postmark templates +
  throttling). **Phase 1 DONE** (2026-05-16): `onPublicUpdated`
  lifecycle hook on IncidentsService fires per-update with the
  incident + update rows. **Phase 2 DEFERRED**: add the
  `status-incident-updated` Postmark template + wire bootstrap to
  use the existing IncidentNotificationsService.fanOut path with
  per-subscriber-per-incident-per-hour throttling (needs a new
  dedup table — bigger schema slice).
- **V-545.C** — status-site history view + permalinks + RSS feed.

Each sub-slice is roughly one wave's work. Land in order.

## Verification

- File written.
- Cross-references V-295c (status site bootstrap), V-516 (admin
  incident endpoints).
- V-205 + V-211 sweep: zero hits.
