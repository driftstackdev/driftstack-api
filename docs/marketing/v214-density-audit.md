# V-214 — marketing site visitor-density audit

Audit of `/index`, `/pricing`, `/faq` for jargon-on-first-use and
inaccessible framing per the V-214 founder directive. The
working-tree drafts in `apps/marketing-site/src/pages/{index,pricing,faq}.astro`
apply the proposed redlines. Drafts stay uncommitted until founder
redline pass.

> **Scope-out**: `/security`, `/docs/*`, `/api-reference/*`,
> `/developers-quickstart`, `/self-hosted` are dev-audience-appropriate
> at current density per founder direction. Not modified.
>
> **Also untouched**: `/about` is at acceptable density post-V-213 trim.
> `/trust/sub-processors` is reference data.

## Findings

### `/index.astro`

| Section             | Phrase                                                       | Problem                                                           | Redline                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cumulative rig      | "iPhone Safari (iOS 18.7 / Safari 26.4) fingerprint surface" | "fingerprint surface" assumes reader knows what fingerprinting is | Add a short visitor-first paragraph explaining what "fingerprint" means in this context (the signals a website reads to identify the device) before the dense methodology paragraph |
| Cumulative rig      | "Match or P0 finding"                                        | Internal severity-tier jargon (P0) on a customer-facing page      | Replace with: "Every signal either matches the iPhone reference, or we treat the gap as a launch-blocker bug."                                                                      |
| Metering            | "Concurrent caps are the only meter"                         | "concurrent" first-mention without definition                     | Add visitor-first sentence: "Concurrent = how many sessions run at the same time, like browser tabs you'd have open at once."                                                       |
| Compliance          | "customer-controlled egress"                                 | "egress" jargon                                                   | Inline parenthetical: "egress (the network path your sessions use to reach the internet)"                                                                                           |
| Built-for-two cards | "Bundled LLM or BYOK for AI-driven sessions (Builder+)"      | BYOK undefined                                                    | Replace with: "Bundled LLM, or bring your own API key from OpenAI / Anthropic, for AI-driven sessions (Builder+)" — drops the acronym in favor of plain words on first use          |

### `/pricing.astro`

| Section                    | Phrase                                             | Problem                                                                                                                         | Redline                                                                                                                               |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Trial pack hero            | "299¢ of pre-paid credit, decremented at $0.18/hr" | Math-first framing instead of human-time framing                                                                                | Lead with "$2.99 buys ~16 hours of iPhone Safari sessions"; keep the credit / decrement detail as a follow-on for readers who want it |
| Tier tables (Manual + API) | "Concurrent sessions" row label                    | "Concurrent" undefined on first use                                                                                             | Lead the tier section with a one-line "Concurrent sessions = how many run at the same time" inline note above the tier-card grid      |
| Tier tables                | "BYOK (Anthropic key required)" cell value         | BYOK first-mention is INSIDE a tier-feature cell; the BYOK explainer block is BELOW the tier tables (visitor scans tiers first) | Move the BYOK / Bundled LLM explainer block ABOVE the API tier table OR add a 1-sentence "What's BYOK?" inline above the tables       |
| Tier tables                | "AI agent (LLM-driven sessions)" row label         | LLM acronym on first use                                                                                                        | Already paired with "(LLM-driven sessions)" — this is fine; LLM is mainstream-enough by now and the parenthetical helps               |

### `/faq.astro`

| Section            | Q/A                                                         | Problem                                                                                                                                        | Redline                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pricing model      | "How does concurrent metering work?"                        | Answer jumps straight to per-tier numbers without defining concurrency first                                                                   | Lead the answer with one visitor-first sentence: "Concurrent = the number of sessions you can run at the same time, like browser tabs you'd have open at once." Then the existing per-tier numbers. |
| Bundled LLM + BYOK | First entry "What is the bundled LLM?"                      | Defines bundled LLM but uses "BYOK" inline before defining it                                                                                  | Replace the BYOK acronym on first occurrence inside the answer with the explanation, then use BYOK as shorthand for the rest of the section                                                         |
| Pricing model      | "How does this compare to Chromium-cloud stealth services?" | Very dense ("user-agent strings, JavaScript Proxy traps over canvas / WebGL / navigator, monkeypatched Object.getOwnPropertyDescriptor calls") | **Leave dense** — this is the comparison answer for technical evaluators, who are exactly the audience that wants this depth. Per founder direction.                                                |
| Pricing model      | "What happens when I hit my concurrent cap?"                | "fail with HTTP 429 + a structured RFC 7807 problem-detail"                                                                                    | **Leave dense** — answer is for the developer audience; HTTP status + RFC names are signal of correctness, not bug                                                                                  |

### Out of scope (intentionally not modified)

- `/security` — dev-audience appropriate at current density.
- `/docs/*` + `/api-reference/*` + `/developers-quickstart/*` — same.
- `/self-hosted` — pricing-density audit didn't surface problems; visitor visiting /self-hosted has clear intent.
- `/trust/sub-processors` — reference data.
- `/about` — already trimmed in V-213.

## Cadence

1. ✅ Audit findings (this doc) — engineering scaffolding, commits.
2. 🔄 Working-tree drafts in `apps/marketing-site/src/pages/{index,pricing,faq}.astro` — Tier 3, NOT committed.
3. ⏳ Surface drafts for founder + chat-Claude redline pass.
4. ⏳ Apply redlines + commit on approval.
5. ⏳ Repeat per page if additional surfaces need same treatment.

## Why the redlines are minimal-not-rewrite

The current copy is mostly in correct company voice + good positioning. The visitor-density problem is jargon-on-first-use, not the surrounding paragraphs. Targeted parenthetical / lead-in additions fix the density without unsettling proven framing. If founder wants a broader rewrite (different positioning, different section ordering), that's a follow-up Tier 3 draft round, separately surfaced.
