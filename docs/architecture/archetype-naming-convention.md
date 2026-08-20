# Archetype naming convention

**Status:** locked as of V-136 (2026-05-05).
**Owner:** Driftstack engineering.
**Audience:** future engineers cycling archetype identifiers
on iOS major bumps.

## Identifier shape

```
<device_family>_<device_model>_ios<major>_<minor>_safari<safari_major>_<safari_minor>
```

For the currently-locked archetype:

```
iphone17_ios18_7_safari26_4
```

The locked default moved from `iphone16pro_ios18_7_safari26_4` to
`iphone17_ios18_7_safari26_4` at the 2026-06-11 cutover: iPhone 17 is the
real-device-verified archetype, and `iphone16pro` is retained as a scaffolded
`reference` baseline so labels still resolve for profiles already created against it.
A profile keeps the archetype it was created with — see
`docs/guides/profile-management.md`.

- `device_family` — `iphone` for iPhone, `ipad` for iPad. Lowercase, no
  punctuation.
- `device_model` — `16pro`, `15`, `air`, `mini`, etc. Lowercase, no
  punctuation. Drop "Pro" capitalization for parity with other identifiers.
- `ios<major>_<minor>` — Apple's iOS version that the device is running.
  Major + minor only; patch version is **not** part of the identifier
  (patches don't change the WebKit fingerprint surface enough to differentiate).
- `safari<major>_<minor>` — Safari version. **Required** because Apple ships
  Safari independently of iOS major. Two devices on the same iOS may run
  different Safari builds; the archetype must distinguish them.

## Display label

The human-readable customer-facing label is:

```
iPhone 17 / iOS 18.7 / Safari 26.4
```

Mapped from identifier in `packages/api-types/src/common.ts:ARCHETYPE_DISPLAY_LABEL`.
Marketing-site, customer-dashboard, admin-panel, and GUI client all import
`archetypeDisplayLabel(id)` rather than rendering the raw identifier.

## Multi-archetype registry

The platform is NOT a single-device product — it models a matrix of iPhone /
iPad models across iOS + Safari versions. `packages/api-types/src/common.ts`
exports `ARCHETYPE_REGISTRY`, the single-source-of-truth catalogue. Each
`ArchetypeConfig` carries `id` / `displayLabel` / `device` / `iosVersion` /
`safariVersion` / `canvasFamily`, plus a `status`:

- `launch` — fingerprint atlas populated; the current default at v1.0.
- `available` — populated + customer-selectable, but not the default (e.g. a legacy device the GUI offers).
- `reference` — a captured INTERNAL baseline, not customer-selectable (e.g. the Family A baseline).
- `planned` — a recognized slug whose atlas is not yet populated (placeholder).

The customer-selectable catalog (GUI / dashboard selector) = entries with
status `launch` or `available`.

`ARCHETYPE_DISPLAY_LABEL` and `archetypeDisplayLabel(id)` are DERIVED from the
registry, so adding a device is adding one registry entry — not editing a
hardcoded list. Slugs must match Agent-1's atlas naming (the identifier shape
above). Registering a slug as `planned` before its atlas lands is expected:
the customer-facing selector surfaces only populated (`launch` / `reference`)
archetypes, and a `planned` entry "lights up" automatically when its status
flips.

**Changing the launch default is a status flip, not a system-wide swap.**
Point the new entry to `status: 'launch'` (and the prior default away) — the
registry already recognizes the slug, so there is no slug-rename sweep across
the codebase. The multi-surface coordination below applies only to a true
identifier-FORMAT change (e.g. the V-136 rename), not to promoting a new
launch default.

## When the locked archetype changes

Every iOS major version bump (iOS 19, iOS 20, ...) requires a coordinated
update across:

1. **`packages/api-types/src/common.ts`** — update `LOCKED_ARCHETYPE_ID` +
   `LOCKED_ARCHETYPE_DISPLAY_LABEL` + add the new id to `ARCHETYPE_DISPLAY_LABEL`.
   Old identifiers stay in the map so existing sessions/profiles still
   render correctly during the transition window.
2. **Customer-facing copy** in `apps/marketing-site/`:
   - `src/data/capabilities.ts:archetypeReference`
   - `src/pages/index.astro` cumulative-rig section
   - any other body copy that names the archetype explicitly
3. **Mock data** in `apps/customer-dashboard/src/data/mocks.ts` and
   `apps/admin-panel/src/pages/sessions.astro` — bump the mock
   `archetype` field values.
4. **Integration test fakes** under `apps/server/tests/integration/_helpers/`
   — search for the old archetype identifier and update.
5. **Server-side archetype validation** wherever the identifier is hardcoded
   (currently `apps/server/src/services/sessions.ts` if any).

The map-of-known-archetypes in `ARCHETYPE_DISPLAY_LABEL` lets us run two
identifiers in parallel during a bump — old archetype-id rows in the
database keep their friendly label until they age out naturally.

## Don't include in the identifier

- Patch version (`18.7.1`) — fingerprint-stable across patches.
- Build number (`22F76`) — internal Apple identifier, not customer-relevant.
- Region (`en_US`) — locale is a separate axis; if region-specific archetypes
  ever ship they get a parallel system, not a suffix.
- Profile id — profiles are an orthogonal concept; the archetype defines the
  device fingerprint, the profile defines the persistent identity (cookies,
  localStorage, etc.) running on top.

## Rationale for parallel iOS + Safari versioning

Apple shipped **iOS 18.7 with Safari 26.4** in a recent release. Pre-V-136
the codebase used `iphone16pro_ios26_4_1` — conflating the Safari version
with a fictional "iOS 26.4.1" that doesn't exist. The fix is to model both
explicitly.

Safari 26 is "Safari 18 evolved" (Apple kept the WebKit major version line
roughly synced with Safari version even when iOS major-versions diverged).
The customer fingerprint is determined by Safari + WebKit + Core Graphics

- Core Text — Safari version dominates the visible fingerprint. iOS major
  matters for OS-level signals (UAClientHints `Sec-CH-UA-Platform-Version`,
  `navigator.platform`, etc.). Both versions in the identifier means we can
  ship Safari-only archetype updates (iOS unchanged) without renaming.

## V-136 specifics

V-136 cleared the `iphone16pro_ios26_4_1` → `iphone16pro_ios18_7_safari26_4`
rename across:

- `packages/api-types/src/common.ts` — added `LOCKED_ARCHETYPE_ID`,
  `LOCKED_ARCHETYPE_DISPLAY_LABEL`, `ARCHETYPE_DISPLAY_LABEL` map,
  `archetypeDisplayLabel(id)` helper, plus `PROFILES_PER_TIER` (separate
  decision-1 fix, see V-log V-136 entry).
- `apps/marketing-site/src/data/capabilities.ts` — `archetypeReference`
  string updated.
- `apps/marketing-site/src/pages/index.astro` — cumulative-rig section
  body + caption updated.
- `apps/customer-dashboard/src/data/mocks.ts` (4 occurrences) — mock
  `archetype` field values renamed.
- `apps/admin-panel/src/pages/sessions.astro` (3 occurrences) — same.
- `apps/customer-dashboard/src/pages/profiles.astro` — now passes
  `profile.archetype` through `archetypeDisplayLabel(...)` for friendly
  rendering.

GUI client (`apps/gui-client/`) reads archetype values from real API
responses; no hardcoded identifier to rename.

The `iphone16pro_ios26_4_1` identifier is no longer valid. If a session
or profile in any database somewhere still carries it, treat that row
as test pollution + drop on next migration window.
