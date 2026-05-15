// W986 — MockDriver deterministic cross-source invariant. Three-
// hundred-twelfth in the drift-guard series. Pins the apps/server/
// src/drivers/mock.ts in-memory deterministic driver primitive:
//
//   Header framing — 'Mock WebKit driver — in-memory, deterministic.
//   The mock simulates real WebKit behaviour at the contract level:
//     - createSession returns a deterministic driver session id
//       (counter-based)
//     - navigate/interact/wait honour configurable latency from .env
//     - getState returns canned, deterministic data per session
//     - capture returns canned bytes (small base64-encoded blob for
//       screenshots)
//     - destroy is idempotent'.
//
//   Determinism-by-design framing — 'This driver is deterministic by
//   design: same inputs → same outputs. Real WebKit will introduce
//   variance from network conditions, page randomness, etc.; the
//   mock does NOT. Anything that needs randomness has to be tested
//   against the real driver'.
//
//   TRIGGER_HOSTS 3-entry map — networkError 'error.driftstack-mock.
//     test', timeout 'timeout.driftstack-mock.test', http500
//     'http500.driftstack-mock.test'.
//
//   TRIGGER_SELECTORS 2-entry map — notFound '#nonexistent', hangs
//     '#hangs'.
//
//   PNG_1X1_TRANSPARENT_BASE64 canned 1x1 PNG.
//
//   InternalSession 7-field shape — driverSessionId + archetype +
//     V-169 purpose + currentUrl|null + currentTitle|null + destroyed
//     + opSeq (sequence counter).
//
//   V-169 mock framing — 'V-169 — captured for test inspection; mock
//   doesn't act on it'.
//
//   MockDriverOptions 3-field shape — navigateLatencyMs +
//     interactLatencyMs + fastForwardLatency (test seam).
//
//   Default latencies — navigate 120ms + interact 40ms +
//     fastForward false.
//
//   Session-id format — 'mock_ses_<8-zero-padded-counter>'.
//
//   capture 3-branch — 'screenshot' → 1x1 PNG base64 + 'dom_snapshot'
//     → '<!doctype html>...' utf8 + 'pdf' → '%PDF-1.4\nmock-pdf' base64.
//
//   destroy idempotent + requireSession DriverError on missing or
//     destroyed.
//
// stays in lockstep across apps/server/src/drivers/mock.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockDriver } from '../../src/drivers/mock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W986 MockDriver deterministic cross-source invariant', () => {
  // ─── Header determinism framing ──────────────────────────────

  it("CRITICAL apps/server/src/drivers/mock.ts header pins surface — 'Mock WebKit driver — in-memory, deterministic. The mock simulates real WebKit behaviour at the contract level' followed by 5-bullet inventory. The 5-bullet contract-level + deterministic framing is the V-156 mock-driver design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/Mock WebKit driver — in-memory, deterministic\./);
    expect(p).toMatch(/The mock simulates real WebKit behaviour at the contract level:/);
    expect(p).toMatch(
      /- createSession returns a deterministic driver session id \(counter-based\)/,
    );
    expect(p).toMatch(/- navigate\/interact\/wait honour configurable latency from \.env/);
    expect(p).toMatch(/- getState returns canned, deterministic data per session/);
    expect(p).toMatch(
      /- capture returns canned bytes \(small base64-encoded blob for screenshots\)/,
    );
    expect(p).toMatch(/- destroy is idempotent/);
  });

  it("CRITICAL determinism-by-design framing — 'This driver is deterministic by design: same inputs → same outputs. Real WebKit will introduce variance from network conditions, page randomness, etc.; the mock does NOT. Anything that needs randomness has to be tested against the real driver'. The same-in-same-out + variance-only-on-real-driver design is the mock contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/This driver is deterministic by design: same inputs → same outputs\. Real/);
    expect(p).toMatch(/WebKit will introduce variance from network conditions, page randomness,/);
    expect(p).toMatch(/etc\.; the mock does NOT\. Anything that needs randomness has to be tested/);
    expect(p).toMatch(/against the real driver\./);
  });

  // ─── TRIGGER_HOSTS 3 entries ─────────────────────────────────

  it("CRITICAL TRIGGER_HOSTS 3 entries — networkError 'error.driftstack-mock.test' + timeout 'timeout.driftstack-mock.test' + http500 'http500.driftstack-mock.test'. The 3-host trigger lets tests exercise DriverError + SessionTimeoutError + 5xx-status paths deterministically.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/networkError: 'error\.driftstack-mock\.test',/);
    expect(p).toMatch(/timeout: 'timeout\.driftstack-mock\.test',/);
    expect(p).toMatch(/http500: 'http500\.driftstack-mock\.test',/);
  });

  // ─── TRIGGER_SELECTORS 2 entries ─────────────────────────────

  it("CRITICAL TRIGGER_SELECTORS 2 entries — notFound '#nonexistent' + hangs '#hangs'. The 2-selector trigger covers element-not-found + element-never-interactable error paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/notFound: '#nonexistent',/);
    expect(p).toMatch(/hangs: '#hangs',/);
  });

  // ─── PNG_1X1 canned ──────────────────────────────────────────

  it('CRITICAL PNG_1X1_TRANSPARENT_BASE64 is the canned 1x1 transparent PNG. The single canned blob keeps screenshot tests fast + deterministic.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/const PNG_1X1_TRANSPARENT_BASE64 =/);
    expect(p).toMatch(
      /'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv\/lxKUAAAAASUVORK5CYII=';/,
    );
  });

  // ─── InternalSession 7-field shape ───────────────────────────

  it('CRITICAL InternalSession 7-field shape — driverSessionId + archetype + V-169 purpose + currentUrl|null + currentTitle|null + destroyed + opSeq (counter). The 7-field shape carries the per-mock-session state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/interface InternalSession \{/);
    expect(p).toMatch(/driverSessionId: DriverSessionId;/);
    expect(p).toMatch(/archetype: string;/);
    expect(p).toMatch(
      /purpose: 'production_customer' \| 'cumulative_rig_validation' \| 'test_domain_probe';/,
    );
    expect(p).toMatch(/currentUrl: string \| null;/);
    expect(p).toMatch(/currentTitle: string \| null;/);
    expect(p).toMatch(/destroyed: boolean;/);
    expect(p).toMatch(/opSeq: number;/);
  });

  it("CRITICAL V-169 mock framing — 'V-169 — captured for test inspection; mock doesn't act on it'. The captured-but-passive design lets tests reason about V-169 purpose dispatch without WebKit harness branching.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/V-169 — captured for test inspection; mock doesn't act on it\./);
  });

  // ─── MockDriverOptions 3-field shape ─────────────────────────

  it('CRITICAL MockDriverOptions 3-field shape — navigateLatencyMs + interactLatencyMs + fastForwardLatency. The 3-config knob design lets tests dial down latency.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/export interface MockDriverOptions \{/);
    expect(p).toMatch(/navigateLatencyMs\?: number;/);
    expect(p).toMatch(/interactLatencyMs\?: number;/);
    expect(p).toMatch(/fastForwardLatency\?: boolean;/);
  });

  it("CRITICAL fastForwardLatency framing — 'If true, replace await sleep(ms) with a no-op so tests run fast. Production-like usage (npm run dev) should leave this false'. The test-fast-prod-honest design is the mock's latency contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/If true, replace `await sleep\(ms\)` with a no-op so tests run fast\./);
    expect(p).toMatch(/Production-like usage \(npm run dev\) should leave this false\./);
  });

  // ─── Default latencies ───────────────────────────────────────

  it('CRITICAL default latencies — navigateLatencyMs 120 + interactLatencyMs 40 + fastForward false. The 120/40 split mirrors real navigate-vs-interact cost ratios.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/this\.navigateLatencyMs = opts\.navigateLatencyMs \?\? 120;/);
    expect(p).toMatch(/this\.interactLatencyMs = opts\.interactLatencyMs \?\? 40;/);
    expect(p).toMatch(/this\.fastForward = opts\.fastForwardLatency \?\? false;/);
  });

  // ─── Session-id format ───────────────────────────────────────

  it("CRITICAL session-id format — 'mock_ses_<8-zero-padded-counter>'. The 8-digit zero-pad lets up to 10^8 mock sessions before overflow + makes sort-by-id stable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(
      /const id = `mock_ses_\$\{this\.nextId\.toString\(\)\.padStart\(8, '0'\)\}`;/,
    );
  });

  // ─── capture 3-branch ────────────────────────────────────────

  it("CRITICAL capture 3-branch — 'screenshot' → 1x1 PNG base64 + 'dom_snapshot' → '<!doctype html>...' utf8 + 'pdf' → '%PDF-1.4\\nmock-pdf' base64. The 3-kind branch covers V-666 capture surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/if \(input\.kind === 'screenshot'\) \{/);
    expect(p).toMatch(/data: PNG_1X1_TRANSPARENT_BASE64,/);
    expect(p).toMatch(/if \(input\.kind === 'dom_snapshot'\) \{/);
    expect(p).toMatch(/const dom = '<!doctype html><html><body>mock<\/body><\/html>';/);
    expect(p).toMatch(
      /const pdfStub = Buffer\.from\('%PDF-1\.4\\nmock-pdf'\)\.toString\('base64'\);/,
    );
  });

  // ─── destroy idempotency ─────────────────────────────────────

  it("CRITICAL destroy idempotency framing — 'Idempotent — destroying an unknown session is a no-op'. The idempotent-destroy design lets cleanup paths run multiple times safely.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/\/\/ Idempotent — destroying an unknown session is a no-op\./);
  });

  // ─── requireSession DriverError ──────────────────────────────

  it("CRITICAL requireSession throws DriverError on missing-or-destroyed — 'Driver session not found: <id>'. The not-found-as-destroyed design rejects writes to torn-down sessions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/private requireSession\(id: DriverSessionId\): InternalSession \{/);
    expect(p).toMatch(/if \(!session \|\| session\.destroyed\) \{/);
    expect(p).toMatch(/throw new DriverError\(`Driver session not found: \$\{id\}`\);/);
  });

  // ─── sleep fastForward short-circuit ─────────────────────────

  it("CRITICAL sleep short-circuits when fastForward or ms <= 0 — 'if (this.fastForward || ms <= 0) return;'. The early-return is what makes fastForward an effective test-speed knob.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts'));
    expect(p).toMatch(/private async sleep\(ms: number\): Promise<void> \{/);
    expect(p).toMatch(/if \(this\.fastForward \|\| ms <= 0\) return;/);
    expect(p).toMatch(/await sleep\(ms\);/);
  });

  // ─── Runtime — createSession deterministic id ────────────────

  it("CRITICAL runtime — createSession returns a deterministic counter-based id. First session → 'mock_ses_00000001', second → 'mock_ses_00000002'.", async () => {
    const d = new MockDriver({ fastForwardLatency: true });
    const a = await d.createSession({ archetype: 'arch', purpose: 'production_customer' });
    const b = await d.createSession({ archetype: 'arch', purpose: 'production_customer' });
    expect(a.driverSessionId).toBe('mock_ses_00000001');
    expect(b.driverSessionId).toBe('mock_ses_00000002');
  });

  // ─── Runtime — navigate trigger hosts ────────────────────────

  it('CRITICAL runtime — navigate to networkError trigger throws DriverError. The trigger lets tests exercise the failure path deterministically.', async () => {
    const d = new MockDriver({ fastForwardLatency: true });
    const { driverSessionId } = await d.createSession({
      archetype: 'arch',
      purpose: 'production_customer',
    });
    await expect(
      d.navigate(driverSessionId, {
        url: 'https://error.driftstack-mock.test',
        timeoutMs: 1000,
        waitUntil: 'load',
      }),
    ).rejects.toThrow();
  });

  it('CRITICAL runtime — navigate to http500 trigger returns status 500. Status branching lets tests exercise non-2xx response paths.', async () => {
    const d = new MockDriver({ fastForwardLatency: true });
    const { driverSessionId } = await d.createSession({
      archetype: 'arch',
      purpose: 'production_customer',
    });
    const res = await d.navigate(driverSessionId, {
      url: 'https://http500.driftstack-mock.test',
      timeoutMs: 1000,
      waitUntil: 'load',
    });
    expect(res.status).toBe(500);
  });

  it('CRITICAL runtime — destroy is idempotent (no throw on missing session).', async () => {
    const d = new MockDriver({ fastForwardLatency: true });
    await expect(d.destroy('nonexistent_session_id')).resolves.toBeUndefined();
  });

  it('CRITICAL runtime — operations on destroyed session throw DriverError. The session-not-found error is what enforces session-lifecycle ordering.', async () => {
    const d = new MockDriver({ fastForwardLatency: true });
    const { driverSessionId } = await d.createSession({
      archetype: 'arch',
      purpose: 'production_customer',
    });
    await d.destroy(driverSessionId);
    await expect(d.getState(driverSessionId)).rejects.toThrow(/Driver session not found/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/mock-driver-deterministic-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
