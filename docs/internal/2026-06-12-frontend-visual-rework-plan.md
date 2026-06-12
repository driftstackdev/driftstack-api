# Frontend / GUI visual rework — master plan (2026-06-12, A2)

Founder brief (verbatim intent): a large rework of _everything customers see_ —
themeable (light/dark + brand colors beyond red, e.g. purple), fancier + more
customer-friendly, **pick-from-visual-demos before any coding**, a much richer
GUI (folders/status/tags for profiles, quick-session, fully team-featured),
a profile-creation page like the polished anti-detect browsers, a strong
**privacy-first** posture with confidence copy, and a marketing site that
actually showcases the features. "Be fancier + more advanced than the bad
anti-detects out there — and we aren't even an anti-detect."

**Can A2 deliver pickable visual demos? YES.** Self-contained HTML mockups
(inline CSS, zero build, zero backend) that the founder opens in a browser and
picks from. No framework, no deploy — `open <file>.html`. This doc is the plan;
`docs/internal/visual-demos/` holds the demos as they land. **Nothing here
touches production** until the founder picks a direction — it's all
throwaway-or-promote mockup HTML + this plan.

---

## 0. The process (my advice on HOW)

Design-first, demo-driven, then build behind it — exactly as the founder framed:

1. **Demo gallery (now → next few waves).** Throwaway static HTML mockups of each
   surface (GUI hub, profile create, marketing home, dashboard) in 2-3 visual
   _directions_ × a theme switcher. Founder opens them, picks a direction per
   surface. Cheap to make, cheap to throw away — we iterate on pixels with zero
   code cost. This is where 90% of the taste decisions get made.
2. **Lock the design system.** Once a direction is picked: freeze the token set
   (colors/space/radius/type/shadow), the component inventory, and the page
   layouts into a short spec. THIS is the contract the implementation follows.
3. **Implement the token layer first.** Convert the picked system into CSS custom
   properties + a Tailwind theme config shared across marketing/dashboard/GUI.
   Theme switch = swap a `data-theme` attribute. (Today's oxblood is hardcoded in
   3 tailwind configs — step 3 unifies them.)
4. **Re-skin surface by surface**, behind the locked system, smallest-blast-radius
   first (marketing home → dashboard shell → GUI hub → profile create).
5. **Feature buildout** (the GUI's new capabilities — folders, tags, team) lands
   incrementally with its backend, AFTER the visual shell exists to hang it on.
   The demos define the target so the backend work is never guessing.

Why demos-first matters here: the founder's taste is the spec, and taste is
visual. Writing React first and tweaking is 10× slower than swapping CSS in a
mockup. We close the look, _then_ it's a mechanical port.

---

## 1. Theming architecture (light/dark + brand-color choice)

**Token-based, two independent axes** so the founder mixes freely:

- **Axis A — mode:** `light` | `dark` (and optionally `system`).
- **Axis B — accent:** `oxblood` (current) | `violet` | `…` — a single brand hue
  the whole UI derives from (buttons, active states, focus rings, the Drift mark).

Mechanism: every color is a CSS custom property under `[data-theme-mode]` +
`[data-accent]` on `<html>`. ~30 semantic tokens (`--surface-base`,
`--surface-raised`, `--ink-primary`, `--ink-muted`, `--accent`, `--accent-hover`,
`--border`, `--status-ready/busy/error`, …). Components reference tokens only,
never raw hex — so a new theme = one token block, zero component edits. Tailwind
maps these via `colors: { surface: 'var(--surface-base)' … }` so existing
utility classes keep working.

Persistence: `localStorage` (GUI) + a `theme` column on the account (so the
dashboard/GUI match across devices) — that's a small additive migration when we
get there, not now.

Accent guidance (carries the founder's existing rules forward): the accent is for
**actions/active states**, never large fills; no gradient-on-text (founder ban).
Violet direction = think Linear/Vercel (indigo-violet `#6d5efc`-ish on near-black).
Light direction = think Stripe/Notion (white surfaces, ink text, accent reserved).

---

## 2. GUI rework — the antidetect-grade hub (the founder's main pain)

Today the GUI profiles view is a flat list. Target = a real workspace, matching/
beating the polished anti-detects (GoLogin, Multilogin, AdsPower, Incogniton,
Dolphin) while staying cleaner. Proposed surface set:

**A. App shell**

- Left sidebar: **workspaces/folders tree** (drag-drop profiles between folders),
  saved **views/filters**, nav (Profiles · Sessions · Recipes · Proxies · Team ·
  Settings). Collapsible.
- Top bar: global search, **+ Quick Session** (one-click launch w/ last-used
  config), account/workspace switcher, theme toggle, sync/connection status.

**B. Profiles hub** (the centerpiece)

- Grid **and** table toggle. Per profile: status dot (idle/running/error/syncing),
  **tags** (colored, multi), **folder**, proxy + **country flag**, last-used,
  notes preview, archetype/device.
- **Bulk actions:** select N → launch / stop / move-to-folder / tag / export /
  delete.
- Per-row quick actions: Launch · Live view · Edit · Duplicate · Proxy · ⋯.
- Sort/filter/saved-views; empty state with a guided "create your first profile".
- Density toggle (comfortable/compact) for power users with 100s of profiles.

**C. Profile create/edit** (founder: "a lot more features, like fancy
antidetects, configurable, quick-session buttons")

- Tabbed/stepped: **Identity** (archetype/device — our real strength: bit-exact
  iPhone fingerprints) · **Proxy** (assign/test/geo) · **Storage** (cookies/
  localStorage import-export, sealed-profile note) · **Behavior** (the
  behavioural-simulation persona) · **Notes/Tags/Folder**.
- Live **preview chip** of the resulting identity (device, locale, timezone,
  "what a site sees").
- **Quick Session**: skip the form, launch a throwaway with sane defaults.
- Templates: save a config as a template; "duplicate profile".

**D. Team features** (founder: "especially to teams")

- Workspace = team boundary. Roles (owner/admin/member/viewer — we already have
  the owner tier + RBAC scaffolding server-side).
- Per-profile + per-folder **sharing/assignment** to teammates; "assigned to me".
- Activity/audit feed (who launched/edited what — we already audit server-side).
- Seat management surfaces in Settings → Team.

**E. Status everywhere** — a consistent status system (the founder asked for
"Status for profiles"): idle · launching · running · errored · syncing ·
archived. One badge component, themed.

These are _design-phase_ targets — the demos render them so the founder reacts to
real layouts; the backend for each (folders table, tags, sharing) lands one by
one afterward.

---

## 3. Privacy-first posture (the founder's #1 trust concern)

The single biggest objection to a _cloud-hosted_ profile/session product:
"can the provider see my data?" The rework must answer this everywhere, truthfully.

**What's already true (and we should say loudly):**

- Profiles are **sealed client-encrypted** (LZFSE + AES-256-GCM under a per-profile
  DEK the harness holds; the control plane only moves opaque bytes — verified in
  `profile-store.ts`: "the sealed blob is OPAQUE to the server; this module only
  moves bytes, never decrypts").
- BYOK + platform secrets are **encrypted at rest** (AES-256-GCM); every secret
  reveal is **audited**.
- Per-tenant key isolation is **cryptographic** (wrong-account TMK fails GCM).

**What to design/commit (surface honestly — don't over-claim):**

- A clear **"Your data" / trust page** + inline confidence copy: what's encrypted,
  who holds keys, what Driftstack staff can and cannot see, session-data
  retention/non-inspection policy, the audit trail customers can read.
- A **privacy/security section in the dashboard** (key status, "no Driftstack
  employee can decrypt your profiles", export-my-data, delete-my-data).
- Marketing: a dedicated Security/Privacy page + trust badges on the home page.
- ⚠️ **Founder/legal gate:** any specific claim ("we never read your sessions",
  "zero-knowledge") must match the actual architecture + the AUP/privacy policy.
  Draft the copy, founder + legal sign off before it ships. I'll write
  source-accurate draft copy in the demo; the _commitment_ is the founder's.

---

## 4. Marketing site — showcase the real features

Today the site undersells. The rework should foreground what's genuinely strong:
bit-exact iPhone fingerprints (not generic UA spoofing), real WebRTC live control,
sealed profiles, BYO-LLM AI agent, per-profile proxies, the SDKs (TS/Go/Python),
webhooks, team workspaces. Sections: hero w/ live-iPhone visual → "how it's
different from anti-detects" → feature grid → privacy/trust → pricing → docs/SDK
→ social proof. Keep the founder's no-solo-founder / no-VC framing rules.

---

## 5. Competitive inspiration (what to borrow, where to beat)

| Anti-detect   | Borrow                                 | Beat it on                                        |
| ------------- | -------------------------------------- | ------------------------------------------------- |
| Multilogin    | folders, team roles, bulk ops          | real mobile fp (theirs is desktop-UA); cleaner UI |
| GoLogin       | profile grid + quick launch, proxy mgr | live WebRTC control; SDK-first                    |
| AdsPower      | automation/RPA surface, templates      | our AI agent (BYO-LLM); sealed-profile privacy    |
| Incogniton    | cookie import, profile notes           | bit-exact iOS; webhooks                           |
| Dolphin{anty} | tag system, statuses                   | fancier/cleaner design; transparency              |

Our differentiators to make loud: **mobile (iPhone) bit-exact, cloud + live
control, sealed/zero-touch privacy, developer-grade (SDKs/webhooks/AI).** We're
positioned _above_ the anti-detect category, not inside it.

---

## 6. Deliverables + status

- [x] This plan.
- [ ] **Demo gallery** (`docs/internal/visual-demos/`): theme-switchable mockups.
      Shipping the GUI-hub demo first (this wave); marketing home + profile-create + dashboard to follow, iterating on the founder's picks.
- [ ] Locked design-system spec (after the founder picks a direction).
- [ ] Token layer + Tailwind unification (build phase).
- [ ] Per-surface re-skin + the GUI feature buildout (incremental, w/ backend).

**How the founder uses the demos:** `open docs/internal/visual-demos/index.html`
→ click through the theme switcher + surfaces → tell me which direction per
surface (or "mix the X header with the Y sidebar"). I iterate the HTML until it's
exactly right, THEN we port to React/Astro. No production code moves until you
say "this one."
