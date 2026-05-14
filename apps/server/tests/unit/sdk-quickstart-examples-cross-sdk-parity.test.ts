// W796 — cross-SDK quickstart-example parity. One-hundred-twenty-
// second in the drift-guard series. Pins the create-session →
// navigate → capture-screenshot → destroy flow in lockstep across
// sdk-typescript / sdk-python / sdk-go. These are the first-look
// programs every new integrator runs; drift here means a Go user and
// a TS user copy-paste different patterns from the same docs page.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/quickstart.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/examples/quickstart.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/examples/quickstart/main.go');

describe('W796 cross-SDK quickstart examples parity', () => {
  it('all 3 quickstart example files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Header / run-command ─────────────────────────────────────

  it('CRITICAL run-command framing pinned cross-SDK. All 3 quickstarts document a copy-pasteable run command with DRIFTSTACK_API_KEY=ds_live_… prefix. Drift would force readers to assemble the env-var name from elsewhere.', () => {
    expect(read(TS)).toMatch(
      /Run with: DRIFTSTACK_API_KEY=ds_live_\.\.\. npx tsx examples\/quickstart\.ts/,
    );
    expect(read(PY)).toMatch(/DRIFTSTACK_API_KEY=ds_live_… python examples\/quickstart\.py/);
    expect(read(GO)).toMatch(/DRIFTSTACK_API_KEY=ds_live_… go run \.\/examples\/quickstart/);
  });

  // ─── Env-var read + mandatory framing ─────────────────────────

  it('CRITICAL DRIFTSTACK_API_KEY env-var read is mandatory in all 3 SDKs — process.exit(1) / sys.exit(1) / log.Fatal on missing. Drift to silently constructing a default-keyless client would let users hit an opaque 401 instead of a clear "set this env var" message.', () => {
    // TS: process.env.DRIFTSTACK_API_KEY → process.exit(1)
    expect(read(TS)).toMatch(/const apiKey = process\.env\.DRIFTSTACK_API_KEY;/);
    expect(read(TS)).toMatch(/if \(!apiKey\) \{/);
    expect(read(TS)).toMatch(/process\.exit\(1\);/);

    // Python: os.environ.get → sys.exit(1)
    expect(read(PY)).toMatch(/api_key = os\.environ\.get\("DRIFTSTACK_API_KEY"\)/);
    expect(read(PY)).toMatch(/if not api_key:/);
    expect(read(PY)).toMatch(/return 1/);

    // Go: os.Getenv → log.Fatal
    expect(read(GO)).toMatch(/apiKey := os\.Getenv\("DRIFTSTACK_API_KEY"\)/);
    expect(read(GO)).toMatch(/if apiKey == "" \{/);
    expect(read(GO)).toMatch(/log\.Fatal\("DRIFTSTACK_API_KEY environment variable is required"\)/);
  });

  it('CRITICAL Python + Go optional DRIFTSTACK_BASE_URL framing pinned. The 2-SDK env-var convention lets non-prod users target staging. TS leaves base-URL to constructor opts (intentional minimal-surface bias).', () => {
    expect(read(PY)).toMatch(
      /base_url = os\.environ\.get\("DRIFTSTACK_BASE_URL", "https:\/\/api\.driftstack\.dev"\)/,
    );
    expect(read(GO)).toMatch(/if base := os\.Getenv\("DRIFTSTACK_BASE_URL"\); base != "" \{/);
    expect(read(GO)).toMatch(/opts = append\(opts, driftstack\.WithBaseURL\(base\)\)/);
    // TS deliberately omits BASE_URL handling in quickstart — keep it minimal.
    expect(read(TS)).not.toMatch(/DRIFTSTACK_BASE_URL/);
  });

  // ─── Client construction ──────────────────────────────────────

  it("CRITICAL client construction pinned cross-SDK. TS: 'new Driftstack({ apiKey })' + Python: 'Driftstack(api_key=..., base_url=...)' with context-manager + Go: 'driftstack.New(apiKey, opts...)' with Close(). Drift would force docs to re-document 3 different patterns.", () => {
    expect(read(TS)).toMatch(/const client = new Driftstack\(\{ apiKey \}\);/);
    expect(read(PY)).toMatch(/with Driftstack\(api_key=api_key, base_url=base_url\) as client:/);
    expect(read(GO)).toMatch(/client := driftstack\.New\(apiKey, opts\.\.\.\)/);
    expect(read(GO)).toMatch(/defer client\.Close\(\)/);
  });

  // ─── 4-step flow: create → navigate → capture → destroy ───────

  it("CRITICAL create-session 'quickstart' label pinned cross-SDK. The literal label 'quickstart' makes the example session easy to spot in the customer-dashboard session list. Drift to a different label would lose that signal.", () => {
    expect(read(TS)).toMatch(/client\.sessions\.create\(\{ label: 'quickstart' \}\)/);
    expect(read(PY)).toMatch(/client\.sessions\.create\(\{"label": "quickstart"\}\)/);
    expect(read(GO)).toMatch(
      /client\.Sessions\.Create\(ctx, &driftstack\.CreateSessionRequest\{Label: label\}\)/,
    );
    expect(read(GO)).toMatch(/label := "quickstart"/);
  });

  it("CRITICAL navigate destination pinned to https://example.com cross-SDK. IANA's reserved example domain is the universal safe demo target — drift to a real customer site would break the example whenever that site changed.", () => {
    expect(read(TS)).toMatch(/url: 'https:\/\/example\.com'/);
    expect(read(PY)).toMatch(/"url": "https:\/\/example\.com\/"/);
    expect(read(GO)).toMatch(/URL: +"https:\/\/example\.com\/"/);
  });

  it("CRITICAL TS-only wait_until: 'load' framing pinned. TS demonstrates the wait_until knob (load|networkidle|domcontentloaded); Python + Go quickstarts keep the default for brevity. Drift to dropping wait_until from TS would lose the only quickstart-level mention of this knob.", () => {
    expect(read(TS)).toMatch(/wait_until: 'load'/);
    // Python + Go don't include wait_until in quickstart — that's deliberate, they use the server default.
    expect(read(PY)).not.toMatch(/wait_until/);
    expect(read(GO)).not.toMatch(/WaitUntil/);
  });

  it("CRITICAL capture screenshot framing pinned cross-SDK. TS: { kind: 'screenshot', full_page: false } + Python: {'kind': 'screenshot'} + Go: { Kind: driftstack.CaptureScreenshot }. Drift would lose the canonical capture-kind enum demonstration.", () => {
    expect(read(TS)).toMatch(
      /client\.sessions\.capture\(session\.id, \{ kind: 'screenshot', full_page: false \}\)/,
    );
    expect(read(PY)).toMatch(
      /client\.sessions\.capture\(str\(session\.id\), \{"kind": "screenshot"\}\)/,
    );
    expect(read(GO)).toMatch(/Kind: driftstack\.CaptureScreenshot/);
  });

  it("CRITICAL byte_size / ByteSize accessor pinned cross-SDK. All 3 SDKs surface the capture's byte size — drift to a different field name would break the canonical 'print bytes for verification' demo pattern.", () => {
    expect(read(TS)).toMatch(/shot\.byte_size\.toString\(\)/);
    expect(read(PY)).toMatch(/capture\.byte_size/);
    expect(read(GO)).toMatch(/cap\.ByteSize/);
  });

  it('CRITICAL destroy session call pinned cross-SDK. TS: client.sessions.destroy(id) + Python: client.sessions.destroy(str(id)) + Go: client.Sessions.Destroy(ctx, id). Drift would break the canonical cleanup demonstration.', () => {
    expect(read(TS)).toMatch(/await client\.sessions\.destroy\(session\.id\)/);
    expect(read(PY)).toMatch(/client\.sessions\.destroy\(str\(session\.id\)\)/);
    expect(read(GO)).toMatch(/client\.Sessions\.Destroy\(ctx, session\.ID\)/);
  });

  it("CRITICAL idempotent-destroy 'safe to call twice' framing pinned in Python + Go. Drift to dropping this comment would lose the only quickstart-level documentation of the destroy contract.", () => {
    expect(read(PY)).toMatch(/Destroying a session is idempotent — safe to call twice\./);
    expect(read(GO)).toMatch(/Destroy\. Idempotent — safe to call twice\./);
  });

  // ─── Output / verification ────────────────────────────────────

  it('CRITICAL each step prints a verifiable signal cross-SDK. TS: console.log + Python: print + Go: fmt.Printf. Drift to a fully-silent quickstart would let copy-paste users wonder if anything happened.', () => {
    expect(read(TS)).toMatch(/console\.log\('creating session…'\)/);
    expect(read(PY)).toMatch(/print\(f"created session \{session\.id\}"\)/);
    expect(read(GO)).toMatch(/fmt\.Printf\("created session %s\\n", session\.ID\)/);
  });

  // ─── Import / package shape ───────────────────────────────────

  it("CRITICAL import shape pinned cross-SDK. TS: from '@driftstack/sdk' + Python: 'from driftstack import Driftstack' + Go: 'driftstack \"github.com/driftstackdev/driftstack-api/packages/sdk-go\"'. Drift to a different module-path or package-name would break every copy-paste consumer.", () => {
    expect(read(TS)).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(read(PY)).toMatch(/from driftstack import Driftstack/);
    expect(read(GO)).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
  });

  // ─── TS quickstart's eslint-disable + main().catch() pattern ──

  it("CRITICAL TS-only `eslint-disable no-console` + `main().catch(...)` shape pinned. The example needs console.log for output; the disable comment is the canonical 'this is a script, not library code' marker. Drift would either re-enable lint noise or drop the unhandled-rejection guard.", () => {
    expect(read(TS)).toMatch(/\/\* eslint-disable no-console \*\//);
    expect(read(TS)).toMatch(/main\(\)\.catch\(\(err: unknown\) => \{/);
    expect(read(TS)).toMatch(/process\.exit\(1\);[\s\S]*\}\);/);
  });

  // ─── Python __future__ + __main__ guard ───────────────────────

  it("CRITICAL Python `from __future__ import annotations` + `if __name__ == '__main__':` guard pinned. The future-import keeps type hints strings (so older 3.x runtimes don't choke); the __main__ guard makes the file safely importable.", () => {
    expect(read(PY)).toMatch(/from __future__ import annotations/);
    expect(read(PY)).toMatch(/if __name__ == "__main__":/);
    expect(read(PY)).toMatch(/sys\.exit\(main\(\)\)/);
  });

  // ─── Go context.Background() + log.Fatalf shape ───────────────

  it("CRITICAL Go `ctx := context.Background()` + `log.Fatalf` error handling pinned. Drift to swallowing errors or passing a request-scoped context would change the canonical 'this is a CLI demo, not a server handler' shape.", () => {
    expect(read(GO)).toMatch(/ctx := context\.Background\(\)/);
    expect(read(GO)).toMatch(/log\.Fatalf\("create session: %v", err\)/);
    expect(read(GO)).toMatch(/log\.Fatalf\("navigate: %v", err\)/);
    expect(read(GO)).toMatch(/log\.Fatalf\("capture: %v", err\)/);
  });

  // ─── Cross-SDK 4-step parallel-flow check ─────────────────────

  it("CRITICAL all 3 quickstarts demonstrate the same 4-step flow in the same order — create → navigate → capture → destroy. Drift would let the canonical 'first program' diverge in shape across SDKs, breaking the docs page that side-by-sides them.", () => {
    function indices(p: string, markers: RegExp[]): number[] {
      return markers.map((m) => {
        const i = p.search(m);
        expect(i, `marker not found: ${m}`).toBeGreaterThan(-1);
        return i;
      });
    }

    const tsIdx = indices(read(TS), [
      /sessions\.create/,
      /sessions\.navigate/,
      /sessions\.capture/,
      /sessions\.destroy/,
    ]);
    const pyIdx = indices(read(PY), [
      /sessions\.create/,
      /sessions\.navigate/,
      /sessions\.capture/,
      /sessions\.destroy/,
    ]);
    const goIdx = indices(read(GO), [
      /Sessions\.Create/,
      /Sessions\.Navigate/,
      /Sessions\.Capture/,
      /Sessions\.Destroy/,
    ]);

    for (const idx of [tsIdx, pyIdx, goIdx]) {
      expect(idx[0]).toBeLessThan(idx[1]!);
      expect(idx[1]).toBeLessThan(idx[2]!);
      expect(idx[2]).toBeLessThan(idx[3]!);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-quickstart-examples-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
