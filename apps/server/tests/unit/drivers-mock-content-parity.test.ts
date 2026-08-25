// W431.C — drift guard for apps/server/src/drivers/mock.ts.
// In-memory deterministic mock driver. Drift here either breaks
// the determinism invariant (same inputs → different outputs) or
// drops a trigger-host/selector path (tests can no longer exercise
// the matching error branch the real driver will produce).
//
//   • Framing pinned: contract-level simulation;
//     counter-based session ids; configurable latency; canned
//     getState/capture data; idempotent destroy; trigger
//     hosts/selectors for error simulation.
//   • Determinism rationale pinned: same inputs → same outputs;
//     anything needing randomness must be tested against real driver.
//   • TRIGGER_HOSTS pinned: networkError + timeout + http500
//     (error.driftstack-mock.test / timeout.driftstack-mock.test /
//     http500.driftstack-mock.test).
//   • TRIGGER_SELECTORS pinned: notFound (#nonexistent) +
//     hangs (#hangs).
//   • PNG_1X1_TRANSPARENT_BASE64 constant pinned.
//   • InternalSession shape: V-169 purpose captured + opSeq.
//   • MockDriverOptions: navigateLatencyMs/interactLatencyMs +
//     fastForwardLatency.
//   • Defaults: navigateLatencyMs 120 + interactLatencyMs 40 +
//     fastForward false.
//   • Session id format: `mock_ses_${padStart(8, '0')}`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/drivers/mock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W431.C apps/server/src/drivers/mock.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: Mock WebKit driver — in-memory, deterministic; contract-level simulation', () => {
    expect(body).toMatch(/\/\/ Mock WebKit driver — in-memory, deterministic\./);
    expect(body).toMatch(
      /\/\/ The mock simulates real WebKit behaviour at the contract level:\s*\/\/\s*- createSession returns a deterministic driver session id \(counter-based\)\s*\/\/\s*- navigate\/interact\/wait honour configurable latency from \.env\s*\/\/\s*- getState returns canned, deterministic data per session\s*\/\/\s*- capture returns canned bytes \(small base64-encoded blob for screenshots\)\s*\/\/\s*- destroy is idempotent/,
    );
  });

  it('Error-simulation framing: trigger host/selector exercises every error path; TRIGGER_HOSTS + TRIGGER_SELECTORS rationale pinned', () => {
    expect(body).toMatch(
      /\/\/ Error simulation lets tests exercise every error path the real driver\s*\/\/ will produce\. A "trigger" host or selector causes the mock to throw the\s*\/\/ matching error — see TRIGGER_HOSTS and TRIGGER_SELECTORS below\./,
    );
  });

  it('Determinism rationale pinned: same inputs → same outputs; real WebKit introduces variance; mock does NOT; randomness must be tested against real driver', () => {
    expect(body).toMatch(
      /\/\/ This driver is deterministic by design: same inputs → same outputs\. Real\s*\/\/ WebKit will introduce variance from network conditions, page randomness,\s*\/\/ etc\.; the mock does NOT\. Anything that needs randomness has to be tested\s*\/\/ against the real driver\./,
    );
  });

  it("imports: sleep from 'node:timers/promises' + DriverError/SessionTimeoutError + full Driver type roster", () => {
    expect(body).toMatch(/import \{ setTimeout as sleep \} from 'node:timers\/promises';/);
    expect(body).toMatch(
      /import \{ DriverError, SessionTimeoutError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('TRIGGER_HOSTS pinned: networkError (error.) + timeout (timeout.) + http500 (http500.) all on .driftstack-mock.test', () => {
    expect(body).toMatch(
      /const TRIGGER_HOSTS = \{\s*\/\*\* Navigation throws DriverError \(network failure simulation\)\. \*\/\s*networkError: 'error\.driftstack-mock\.test',\s*\/\*\* Navigation hangs past timeout\. \*\/\s*timeout: 'timeout\.driftstack-mock\.test',\s*\/\*\* Navigation returns HTTP 4xx\/5xx\. \*\/\s*http500: 'http500\.driftstack-mock\.test',\s*\} as const;/,
    );
  });

  it('TRIGGER_SELECTORS pinned: notFound (#nonexistent) + hangs (#hangs)', () => {
    expect(body).toMatch(
      /const TRIGGER_SELECTORS = \{\s*\/\*\* interact\/wait fails because the selector matches nothing\. \*\/\s*notFound: '#nonexistent',\s*\/\*\* interact times out \(element exists but never becomes interactable\)\. \*\/\s*hangs: '#hangs',\s*\} as const;/,
    );
  });

  it('PNG_1X1_TRANSPARENT_BASE64 canned-screenshot constant pinned', () => {
    expect(body).toMatch(
      /\/\/ 1×1 transparent PNG, base64-encoded — used as canned screenshot payload\./,
    );
    expect(body).toMatch(
      /const PNG_1X1_TRANSPARENT_BASE64 =\s*'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv\/lxKUAAAAASUVORK5CYII=';/,
    );
  });

  it('login mock reports the complete submitted branch and never echoes credentials', () => {
    expect(body).toMatch(
      /async login\(sessionId: DriverSessionId, _input: LoginInput\): Promise<LoginResult> \{[\s\S]*?return \{\s*submitted: true,\s*credentialsTruncated: false,\s*loggedIn: true,\s*postLoginUrl: 'https:\/\/example\.com\/account',\s*durationMs: Date\.now\(\) - start,\s*\};/,
    );
    expect(body).not.toMatch(/return \{[^}]*password:/);
  });

  it('InternalSession shape pinned: driverSessionId + archetype + V-169 purpose + behavioralProfile (both captured for test inspection; mock doesnt act on them) + currentUrl/Title (nullable) + destroyed + opSeq', () => {
    expect(body).toMatch(
      /interface InternalSession \{\s*driverSessionId: DriverSessionId;\s*archetype: string;\s*\/\*\* V-169 — captured for test inspection; mock doesn't act on it\. \*\/\s*purpose: 'production_customer' \| 'cumulative_rig_validation' \| 'test_domain_probe';\s*\/\*\* Behavioural persona — captured for test inspection; mock doesn't act on it\. \*\/\s*behavioralProfile: BehavioralProfile \| undefined;\s*currentUrl: string \| null;\s*currentTitle: string \| null;\s*destroyed: boolean;/,
    );
    expect(body).toMatch(
      /\/\*\* Sequence counter incremented on every operation; lets tests reason about ordering\. \*\/\s*opSeq: number;/,
    );
  });

  it('MockDriverOptions: navigateLatencyMs + interactLatencyMs + fastForwardLatency (no-op sleep for fast tests)', () => {
    expect(body).toMatch(
      /export interface MockDriverOptions \{\s*\/\*\* Per-call simulated latency for navigate\. \*\/\s*navigateLatencyMs\?: number;\s*\/\*\* Per-call simulated latency for interact\/wait\. \*\/\s*interactLatencyMs\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\*\s*\*\s*If true, replace `await sleep\(ms\)` with a no-op so tests run fast\.\s*\*\s*Production-like usage \(npm run dev\) should leave this false\.\s*\*\/\s*fastForwardLatency\?: boolean;/,
    );
  });

  it('MockDriver constructor defaults: navigateLatencyMs 120 + interactLatencyMs 40 + fastForward false; private sessions Map + nextId starts at 1', () => {
    expect(body).toMatch(
      /export class MockDriver implements Driver \{\s*readonly searchCapability = 'simulation' as const;\s*readonly loginCapability = 'simulation' as const;\s*private readonly sessions = new Map<DriverSessionId, InternalSession>\(\);\s*private nextId = 1;/,
    );
    expect(body).toMatch(/this\.navigateLatencyMs = opts\.navigateLatencyMs \?\? 120;/);
    expect(body).toMatch(/this\.interactLatencyMs = opts\.interactLatencyMs \?\? 40;/);
    expect(body).toMatch(/this\.fastForward = opts\.fastForwardLatency \?\? false;/);
  });

  it("createSession: counter-based id format `mock_ses_${padStart(8,'0')}`; nextId increments; captures archetype + purpose + null url/title", () => {
    expect(body).toMatch(
      /const id = `mock_ses_\$\{this\.nextId\.toString\(\)\.padStart\(8, '0'\)\}`;\s*this\.nextId \+= 1;/,
    );
    expect(body).toMatch(
      /this\.sessions\.set\(id, \{\s*driverSessionId: id,\s*archetype: input\.archetype,\s*purpose: input\.purpose,\s*behavioralProfile: input\.behavioralProfile,\s*currentUrl: null,\s*currentTitle: null,\s*destroyed: false,\s*opSeq: 0,\s*\}\);/,
    );
  });

  it('navigate: URL parse failure -> DriverError; networkError trigger -> DriverError "Simulated network failure"; timeout trigger -> sleep then SessionTimeoutError; http500 trigger -> status 500 else 200', () => {
    expect(body).toMatch(
      /try \{\s*host = new URL\(input\.url\)\.host;\s*\} catch \{\s*throw new DriverError\(`Invalid URL: \$\{input\.url\}`\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(host === TRIGGER_HOSTS\.networkError\) \{\s*throw new DriverError\('Simulated network failure', \{ url: input\.url \}\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(host === TRIGGER_HOSTS\.timeout\) \{\s*\/\/ Pretend to hang for the full timeout, then throw\.\s*await this\.sleep\(input\.timeoutMs\);\s*throw new SessionTimeoutError\(input\.timeoutMs\);\s*\}/,
    );
    expect(body).toMatch(/const httpStatus = host === TRIGGER_HOSTS\.http500 \? 500 : 200;/);
    expect(body).toMatch(/session\.currentTitle = `Mock page for \$\{host\}`;/);
  });

  it('interact: selector === notFound -> DriverError "Selector not found"; selector === hangs -> sleep+SessionTimeoutError; selector destructured from action with "in" guard', () => {
    expect(body).toMatch(
      /const selector = 'selector' in input\.action \? input\.action\.selector : undefined;/,
    );
    expect(body).toMatch(
      /if \(selector === TRIGGER_SELECTORS\.notFound\) \{\s*throw new DriverError\(`Selector not found: \$\{selector\}`, \{ selector \}\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(selector === TRIGGER_SELECTORS\.hangs\) \{\s*await this\.sleep\(input\.timeoutMs\);\s*throw new SessionTimeoutError\(input\.timeoutMs\);\s*\}/,
    );
  });

  it('wait: time condition -> sleep min(ms, timeoutMs); selector + notFound -> sleep full timeout + satisfied:false; default -> sleep interactLatencyMs + satisfied:true', () => {
    expect(body).toMatch(
      /if \(input\.condition\.kind === 'time'\) \{\s*const ms = Math\.min\(input\.condition\.ms, input\.timeoutMs\);\s*const start = Date\.now\(\);\s*await this\.sleep\(ms\);\s*return \{ satisfied: true, durationMs: Date\.now\(\) - start \};\s*\}/,
    );
    expect(body).toMatch(
      /if \(\s*input\.condition\.kind === 'selector' &&\s*input\.condition\.selector === TRIGGER_SELECTORS\.notFound\s*\) \{\s*\/\/ Wait for selector that never appears: time out, satisfied=false\.\s*await this\.sleep\(input\.timeoutMs\);\s*return \{ satisfied: false, durationMs: input\.timeoutMs \};\s*\}/,
    );
  });

  it('capture: screenshot returns canned PNG base64; dom_snapshot returns canned utf8 HTML; default pdf returns base64 stub of "%PDF-1.4\\nmock-pdf"', () => {
    expect(body).toMatch(
      /if \(input\.kind === 'screenshot'\) \{\s*return \{\s*kind: 'screenshot',\s*data: PNG_1X1_TRANSPARENT_BASE64,\s*encoding: 'base64',\s*byteSize: Math\.floor\(\(PNG_1X1_TRANSPARENT_BASE64\.length \* 3\) \/ 4\),\s*durationMs: Date\.now\(\) - start,\s*\};\s*\}/,
    );
    expect(body).toMatch(
      /if \(input\.kind === 'dom_snapshot'\) \{\s*const dom = '<!doctype html><html><body>mock<\/body><\/html>';\s*return \{\s*kind: 'dom_snapshot',\s*data: dom,\s*encoding: 'utf8',\s*byteSize: Buffer\.byteLength\(dom, 'utf8'\),\s*durationMs: Date\.now\(\) - start,\s*\};\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ pdf\s*const pdfStub = Buffer\.from\('%PDF-1\.4\\nmock-pdf'\)\.toString\('base64'\);/,
    );
  });

  it('destroy: idempotent — looks up session, marks destroyed + deletes; destroying unknown session is no-op (no throw)', () => {
    expect(body).toMatch(
      /async destroy\(sessionId: DriverSessionId\): Promise<void> \{\s*await Promise\.resolve\(\);\s*const session = this\.sessions\.get\(sessionId\);\s*if \(session\) \{\s*session\.destroyed = true;\s*this\.sessions\.delete\(sessionId\);\s*\}\s*\/\/ Idempotent — destroying an unknown session is a no-op\.\s*\}/,
    );
  });

  it('requireSession helper: throws DriverError on missing-or-destroyed session; sleep helper short-circuits on fastForward OR ms<=0', () => {
    expect(body).toMatch(
      /private requireSession\(id: DriverSessionId\): InternalSession \{\s*const session = this\.sessions\.get\(id\);\s*if \(!session \|\| session\.destroyed\) \{\s*throw new DriverError\(`Driver session not found: \$\{id\}`\);\s*\}\s*return session;\s*\}/,
    );
    expect(body).toMatch(
      /private async sleep\(ms: number\): Promise<void> \{\s*if \(this\.fastForward \|\| ms <= 0\) return;\s*await sleep\(ms\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
