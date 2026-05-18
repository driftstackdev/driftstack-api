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

  // v2-#8 Wave 2.C sub-slice 8.27 — TranscriptStream SSE consumer.
  it('startTranscriptStream() opens EventSource on /v1/agent-sessions/:id/transcript with ds_token fallback', () => {
    expect(body).toMatch(/new EventSource\(url\)/);
    expect(body).toMatch(/\/transcript\?ds_token=/);
    expect(body).toMatch(/encodeURIComponent\(token\)/);
  });

  it('transcript.entry event handler appends per-role styled li elements', () => {
    expect(body).toMatch(/addEventListener\('transcript\.entry'/);
    expect(body).toMatch(/role === 'user'/);
    expect(body).toMatch(/role === 'agent'/);
  });

  it('beforeunload closes the EventSource to prevent stream leak', () => {
    expect(body).toMatch(/addEventListener\('beforeunload'/);
    expect(body).toMatch(/evtSource\.close\(\)/);
  });

  // v2-#8 Wave 2.C sub-slice 8.28 — BundledLlmStatusPanel reader.
  it('renders bundled-llm-status fields (consent / cap / used) from GET /v1/account/me/bundled-llm-status', () => {
    expect(body).toMatch(/monthly_cap_usd_cents/);
    expect(body).toMatch(/used_this_month_cents/);
    expect(body).toMatch(/'opted in' : 'not enabled'/);
  });

  // v2-#8 Wave 2.C sub-slice 8.28.b — MessageComposer.
  it('message form POSTs /v1/agent-sessions/:id/message with { user_message }; 402 highlights bundled-llm panel', () => {
    expect(body).toMatch(/\/message',/);
    expect(body).toMatch(/JSON\.stringify\(\{ user_message: userMessage \}\)/);
    expect(body).toMatch(/status === 402/);
    expect(body).toMatch(/ring-2.*ring-amber-500\/50/);
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
});
