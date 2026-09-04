# `V-219*` — customer-dashboard + admin-panel visual-consistency audit

PHASE 1 of the `V-219*` Tier 3 visual-consistency cycle. Walks the
customer-dashboard + admin-panel surfaces against the marketing-site
reference design tokens, captures gaps, and proposes a small-scope
PHASE 2 redline set. Per the V-211 anonymity policy, the audit also
checks for personal-name references on customer-facing surfaces.

> **Scope is small** — apply existing design tokens, not new brand
> work. No graphical logo mark, no new colors, no new typography, no
> layout structural changes. Existing tokens (oxblood + slate +
> emerald/amber/red/blue + Geist Sans + Berkeley Mono) already exist
> across all three apps; the gaps are application of those tokens,
> not their definition.

## What's already aligned (no change needed)

`apps/customer-dashboard/src/styles/base.css` and
`apps/admin-panel/src/styles/base.css` are **byte-for-byte identical**
and already define the same tokens marketing-site uses:

- `bg-slate-50` body background, `text-slate-900` foreground.
- `Geist Sans` body font (with `cv11` + `ss01` features), `Berkeley
Mono` for `code` / `pre` / `kbd`.
- `::selection` background = `oxblood-700`, white text.
- `.btn-primary` = oxblood-700 fill, white text, shadow-sm,
  focus-ring oxblood-700. **Identical to marketing's `.btn-primary`.**
- `.btn-secondary` = slate-300 border, white background, slate-900
  text. **Identical to marketing's `.btn-secondary`.**
- `.nav-link` = slate-600, hover oxblood-700. **Identical.**
- Dashboard-only `.dashboard-card` = rounded-lg, slate-200 border,
  white bg, shadow-sm. (Admin uses the same name; marketing doesn't
  use the class.)

Per-page styling on existing dashboard / admin pages also already
uses oxblood-only-for-CTAs + slate-for-text/borders + status-color
palette (emerald/amber/red/blue) for state indicators per the V-180
through V-194 wiring slices.

**Implication**: the visual-consistency gap isn't a tokens gap —
it's a brand-treatment gap on a small set of header / wordmark /
empty-state copy locations. PHASE 2 redlines are bounded.

## Gaps found

### Gap 1 — Wordmark treatment in app headers diverges from marketing

**Marketing site header** (`apps/marketing-site/src/components/Header.astro`):

```html
<a href="/" class="flex items-center gap-2 font-mono text-base font-semibold text-slate-900">
  <span
    class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-oxblood-700 text-white"
  >
    D
  </span>
  <span>driftstack</span>
</a>
```

Two distinguishing elements:

- **Oxblood-700 "D" badge** — 28×28px rounded square, white "D" glyph.
- **Lowercase, font-mono "driftstack"** wordmark.

**Customer-dashboard sidebar header** (`apps/customer-dashboard/src/layouts/DashboardLayout.astro`):

```html
<a href="/" class="font-semibold text-slate-900"> Driftstack </a>
```

- No badge. Sentence-case "Driftstack". Sans-serif (default body
  font, not mono).

**Admin-panel sidebar header** (`apps/admin-panel/src/layouts/AdminLayout.astro`):

```html
<a href="/" class="font-semibold text-slate-900">Driftstack</a>
<span
  class="rounded-full bg-oxblood-50 px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-oxblood-700"
>
  admin
</span>
```

- No badge. Sentence-case "Driftstack". Sans-serif. Has an "admin"
  font-mono uppercase pill in oxblood-50 / oxblood-700.

**Verdict**: Three different brand treatments across three surfaces
that should read as one product. Marketing's "D-badge + lowercase
mono wordmark" is the established treatment per V-138 and is the
right alignment target.

**PHASE 2 redline**: replicate the marketing wordmark pattern in
both dashboard + admin sidebar headers. Admin keeps the "admin"
pill alongside (it's the staff-context indicator and earns the
visual differentiation).

### Gap 2 — Onboarding flow page headers also diverge

`apps/customer-dashboard/src/pages/{signup,verify-email,welcome,select-tier,first-session}.astro`
all set `withSidebar={false}` on the layout, which means the side-nav
is hidden but the header brand surface above the form area is
ALSO hidden (the layout doesn't render a marketing-style horizontal
header in that mode).

Visitors landing on `/signup` see no Driftstack wordmark on the
page — just the form. Marketing has a continuous header brand
presence across all pages.

**PHASE 2 redline**: when `withSidebar={false}`, render a minimal
horizontal header with the same wordmark treatment as marketing
(D-badge + lowercase mono "driftstack"). No nav links, no CTA —
this is the no-sidebar onboarding flow; the wordmark is purely
brand presence.

### Gap 3 — Empty-state copy tone is mostly aligned but not always

Spot-checked empty states across customer-dashboard:

- `/sessions` "No sessions running" — direct, on-tone. ✓
- `/profiles` (mock state) — to verify when wired.
- `/api-keys` — uses progressive enhancement; empty state copy
  comes from inline script (V-182). On-tone in V-217.
- `/webhooks` (V-181 + V-185) — direct, on-tone. ✓
- `/usage` — sparkline empty state TBD.
- `/settings` (V-217) — Recent activity empty state reads:

  > "No recent activity yet — your first key mint, session create,
  > or other account event will appear here."

  On-tone, technical-direct. ✓

- Admin `/leads` — to verify.

No instances of overly-casual copy ("Oh no!", emoji decoration,
"Looks like you don't have any X yet, click here to create one!"
patterns) found. The technical-direct tone established by the
V-180–V-194 wiring slices is consistent.

**PHASE 2 redline**: none required for empty-state copy on the
audited pages. Spot-check the remaining `/profiles` + `/usage` +
admin `/leads` empty states during PHASE 2 working-tree pass; flag
anything off-tone for redline.

### Gap 4 — Loading / pending state visual consistency

Customer-dashboard pages use the V-180-pattern banner
(`<div data-banner class="hidden ...">`) + per-section loading
text. Admin-panel pages use the same pattern (V-187+).

No spinner / skeleton differences across the two apps. The banner
copy itself reads as one voice ("Couldn't load X (HTTP NNN). Showing
preview data below.") consistently.

**PHASE 2 redline**: none required.

### Gap 5 — Status badge palette consistency

Sample audit across surfaces:

- Customer `/sessions` STATUS_BADGE: `creating: amber-50/700`,
  `ready: emerald-50/700`, `busy: blue-50/700`, `destroyed:
slate-100/600`, `errored: red-50/700`.
- Admin `/sessions` STATUS_BADGE: same mapping.
- Customer `/billing` STATUS_BADGE_CLASS: `active: emerald`,
  `trialing: amber`, `past_due: red`, `canceled: slate`,
  `unpaid: red`, etc.
- Admin `/accounts` STATUS_BADGE: `active: emerald`, `suspended:
amber`, `deleted: slate`.

Color semantics consistent: emerald = good, amber = transient /
warning, red = error / blocked, slate = inert / completed, blue =
active-in-use. The mapping isn't formalised in shared CSS — each
page redeclares its own object literal — but the values are
identical.

**PHASE 2 redline**: optional small refactor — hoist `STATUS_BADGE`
maps into a shared constant in
`apps/customer-dashboard/src/lib/badge-colors.ts` (and admin
equivalent). Not load-bearing; can defer post-launch. Skip in this
PHASE 2 since the visible result is already consistent; refactor
only buys future-edit consistency.

### Gap 6 — Anonymity policy compliance check (V-211)

Grepped customer-dashboard + admin-panel pages and src for
`Joël | Theunissen | joeltheunissen89` references. **Zero hits**
across both apps. V-211 audit already cleaned these surfaces; no
backslide.

**Verdict**: clean. No PHASE 2 work needed for anonymity.

### Gap 7 — Dashboard layout doesn't include a footer

Marketing site has a Footer component (Privacy / ToS / DPA / AUP

- sub-processors links). Customer dashboard + admin panel layouts
  have no footer — the page just ends at the content area.

For staff-only admin panel: no footer is fine. Internal surface;
legal-doc links unnecessary.

For customer dashboard: the customer is signed-in to a billed
relationship — the legal-doc links should reachable from any
dashboard page (per the Privacy Policy + DPA discoverability
expectation). Today they're only reachable from the marketing site

- the onboarding flow (legal-acceptance step).

**PHASE 2 redline**: add a minimal footer to `DashboardLayout` —
slate-500 small text, links to `/legal/privacy` `/legal/terms`
`/legal/dpa` `/legal/aup` (existing pages on `app.driftstack.io`
or external links to driftstack.io/legal/\* if those redirect).
Single-line; doesn't intrude on the page content area.

## PHASE 2 working-tree drafts — proposed surface

Targeted edits, all working-tree only until founder redline:

1. **`apps/customer-dashboard/src/layouts/DashboardLayout.astro`** — replace plain "Driftstack" sidebar wordmark with marketing's D-badge + lowercase mono "driftstack" treatment. Add a minimal footer with legal-doc links.

2. **`apps/admin-panel/src/layouts/AdminLayout.astro`** — replace plain "Driftstack" with the same D-badge + lowercase mono wordmark, keeping the existing "admin" pill alongside. (No footer — staff-only surface.)

3. **`apps/customer-dashboard/src/layouts/DashboardLayout.astro`** (no-sidebar branch) — render a minimal horizontal header with the same wordmark when `withSidebar={false}`, so the onboarding pages have brand presence.

4. (Optional) `apps/customer-dashboard/src/lib/badge-colors.ts` + admin equivalent — hoisting STATUS_BADGE maps into a shared constant. Defer if scope is tight; the visible result is already consistent.

That's 3 files for the PHASE 2 redline if we skip Gap 5 refactor;
4 files if included.

## Out of scope

Per the `V-219*` spec, the following are deferred:

- Graphical logo mark design (text wordmark stays).
- New color palette / new accent colors.
- New typography (Geist Sans + Berkeley Mono are locked).
- Custom illustration / photography / motion design.
- Layout structural changes (existing page architecture stays).
- Marketing-site changes (already done in V-214b).

Any of these surface as separate Tier 3 cycles when designer time
is justified post-launch.

## Verify

Audit passes:

- `grep -rn -i "Joël|Theunissen|joeltheunissen"` across customer-
  dashboard + admin-panel app sources: zero hits.
- `apps/customer-dashboard/src/styles/base.css` ⟂
  `apps/admin-panel/src/styles/base.css`: byte-identical.
- Empty-state copy across audited pages: technical-direct tone,
  no off-brand casual phrasing.
- Status badge color mapping: consistent across pages within each
  app + cross-app (emerald/amber/red/blue/slate semantics).

## Next

PHASE 2 working-tree drafts on the 3 layout files. NOT committed
until founder redline pass.
