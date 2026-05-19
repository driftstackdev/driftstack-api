// v2-#8 Wave 2.C sub-slice 8.24 — drift guard for the new
// apps/customer-dashboard/src/pages/agent-sessions.astro page.
//
// Pins the wire-contract paths the page consumes so future refactors
// that rename the server-side routes break CI immediately.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/agent-sessions.astro');

describe('v2-#8 Wave 2.C sub-slice 8.24 agent-sessions page parity', () => {
  it('page exists at the expected path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const body = readFileSync(PAGE, 'utf8');

  it('imports DashboardLayout (consistent with the rest of the dashboard)', () => {
    expect(body).toMatch(/import DashboardLayout from '\.\.\/layouts\/DashboardLayout\.astro'/);
  });

  it('renders three operational modes (ai / manual / pair) with pair as default', () => {
    expect(body).toMatch(/value="ai"/);
    expect(body).toMatch(/value="manual"/);
    expect(body).toMatch(/value="pair"[^>]*checked/);
  });

  it('has slot scaffolding for each Wave 2.C sub-slice (8.25-8.28)', () => {
    // 8.25 ModeSelector — mode form + radios
    expect(body).toMatch(/data-section="mode-selector"/);
    expect(body).toMatch(/data-form="create-session"/);
    // 8.26 TakeoverHandbackButtons
    expect(body).toMatch(/data-section="takeover-handback"/);
    expect(body).toMatch(/data-action="takeover"/);
    expect(body).toMatch(/data-action="handback"/);
    // 8.27 TranscriptStream
    expect(body).toMatch(/data-list="transcript"/);
    // 8.28 BundledLlmStatusPanel
    expect(body).toMatch(/data-section="bundled-llm-status"/);
    expect(body).toMatch(/data-field="consent"/);
    expect(body).toMatch(/data-field="cap"/);
    // 8.28.b MessageComposer
    expect(body).toMatch(/data-form="message"/);
    expect(body).toMatch(/name="user_message"/);
  });

  it('activation-gate banner pre-rendered + hidden by default (revealed on 503 detection)', () => {
    expect(body).toMatch(/data-banner-feature-unavailable/);
    expect(body).toMatch(/Feature not enabled/);
    expect(body).toMatch(/AI agent layer requires an LLM key path/);
  });

  it('activation-gate banner carries actionable self-serve links to BYOK + bundled-LLM docs', () => {
    // Without these links the banner is a dead-end for self-serve
    // customers who don't have a Driftstack admin to ping. Pin both
    // hrefs + the data-link attributes so future copy edits can't
    // silently drop the affordance.
    expect(body).toMatch(/data-link="byok-anthropic"/);
    expect(body).toMatch(/data-link="bundled-llm"/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic\/"/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev\/api\/bundled-llm\/"/);
    // External link hygiene — target=_blank + rel noopener for both.
    const byokSlice = body.slice(
      body.indexOf('data-link="byok-anthropic"') - 200,
      body.indexOf('data-link="byok-anthropic"') + 200,
    );
    expect(byokSlice).toMatch(/target="_blank"/);
    expect(byokSlice).toMatch(/rel="noopener noreferrer"/);
  });

  it('unauthenticated banner pre-rendered + hidden by default (revealed when token absent)', () => {
    expect(body).toMatch(/data-banner-unauthenticated/);
    expect(body).toMatch(/Sign in to start an agent session/);
  });

  it('progressive-enhancement script probes the bundled-llm-status endpoint for activation-gate detection', () => {
    expect(body).toMatch(/\/v1\/account\/me\/bundled-llm-status/);
    expect(body).toMatch(/res\.status === 503/);
  });

  it('script reads ds_web_session_token from localStorage (consistent with rest of dashboard)', () => {
    expect(body).toMatch(/localStorage\.getItem\('ds_web_session_token'\)/);
  });

  it('page-root data-page="agent-sessions" attribute (consistent selector pattern)', () => {
    expect(body).toMatch(/data-page="agent-sessions"/);
  });

  // v2-#8 Wave 2.C sub-slice 8.26 — TakeoverHandbackButtons JS wiring.
  it('renderTakeoverHandback() branches on pair_mode_state.kind (all 4 active discriminators)', () => {
    // ai-driving → show takeover button
    // takeover-queued → show takeover button
    // human-driving → show handback button
    // handback-queued → show handback button
    expect(body).toMatch(/kind === 'ai-driving' \|\| kind === 'takeover-queued'/);
    expect(body).toMatch(/kind === 'human-driving' \|\| kind === 'handback-queued'/);
  });

  it('takeover button click POSTs to /v1/agent-sessions/{id}/takeover with { client_id }', () => {
    expect(body).toMatch(/\/takeover'/);
    expect(body).toMatch(/client_id: clientId/);
  });

  it('handback button click POSTs to /v1/agent-sessions/{id}/handback with empty body', () => {
    expect(body).toMatch(/\/handback'/);
    expect(body).toMatch(/JSON\.stringify\(\{\}\)/);
  });

  it('create-session form POSTs /v1/agent-sessions with { mode }; 503 reveals feature banner', () => {
    expect(body).toMatch(/method: 'POST'/);
    expect(body).toMatch(/JSON\.stringify\(\{ mode \}\)/);
    expect(body).toMatch(/r\.status === 503/);
    expect(body).toMatch(/featureBanner\.classList\.remove\('hidden'\)/);
  });

  it('create-session form non-503 errors fire typed toasts (HTTP for 4xx/5xx; network for fetch rejection) — was silently swallowed pre-fix', () => {
    // The catch branch distinguishes feature-unavailable (banner-
    // only), HTTP errors (toast with status), and network errors
    // (network-error toast). 503-feature-unavailable stays as banner
    // because the banner is more informative than a transient toast.
    expect(body).toMatch(/'Session create failed \(HTTP ' \+ msg\.slice\(5\) \+ '\)\.'/);
    expect(body).toMatch(/'Session create failed — network error\.'/);
    expect(body).toMatch(/msg === 'feature-unavailable'/);
  });

  // v2-#8 Wave 2.C sub-slice 8.27 — TranscriptStream SSE consumer.
  it('startTranscriptStream() opens EventSource on /v1/agent-sessions/:id/transcript with ds_token fallback', () => {
    expect(body).toMatch(/new EventSource\(url\)/);
    expect(body).toMatch(/\/transcript\?ds_token=/);
    expect(body).toMatch(/encodeURIComponent\(token\)/);
  });

  it('transcript.entry event handler appends per-role styled li elements — pins all 3 TranscriptEntry.role union members (user/agent/operator) so manual-mode operator turns render distinctly per the agent-decomposer.ts type-doc contract (drift to omitting the operator branch would silently fall back to the unknown-role bg-white/5 styling, contradicting the type definition)', () => {
    expect(body).toMatch(/addEventListener\('transcript\.entry'/);
    expect(body).toMatch(/role === 'user'/);
    expect(body).toMatch(/role === 'agent'/);
    expect(body).toMatch(/role === 'operator'/);
  });

  it('beforeunload closes the EventSource to prevent stream leak', () => {
    expect(body).toMatch(/addEventListener\('beforeunload'/);
    expect(body).toMatch(/evtSource\.close\(\)/);
  });

  // v2-#8 Wave 2.C sub-slice 8.28 — BundledLlmStatusPanel reader.
  // CRITICAL: GET /v1/account/me/bundled-llm-status returns `cap_cents`,
  // NOT `monthly_cap_usd_cents`. The settings endpoint uses
  // `monthly_cap_usd_cents`; the status endpoint uses `cap_cents`. The
  // previous skip pinned the WRONG field name and the dashboard JS
  // also read the wrong field, so the cap rendered as "$0.00" for
  // every customer. Fixed in the same slice that refreshed this
  // assertion.
  it('renders bundled-llm-status fields (consent / cap / used / remaining) from GET /v1/account/me/bundled-llm-status using cap_cents (not monthly_cap_usd_cents — that field name belongs to the SETTINGS endpoint). Slice 135 added the remaining_cents row since the server pre-derives Math.max(0, cap - used) and the customer-actionable number is "how much can I still spend"', () => {
    expect(body).toMatch(/cap_cents/);
    expect(body).toMatch(/used_this_month_cents/);
    expect(body).toMatch(/remaining_cents/);
    expect(body).toMatch(/data-field="remaining"/);
    expect(body).toMatch(/'opted in' : 'not enabled'/);
    // Drift-guard: the JS must NOT read `status.monthly_cap_usd_cents`
    // from the bundled-llm-status response — that field doesn't exist
    // there and would silently render "$0.00".
    expect(body).not.toMatch(/status\.monthly_cap_usd_cents/);
  });

  // v2-#8 Wave 2.C sub-slice 8.28.b — MessageComposer.
  it('message form POSTs /v1/agent-sessions/:id/message with { user_message }; 402 highlights bundled-llm panel', () => {
    expect(body).toMatch(/\/message',/);
    expect(body).toMatch(/JSON\.stringify\(\{ user_message: userMessage \}\)/);
    expect(body).toMatch(/status === 402/);
    expect(body).toMatch(/ring-2.*ring-amber-500\/50/);
  });

  it('message form 402 also fires a typed warn toast with body.detail (the ring alone reads as visual noise — toast names the BundledLlmBudgetExhausted / BundledLlmConsentRequired reason)', () => {
    // The 402 branch reads body.detail (problem+json) and falls back
    // to a generic copy when the body doesn't carry a string detail.
    expect(body).toMatch(/typeof body\.detail === 'string'/);
    expect(body).toMatch(/'Bundled-LLM budget required — see right rail\.'/);
    expect(body).toMatch(/showToast\('warn', detail\)/);
  });

  it('message form non-402 4xx → showToast error with HTTP status surfaced (consistent with takeover/handback)', () => {
    expect(body).toMatch(/'Message failed \(HTTP ' \+ status \+ '\)\.'/);
  });

  it('message form network-error (fetch rejection) → showToast error (consistent with takeover/handback)', () => {
    expect(body).toMatch(/'Message failed — network error\.'/);
  });

  // v2-#8 Wave 2.C sub-slice 8.26.b — toast surface for typed 409 errors.
  it('showToast() helper + ensureToastContainer() create a bottom-right toast stack', () => {
    expect(body).toMatch(/function showToast\(/);
    expect(body).toMatch(/function ensureToastContainer\(/);
    expect(body).toMatch(/data-toast-container/);
    expect(body).toMatch(/fixed bottom-4 right-4/);
    expect(body).toMatch(/setTimeout\(\(\) => \{[\s\S]+?toast\.remove\(\)/);
  });

  it('describePairModeError() composes a customer-visible message from the from + transition extension fields', () => {
    expect(body).toMatch(/function describePairModeError\(body\)/);
    expect(body).toMatch(/body\.from === 'string'/);
    expect(body).toMatch(/body\.transition === 'string'/);
    expect(body).toMatch(/Cannot/);
  });

  it('takeover + handback 409 with pair-mode-invalid-transition type → showToast warn (typed error surface)', () => {
    // The same regex hits BOTH takeover + handback handlers since
    // they share the same pattern.
    const occurrences = (
      body.match(/body\.type\.indexOf\('pair-mode-invalid-transition'\) !== -1/g) ?? []
    ).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('takeover + handback non-200 non-409 errors → showToast error with HTTP status surfaced', () => {
    expect(body).toMatch(/'Takeover failed \(HTTP '/);
    expect(body).toMatch(/'Handback failed \(HTTP '/);
  });

  it('takeover + handback network errors (fetch rejection) → showToast error with network framing', () => {
    expect(body).toMatch(/'Takeover failed — network error\.'/);
    expect(body).toMatch(/'Handback failed — network error\.'/);
  });

  // A11y pins — see commit 48ae3eb8 / docs(reference) trail. The
  // transcript list is a streaming live region; the message input
  // has no visible label, so an aria-label substitutes. Both must
  // stay in place — removing them would silently regress screen
  // reader UX without breaking visual layout.
  it('transcript list has aria-live="polite" + aria-label (streaming live region)', () => {
    expect(body).toMatch(
      /data-list="transcript"[\s\S]{0,200}aria-live="polite"[\s\S]{0,200}aria-label="Agent session transcript"/,
    );
  });

  it('message-composer input has an aria-label (no visible <label>, placeholder is not a label)', () => {
    expect(body).toMatch(/name="user_message"[\s\S]{0,200}aria-label="Message to the AI agent"/);
  });

  // LK arc — the dashboard surfaces the optional `livekit` field
  // from the session-create response as a right-rail info card.
  it('renders a Live video right-rail card hidden by default', () => {
    expect(body).toMatch(/data-section="livekit-info"/);
    expect(body).toMatch(/<h2[^>]*>\s*Live video\s*<\/h2>/);
    expect(body).toMatch(/class="hidden[^"]*"[\s\S]{0,500}data-section="livekit-info"/);
  });

  it('Live video card carries room + ws_url field placeholders', () => {
    expect(body).toMatch(/data-field="livekit-room"/);
    expect(body).toMatch(/data-field="livekit-ws-url"/);
  });

  it('Live video card cross-links to the docs.driftstack.dev guide', () => {
    expect(body).toMatch(/docs\.driftstack\.dev\/guides\/live-video/);
  });

  it('renderLivekitInfo() flips card visibility based on session.livekit presence', () => {
    expect(body).toMatch(/function renderLivekitInfo\(livekit\)/);
    expect(body).toMatch(/card\.classList\.remove\('hidden'\)/);
    expect(body).toMatch(/card\.classList\.add\('hidden'\)/);
  });

  it('renderLivekitInfo() never echoes the token (presentational consumer only)', () => {
    // The dashboard is presentational; the actual subscribe happens
    // in the gui-client. Token MUST NOT be rendered into the DOM
    // (would risk leaking via dev-tools / accidental clipboard).
    expect(body).toMatch(/Token is[\s\S]{0,50}intentionally NOT surfaced/);
  });

  it('session-create handler calls renderLivekitInfo with session.livekit', () => {
    expect(body).toMatch(/renderLivekitInfo\(session\.livekit\)/);
  });
});
