# Homepage copy + mobile-responsive enhancement plan

**Date staged**: 2026-05-17
**Source**: founder direct review (orchestrator session 2026-05-17, post-AUTO #2)
**Owner**: Agent 2 (driftstack-api) — slot AFTER current arc finishes
**Priority**: Tier-1 (copy + responsive CSS; no schema changes, no Tier-3 verdict needed)
**File primarily affected**: `apps/marketing-site/src/pages/index.astro` (722 lines)
**Parity test to update**: `apps/marketing-site/tests/unit/index-page-content-parity.test.ts` + `apps/server/tests/unit/marketing-site-pages-index-content-parity.test.ts`

---

## Why this plan exists

Founder did a top-to-bottom copy review of the marketing homepage and surfaced
9 concrete enhancement items. This doc captures each with a proposed replacement
draft so the implementer can land them as a focused commit arc.

Two additional findings the orchestrator caught during inventory:

- **STALE COPY** at line 480-481 — claims customer-configurable egress
  "not shipped", but Phase 1 SOCKS5 is COMPLETE per Wave 29-319. **This is a
  P0 marketing-accuracy bug**, fix as part of item #7.
- "Indistinguishable" word used 3× across the page (hero h1, what-sets-us-apart
  card, why-driftstack-works section) — founder flagged 2 in item #5; the
  third (line 140 card heading) should also vary for the rewrite.

---

## Scope rules (orchestrator-level guidance to implementer)

- **NO schema changes** — this is pure copy + Astro template + Tailwind classes
- **Preserve all anchor IDs** (`#trial-pack`, `#manual`, `#api`) — referenced
  from other pages
- **Preserve all internal links** (`/comparison`, `/pricing`, `/trust/*`,
  `/self-hosted`) — sitemap-aware
- **Run content-parity tests** after every commit — they enforce that the
  homepage and the API-server's smoke test agree on key phrases
- **Mobile breakpoints to verify**: 360px (small Android), 390px (iPhone 12-15),
  430px (iPhone 16 Pro), 768px (tablet portrait), 1024px+ (desktop)
- **No "Pre-launch" framing reintroduced** (memory rule, lines 130-132 of
  current index.astro document this)

---

## Item 1 — Hero mobile-friendliness (line 9-65)

**Current state**:

- Hero h1 uses `text-4xl md:text-5xl lg:text-6xl` — at 360-430px viewport,
  "Indistinguishable iPhone Safari." can overflow if the line-break point
  doesn't trigger right
- The 2-col grid (`md:grid-cols-2`) stacks correctly on mobile, BUT the
  right-side `<pre>` with the SDK code (`overflow-x-auto`) shows a wide
  horizontal scrollbar with no visual cue, and the code preview chrome
  (pip dots + filename) is too small to read on phones

**Proposed fixes** (CSS-only, no copy change to h1):

1. Hero h1: add `text-3xl` baseline for sub-400px, so `text-3xl sm:text-4xl md:text-5xl lg:text-6xl`
2. Hero `<p>` (line 25): change `text-lg` → `text-base sm:text-lg` to give breathing room on small screens
3. CTA row (line 31): currently `flex flex-wrap items-center gap-4` — works,
   but `Start for $2.99` + `Why not Browserless?` wrap onto 2 lines on 360px.
   Add `w-full sm:w-auto` to each `<a>` so they stack full-width on mobile (taller tap target, more readable)
4. Code preview block (line 40-62):
   - Add `text-[11px] sm:text-xs md:text-sm` to the `<code>` to shrink on phones
   - Add `max-h-[280px] sm:max-h-none` so it doesn't dominate phone viewport
   - Add scroll affordance: bottom-right corner `→` chevron or subtle gradient
     fade on the right edge to signal horizontal scroll
   - Filename label (line 45 `driftstack-typescript-sdk`) → wrap with
     `truncate` so it doesn't push pip dots off-screen on narrow viewports

**Acceptance**: tested at 360 / 390 / 430 / 768 px in DevTools, no horizontal
overflow on the body, h1 readable without zoom, code preview legible at 11px
minimum.

---

## Item 2 — "Why not Browserless?" CTA (line 33)

**Current**: secondary CTA reads `Why not Browserless?` linking to `/comparison`.

**Founder concern**: too aggressive / targeting a specific competitor on the
homepage CTA is bad form (free SEO/marketing for them, looks defensive).

**Proposed replacements** (pick one — implementer can choose):

| Option              | Label                      | Rationale                                                                 |
| ------------------- | -------------------------- | ------------------------------------------------------------------------- |
| **A (recommended)** | `Compare the alternatives` | Generic, points to `/comparison` which already lists multiple comparisons |
| B                   | `See how it stacks up`     | Friendly, less defensive                                                  |
| C                   | `How we compare`           | Shortest, neutral                                                         |
| D                   | `Why real WebKit?`         | Forward-positive — sells our differentiator instead of attacking theirs   |

**Orchestrator pick: Option A** for the `/comparison` URL semantics.

**Implementation**:

```astro
<a href="/comparison" class="btn-secondary">Compare the alternatives</a>
```

Verify `apps/marketing-site/src/pages/comparison.astro` still leads with the
relevant alternatives. If comparison.astro currently has a defensive opening
about Browserless specifically, that page also benefits from a "we compare
ourselves on technical fit, not on slamming competitors" reframe.

---

## Item 3 — Replace "Imperative SDK above. Sentence-driven agent below." section (line 75-123)

**Founder concern**: this section is the second large block of tech-dense
text + code, hits the customer with "two SDKs to learn" before they've
adopted the first. Better to demonstrate the **AI chat experience visually**
since that's the lower-friction onboarding path.

**Proposed replacement structure**:

```astro
<!-- Two ways to drive it — VISUAL agent demo replacing prior code block -->
<section class="relative border-t border-white/10">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <p class="section-label">Two ways to drive it</p>
    <h2 class="mt-6 max-w-3xl text-3xl font-semibold tracking-tight text-ink-primary md:text-4xl"
        style="letter-spacing: -0.02em;">
      Code it precisely, or just describe what you want.
    </h2>
    <p class="mt-5 max-w-prose text-base text-ink-secondary leading-relaxed">
      Engineers drive sessions directly with the SDK (see the hero example).
      Everyone else can open the dashboard, type the task in plain English, and
      watch the agent execute it live — with the option to export the result
      as code anytime.
    </p>

    <!-- Visual: stylized AI chat panel mockup (HTML/CSS, no live JS — static
         demonstration of the conversation pattern) -->
    <div class="mt-10 grid gap-6 md:grid-cols-[1fr_1fr] md:items-stretch">
      <!-- Left: the chat conversation -->
      <div class="card overflow-hidden">
        <div class="border-b border-white/10 bg-white/[0.02] px-5 py-3
                    flex items-center gap-2 text-xs text-ink-muted">
          <span class="size-2 rounded-full bg-glow-red"></span>
          <span class="font-mono">AI agent — session #a8c9e</span>
        </div>
        <div class="space-y-4 p-5 text-sm">
          <!-- User bubble -->
          <div class="flex gap-3">
            <span class="size-7 shrink-0 rounded-full bg-glow-red/20
                         flex items-center justify-center text-xs">you</span>
            <p class="rounded-lg bg-white/[0.03] px-4 py-3 text-ink-primary">
              Log in with the test account, open the revenue dashboard,
              and screenshot the chart for the last 30 days.
            </p>
          </div>
          <!-- Agent bubble — multi-step transcript -->
          <div class="flex gap-3">
            <span class="size-7 shrink-0 rounded-full bg-ink-primary/10
                         flex items-center justify-center text-xs">AI</span>
            <div class="space-y-2 text-ink-secondary">
              <p class="rounded-lg bg-white/[0.02] px-4 py-3">
                Planning 4 intents: <span class="font-mono text-glow-red">navigate</span>,
                <span class="font-mono text-glow-red">fillForm</span>,
                <span class="font-mono text-glow-red">click</span>,
                <span class="font-mono text-glow-red">screenshot</span>.
              </p>
              <p class="rounded-lg bg-white/[0.02] px-4 py-3">
                <span class="font-mono text-ink-muted">[14:32:01]</span>
                Logged in. Navigating to /dashboard/revenue…
              </p>
              <p class="rounded-lg bg-white/[0.02] px-4 py-3">
                <span class="font-mono text-ink-muted">[14:32:04]</span>
                Screenshot captured · <a href="#" class="text-glow-red underline underline-offset-4">view</a>
              </p>
            </div>
          </div>
        </div>
        <div class="border-t border-white/10 bg-white/[0.02] px-5 py-3
                    flex items-center justify-between text-xs">
          <span class="text-ink-muted">3 intents · 4.2s · iPhone 16 Pro</span>
          <button class="text-glow-red hover:text-glow-red-soft">
            Export as SDK code →
          </button>
        </div>
      </div>

      <!-- Right: live preview pane stub -->
      <div class="card overflow-hidden flex flex-col">
        <div class="border-b border-white/10 bg-white/[0.02] px-5 py-3
                    flex items-center gap-2 text-xs text-ink-muted">
          <span class="size-2 rounded-full bg-green-500"></span>
          <span class="font-mono">Live preview — &lt;livekit-room&gt;</span>
        </div>
        <div class="relative flex-1 min-h-[280px] bg-black/40
                    flex items-center justify-center">
          <!-- Placeholder for actual screenshot/video; can be a static
               iPhone-frame mockup PNG initially -->
          <span class="text-xs text-ink-muted font-mono">
            [ iPhone Safari · live preview ]
          </span>
        </div>
        <div class="border-t border-white/10 bg-white/[0.02] px-5 py-3
                    text-xs text-ink-muted">
          Watch in real time · 95ms median latency
        </div>
      </div>
    </div>

    <p class="mt-6 max-w-prose text-sm text-ink-muted">
      The chat agent is the fast path for one-off tasks and explorations.
      Click <strong class="text-ink-primary">Export as SDK code</strong> to
      lift the decomposed intent log into a reusable script — same engine,
      same fingerprint, no agent overhead on repeat runs.
    </p>
  </div>
</section>
```

**Mobile**: at md:`grid-cols-[1fr_1fr]` collapses to single column stacked,
chat on top + preview below. Preview min-height stays 280px so it doesn't
collapse to a sliver on mobile.

**Why this is better than the current section**:

- Customer SEES the chat experience instead of reading about it
- Eliminates the second large `<pre><code>` block (less code repetition on
  the homepage)
- "Export as SDK code" button surfaces the conversion path visually
- Live-preview pane plants the LiveKit streaming feature

**Open question for implementer**: should the live preview be a real
embedded LiveKit demo (auth-gated, costs $0 for unauth visitors) or a static
iPhone-frame mockup PNG initially? Recommend mockup for v1.0 marketing
launch; embed-real-livekit can be a follow-up.

---

## Item 4 — "No 'works on my Mac, fails on iPhone' surprises" (line 176)

**Founder concern**: the phrase reads awkwardly — "works on my Mac"
implies the dev's Mac, but in QA context it's actually about test
environments (Mac Chrome, headless Chrome) failing to predict iPhone Safari
behavior. The current phrasing is half-cliche, half-confusing.

**Proposed replacement**:

```astro
<p class="mt-2 text-sm text-ink-secondary leading-relaxed">
  Run end-to-end tests against the exact engine your iOS users run.
  Same rendering, same JavaScript timing, same quirks — so the bug you
  reproduce in CI is the same bug your users hit in production.
</p>
```

Alternative wording options if implementer prefers:

- _"Catch iOS-only bugs in CI, not in customer support tickets."_
- _"The tests pass on your laptop and the bug ships to iPhone anyway. Not with this."_
- _"Same engine in CI as on your customers' phones. Bugs you reproduce in CI are bugs you can fix before launch."_

**Orchestrator pick**: the first proposal (current paragraph reworded) — it
keeps the rhythm of the surrounding cards.

---

## Item 5 — "Indistinguishable" duplication (lines 21 / 140 / 271)

**Founder concern**: 2 distinct uses of "Indistinguishable" plus 1 in the
what-sets-us-apart card = 3 total. Reads repetitive.

**Currents**:

- Line 21 (hero h1): `<span>Indistinguishable iPhone Safari.</span>`
- Line 140 (card): `<span class="text-base font-semibold">Indistinguishable</span>`
- Line 271 (why-driftstack-works hero): `<span>Indistinguishable from a real iPhone.</span>`

**Proposed variation**:

| Location                        | KEEP / REPLACE                                                                                                                       | Suggested replacement                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Line 21 (hero h1)               | **KEEP** "Indistinguishable iPhone Safari."                                                                                          | This is the primary brand line — owns the word        |
| Line 140 (card)                 | **REPLACE** "Indistinguishable" → `Population-matched`                                                                               | Technical, accurate to the canvas-hash claim under it |
| Line 271 (why-driftstack-works) | **REPLACE** "Indistinguishable from a real iPhone." → `One iPhone among millions.` OR `Identical to a real iPhone, not approximate.` | Different angle, same point                           |

**Orchestrator pick**: card→`Population-matched`, why-works→`One iPhone among millions.`

The card change pairs naturally with the description below it ("Canvas + WebGL
hashes match the real-iPhone population — not unique-per-session").

---

## Item 6 — "Reference device: iPhone 16 Pro, iOS 18.7, Safari 26.4" (lines 285-289)

**Founder concern**: by launch we'll support **multiple iPhones + Safari 26.5**,
not just one. Current text implies single-archetype lock.

**Status check**: per `ORCHESTRATOR-STATE.md`, the v1.0 Tier-3 verdict
(2026-04-29 D-2026-04-29-07) locked single archetype iPhone 16 Pro / iOS 18.7
/ Safari 26.4 for v1.0. Founder is now signaling that the actual launch shape
is multi-iPhone + Safari 26.5. **This may itself be a Tier-3 verdict shift** —
implementer should NOT update copy that promises multi-archetype unless
founder confirms the Tier-3 verdict is being updated.

**Two paths**:

### Path A — Founder confirms multi-archetype + Safari 26.5 at launch

Replace lines 285-289 with:

```astro
<p class="mt-4 max-w-prose text-base text-ink-secondary leading-relaxed">
  We match the iPhone families your users are actually on — iPhone 15 Pro,
  iPhone 16 Pro, and the current iPhone 17 lineup, across the iOS versions
  Apple still ships Safari updates for (iOS 18.7 / Safari 26.4, and
  Safari 26.5 as it rolls out). If any measurable signal differs from what
  the real phone sends, it's a launch-blocking bug — and we fix the engine,
  not a JavaScript wrapper around it.
</p>
```

### Path B — Founder keeps single-archetype v1.0 (current Tier-3 verdict holds)

Soften the current text to acknowledge expansion roadmap:

```astro
<p class="mt-4 max-w-prose text-base text-ink-secondary leading-relaxed">
  v1.0 reference device: iPhone 16 Pro on iOS 18.7 / Safari 26.4. Additional
  iPhones and Safari 26.5 land on the roadmap as their reference captures
  pass our cumulative-rig parity bar. If any measurable signal differs from
  what the reference phone sends, it's a launch-blocking bug — and we fix
  the engine, not a JavaScript wrapper around it.
</p>
```

**Orchestrator note**: this is the ONE item in the plan that requires founder
verdict on Tier-3 (multi-archetype-at-launch) before implementation. Implementer
must SURFACE this choice, not autonomously commit either path. Stage as
question to founder in handoff doc.

---

## Item 7 — Egress (SOCKS5 UDP / OpenVPN / WireGuard) clarity + STALE COPY FIX

**Founder concern**: should make it clear that we support **SOCKS5 with UDP**
fully, plus **OpenVPN configs** and **WireGuard configs**.

**STALE COPY BUG caught by orchestrator** (line 480-481):

```astro
<span class="text-ink-muted"># Roadmap — customer-configurable egress</span><br />
<span class="text-ink-muted">→ SOCKS5 / OpenVPN / WireGuard (not shipped)</span>
```

Per Wave 29-319, **Phase 1 SOCKS5 is COMPLETE**. The "not shipped" framing
is now factually wrong and a marketing-accuracy bug.

**Proposed full rewrite of the compliance code-block (lines 473-483)**:

```astro
<div class="md:col-span-2">
  <div class="code-preview p-5">
    <span class="text-ink-muted"># Egress — your proxy, your call</span><br />
    <span class="arrow-bullet">→</span> SOCKS5 (TCP + UDP ASSOCIATE) — live<br />
    <span class="arrow-bullet">→</span> WireGuard config — live<br />
    <span class="arrow-bullet">→</span> OpenVPN config — live<br />
    <br />
    <span class="text-ink-muted"># All 3 protocols at launch.</span><br />
    <span class="text-ink-muted"># UDP / QUIC / HTTP3 work end-to-end.</span><br />
    <span class="text-ink-muted"># Sessions cannot egress without a proxy.</span>
  </div>
</div>
```

Verify against `docs/internal/customer-configurable-egress-design.md` for
exact phrasing on the "fail-fast no-egress-without-proxy" guarantee — that's a
strong customer signal worth preserving in the copy.

**Also update body paragraph (lines 463-471)**:

```astro
<p class="mt-4 max-w-prose text-base text-ink-secondary leading-relaxed">
  Plug in your own egress — SOCKS5 (with full UDP support for QUIC/HTTP3),
  WireGuard, or OpenVPN. Pick the protocol your proxy provider gives you;
  we'll route through it. Sessions are configured to fail closed: no
  proxy = no egress, ever. Implementation details on
  <a href="/trust/security-overview" class="text-glow-red underline underline-offset-4 hover:text-glow-red-soft"
    >/trust/security-overview</a>.
</p>
```

**Sweep**: also check `/comparison`, `/security`, and `/self-hosted` pages
for the same "not shipped" framing that's now stale post-Wave 29-319.
Run `grep -rn "not shipped" apps/marketing-site/src/pages/` to catch
all instances.

---

## Item 8 — EU compliance section simplification (lines 440-486)

**Founder concern**: current copy lists "Database, object storage, and compute
all run in the EU, single-region. We log session metadata only — when…" —
the average customer doesn't care about infrastructure-tier detail on a
marketing homepage. Move infra detail to `/trust/security-overview` or
`/trust/sub-processors` where it belongs.

**Proposed simplification of body paragraph (lines 451-462)**:

```astro
<p class="mt-6 max-w-prose text-base text-ink-secondary leading-relaxed">
  Your data stays in the EU. We don't log what your sessions visit or do —
  only the operational metadata we need to bill (session duration, archetype,
  cap usage). Full data residency + sub-processor breakdown at
  <a href="/trust/sub-processors" class="text-glow-red underline underline-offset-4 hover:text-glow-red-soft"
    >/trust/sub-processors</a>.
</p>
```

That's it for the body — two sentences, plain English, link out for detail
seekers.

**Header may also be reworded** (line 449):

- Current: `Customer data stays in the EU.`
- Proposed: `Your data, your jurisdiction.` (more inviting, less infra-y)
- Alt: `EU-only by default.`

**Orchestrator pick**: `EU-only by default.` — short, clear, scans well.

---

## Item 9 — Additional homepage improvements (orchestrator-spotted)

While reading 722 lines top-to-bottom, found these worth surfacing:

### 9a. Hero subtitle (line 25-30) — slight reframe for clarity

**Current**: "Real WebKit — the engine every iPhone ships. Canvas + WebGL
hashes match the millions of iPhones in the wild, not the unique-per-session
leak every Chromium-stealth API surfaces."

This is dense and competitor-attacking (subtle Chromium-stealth jab).
Proposed softer + more positive variant:

> "We run Apple's WebKit — the same browser engine that ships on every
> iPhone. Your canvas, WebGL, and audio fingerprints match the millions of
> iPhones in the wild. Drive sessions from TypeScript, Python, Go, or the
> dashboard."

### 9b. "Three SDKs. One HTTPS API. Slots into anything." (line 217)

This headline is good. Consider promoting it higher on the page — currently
it's section 6 of 15. Customers who scroll past hero deserve to see the
"works with Playwright/n8n/curl" message sooner.

### 9c. "Apple's engine. Not a Chromium copy." (line 389)

Strong line, but follows a content section that already made the WebKit
point twice (hero + "what detection systems see"). Consider:

- Merging this section with "What detection systems see" (consolidate
  WebKit-not-Chromium into one strong block instead of three soft ones), OR
- Repurposing this slot for a customer-quote testimonial when design-partner
  beta customers exist (Q3 2026)

### 9d. Final CTA (line 703-721) — A/B candidate

"See it for yourself. $2.99." is strong. Consider testing against:

- "Try the real engine. $2.99."
- "Stop fighting detection. $2.99."

Defer A/B until customer base supports stat-sig testing (~100+ trials/wk).

### 9e. Mobile sticky CTA (NEW recommendation)

Add a sticky bottom CTA on mobile only (`md:hidden`) showing
`[Start for $2.99]` so it's always tappable as the visitor scrolls. Pattern
common on landing pages, increases conversion 8-15% per CRO literature.

```astro
<!-- Mobile sticky CTA -->
<div class="fixed bottom-0 inset-x-0 z-40 md:hidden
            border-t border-white/10 bg-black/90 backdrop-blur-sm px-4 py-3">
  <a href="/pricing#trial-pack" class="btn-primary w-full text-center">
    Start for $2.99
  </a>
</div>
```

### 9f. Code-block copy button

Both code-preview blocks (hero + "two ways to drive it") would benefit
from a top-right copy-to-clipboard button. Trivial JS, big UX win.

### 9g. Sub-processor link parity

Multiple sections link to `/trust/sub-processors` — verify the page exists
and is complete. If not, those links are 404 traps.

---

## Test plan (acceptance criteria for this arc)

1. **Visual regression** (Playwright snapshot tests at 360 / 430 / 768 /
   1024 / 1440 px viewports) — no overflow, no layout breaks
2. **Content parity tests pass** —
   `apps/marketing-site/tests/unit/index-page-content-parity.test.ts` and
   `apps/server/tests/unit/marketing-site-pages-index-content-parity.test.ts`
   updated to reflect new copy; both pass
3. **No 404 links** — `npx linkinator https://staging.driftstack.dev/` clean
4. **Lighthouse** — Mobile Performance ≥ 90, Mobile Accessibility ≥ 95
   (current baseline should be at or above; don't regress)
5. **Manual mobile spot-check** — open staging on real iPhone (founder Mac
   has Safari), verify hero readable + code preview legible + sticky CTA
   visible
6. **Tier-3 surface item** — per Item 6, founder needs to confirm
   multi-archetype-at-launch verdict OR keep single-archetype v1.0; do not
   commit Path A without explicit verdict

---

## Suggested commit shape

Land as 3-5 focused commits, NOT one giant rewrite:

1. `fix(marketing-site): stale 'not shipped' egress copy — Phase 1 SOCKS5 LIVE` (item 7 stale fix)
2. `feat(marketing-site): mobile-responsive hero + code-preview sizing` (item 1)
3. `feat(marketing-site): replace 'two ways to drive it' code block with visual AI chat demo` (item 3)
4. `chore(marketing-site): copy enhancements — Browserless CTA, dedupe "Indistinguishable", simplify EU compliance` (items 2 + 5 + 8 + 4)
5. `feat(marketing-site): mobile sticky CTA + code-block copy button` (items 9e + 9f)

Item 6 (Tier-3-gated) lands as a separate commit AFTER founder verdict.
Items 9a-9d are optional polish — slot when convenient or skip.

---

## References

- `apps/marketing-site/src/pages/index.astro` — primary file (722 lines, 15 sections)
- `apps/marketing-site/tests/unit/index-page-content-parity.test.ts` — content invariant
- `apps/server/tests/unit/marketing-site-pages-index-content-parity.test.ts` — cross-source parity
- `ORCHESTRATOR-STATE.md` Tier-3 row 2026-04-29 (D-2026-04-29-07) — single archetype lock that Item 6 may revise
- `docs/internal/customer-configurable-egress-design.md` — source of truth for egress copy
- `ORCHESTRATOR-STATE.md` Tier-3 row 2026-05-16 — "EGRESS Phase 1 SOCKS5 COMPLETE per Wave 29-319" (the row that makes line 480-481 "not shipped" stale)
- `docs/internal/2026-05-16-frontend-overhaul-handoff.md` — prior handoff doc; style template

---

## Founder verdict items surfaced by this plan

1. **Item 6**: multi-archetype + Safari 26.5 at launch — Tier-3 verdict shift?
   (orchestrator cannot lock autonomously)
2. **Item 9b** (consolidation question): merge "Apple's engine" section into
   "What detection systems see" or keep separate? — minor, implementer can decide

All other items are Tier-1 (copy + responsive CSS); implementer can fire
autonomously after current arc finishes.
