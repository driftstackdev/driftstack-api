// W779 — apps/docs sdk/{typescript,python,go}-quickstart.md triplet
// structural-parity guard. One-hundred-fifth in the cross-SDK drift-
// guard series. Closes the apps/docs/sdk/ subtree sweep (7/7
// covered: index + error-handling + versioning + installation +
// 3 quickstarts).
//
// Drift to one quickstart while the others stay would let the 3-
// SDK identical-shape claim from W775 SDK-index slip.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');
const PY_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md');
const GO_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/go-quickstart.md');

describe('W779 docs /sdk quickstart triplet content parity', () => {
  it('All 3 quickstart files exist at canonical paths', () => {
    expect(existsSync(TS_PAGE)).toBe(true);
    expect(existsSync(PY_PAGE)).toBe(true);
    expect(existsSync(GO_PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter titles pinned. TypeScript / Node.js + Python + Go.', () => {
    expect(read(TS_PAGE)).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: TypeScript \/ Node\.js quickstart\n/,
    );
    expect(read(PY_PAGE)).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Python quickstart\n/,
    );
    expect(read(GO_PAGE)).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Go quickstart\n/,
    );
  });

  it("CRITICAL '5-minute' framing pinned in all 3. 'laser-focused 5-minute path to a working <lang> Driftstack session' is the cross-SDK header promise.", () => {
    expect(read(TS_PAGE)).toMatch(
      /laser-focused 5-minute path to a working TypeScript Driftstack\s*\n?session\./,
    );
    expect(read(PY_PAGE)).toMatch(
      /laser-focused 5-minute path to a working Python Driftstack\s*\n?session\./,
    );
    expect(read(GO_PAGE)).toMatch(
      /laser-focused 5-minute path to a working Go Driftstack\s*\n?session\./,
    );
  });

  it("CRITICAL combined-quickstart cross-reference pinned in all 3. The 'For the multi-language overview see the [combined quickstart](/quickstart/)' link is the canonical cross-SDK nav.", () => {
    for (const PAGE of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      expect(read(PAGE)).toMatch(/\[combined quickstart\]\(\/quickstart\/\)/);
    }
  });

  it('CRITICAL 5-section structure pinned in all 3 — Prerequisites + Install + Configure + Run a session + Error handling + Webhooks (optional). The numbered sections (1-5) are the cross-SDK quickstart shape.', () => {
    for (const PAGE of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      const content = read(PAGE);
      expect(content).toMatch(/## Prerequisites/);
      expect(content).toMatch(/## 1\. Install/);
      expect(content).toMatch(/## 2\. Configure the client/);
      expect(content).toMatch(/## 3\. Run a session/);
      expect(content).toMatch(/## 4\. Error handling/);
      expect(content).toMatch(/## 5\. Webhooks \(optional\)/);
    }
  });

  it("CRITICAL Driftstack API key prerequisite framing pinned in all 3. 'Mint one at app.driftstack.dev/api-keys' link is the cross-SDK signup path.", () => {
    for (const PAGE of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      const content = read(PAGE);
      expect(content).toMatch(
        /\[app\.driftstack\.dev\/api-keys\]\(https:\/\/app\.driftstack\.dev\/api-keys\/\)/,
      );
      expect(content).not.toMatch(/\]\(https:\/\/app\.driftstack\.dev\/api-keys\)/);
    }
  });

  it('CRITICAL TS Node-18+ prerequisite pinned. Node 22 LTS recommended + engines.node ">=18" + \'built / tested against the same toolchain Driftstack runs in production\'.', () => {
    const p = read(TS_PAGE);

    expect(p).toMatch(/Node\.js 18\+ \(Node 22 LTS recommended; the SDK declares/);
    expect(p).toMatch(/`engines\.node: ">=18"`/);
    expect(p).toMatch(
      /built \/ tested against the same\s*\n?\s+toolchain Driftstack runs in production/,
    );
  });

  it("CRITICAL Python 3.10+ prerequisite pinned. The 'SDK uses modern type hints + structural matches' framing matches W778 installation page.", () => {
    const p = read(PY_PAGE);

    expect(p).toMatch(/Python 3\.10\+ \(the SDK uses modern type hints \+ structural matches\)\./);
  });

  it("CRITICAL Go 1.22+ prerequisite pinned (2026-06-24). The previous pin asserted 'Go 1.21+' but packages/sdk-go/go.mod declares `go 1.22` (and installation.md already says 1.22+). The 'SDK uses generic constraints + slices package' framing explains the toolchain floor.", () => {
    const p = read(GO_PAGE);

    expect(p).toMatch(/Go 1\.22\+ \(the SDK uses generic constraints \+ `slices` package\)\./);
    // The stale 1.21 floor must NOT return (go.mod declares go 1.22).
    expect(p).not.toMatch(/Go 1\.21\+/);
  });

  it('CRITICAL 3-language install commands pinned. TS:npm/pnpm/yarn add @driftstack/sdk + Python:pip/uv/poetry driftstack-sdk + Go:go get driftstackdev/...', () => {
    expect(read(TS_PAGE)).toMatch(/npm install @driftstack\/sdk/);
    expect(read(TS_PAGE)).toMatch(/pnpm add @driftstack\/sdk/);
    expect(read(TS_PAGE)).toMatch(/yarn add @driftstack\/sdk/);

    expect(read(PY_PAGE)).toMatch(/pip install driftstack-sdk/);
    expect(read(PY_PAGE)).toMatch(/uv add driftstack-sdk/);
    expect(read(PY_PAGE)).toMatch(/poetry add driftstack-sdk/);

    expect(read(GO_PAGE)).toMatch(
      /go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/,
    );
  });

  it("CRITICAL TS dual-publish framing pinned (2026-06-24). The previous pin asserted 'The package is ESM-only ... CommonJS consumers ... dynamic import()' but @driftstack/sdk is dual-published — packages/sdk-typescript/package.json has main './dist/index.cjs' + exports['.'].require './dist/index.cjs', so both import and require work. The doc now states the package is dual-published (ESM + CommonJS via conditional exports).", () => {
    const p = read(TS_PAGE);

    expect(p).toMatch(
      /The package is dual-published \(ESM \+ CommonJS via conditional\s*\n?`exports`\) and ships full TypeScript types\. Both `import` and\s*\n?`require\('@driftstack\/sdk'\)` work out of the box\./,
    );
    // The stale ESM-only / dynamic-import-required framing must NOT return.
    expect(p).not.toMatch(/The package is ESM-only/);
    expect(p).not.toMatch(/need to use dynamic `import\(\)`/);
  });

  it('CRITICAL Python sync+async dual-client framing pinned. Driftstack (sync) + AsyncDriftstack (async) on the same wire shape.', () => {
    const p = read(PY_PAGE);

    expect(p).toMatch(/The package ships both sync \(`Driftstack`\) and async/);
    expect(p).toMatch(
      /\(`AsyncDriftstack`\) clients off the same wire shape\. Pick whichever\s*\n?matches your runtime\./,
    );
  });

  it("CRITICAL Python httpx-backed framing pinned. The 'The async client is httpx.AsyncClient-backed and only opens the connection pool inside async with. The sync client uses a synchronous httpx.Client' wording explains the underlying transport.", () => {
    const p = read(PY_PAGE);

    expect(p).toMatch(
      /The async client is `httpx\.AsyncClient`-backed and only opens the\s*\n?connection pool inside `async with`\. The sync client uses a\s*\n?synchronous `httpx\.Client`/,
    );
  });

  it('CRITICAL Go WithBaseURL + WithHTTPClient option-pattern framing pinned. Drift to a different option name would break Go-SDK consumer customization.', () => {
    const p = read(GO_PAGE);

    expect(p).toMatch(/driftstack\.WithBaseURL\("https:\/\/staging\.driftstack\.dev"\)/);
    expect(p).toMatch(/driftstack\.WithHTTPClient\(myInstrumentedHTTPClient\)/);
  });

  it("CRITICAL Go `defer client.Close()` resource-cleanup framing pinned. The 'Close() releases the underlying http.Transport connection pool. Call once at process shutdown; idiomatic Go is defer client.Close() in main' wording is the canonical Go idiom.", () => {
    const p = read(GO_PAGE);

    expect(p).toMatch(
      /`Close\(\)` releases the underlying `http\.Transport` connection pool\.\s*\n?Call once at process shutdown; idiomatic Go is `defer client\.Close\(\)`\s*\n?in `main`\./,
    );
  });

  it("CRITICAL TS session create + try/finally + destroy + console-out idiomatic shape pinned. S36 2026-07-07 (fable-truth-audit): the old 'per-tier idle timeout fires' comment was FICTIONAL — no idle timeout exists on any tier (MAX_SESSION_MINUTES_PER_TIER: 20 for free, null elsewhere; api-types common.ts); the comment now states the no-idle-timeout + free-tier-20-min-cap truth, matching S31's session-lifecycle wording.", () => {
    const p = read(TS_PAGE);

    expect(p).toMatch(/const session = await client\.sessions\.create\(\{ label: 'demo' \}\);/);
    expect(p).toMatch(
      /Always destroy — the concurrent slot stays held until you do\.\s*\/\/ There is no idle timeout on any tier; the only auto-destroy is\s*\/\/ the free tier's 20-minute duration cap\./,
    );
    // Negative pin — the fictional idle timeout must not come back.
    expect(p).not.toMatch(/per-tier idle timeout/);
  });

  it('CRITICAL Python session create + try/finally + str-cast on .id framing pinned. The sid = str(session.id) pattern handles UUID-or-str ambiguity.', () => {
    const p = read(PY_PAGE);

    expect(p).toMatch(/session = client\.sessions\.create\(\{"label": "demo"\}\)/);
    expect(p).toMatch(/sid = str\(session\.id\)/);
    expect(p).toMatch(/client\.sessions\.navigate\(sid, \{"url": "https:\/\/example\.com"\}\)/);
  });

  it('CRITICAL Go *driftstack.CreateSessionRequest + defer-destroy pattern pinned. The 2-defer (Close + Destroy) idiom is the canonical Go-SDK session-shape.', () => {
    const p = read(GO_PAGE);

    expect(p).toMatch(
      /session, err := client\.Sessions\.Create\(ctx, &driftstack\.CreateSessionRequest\{/,
    );
    expect(p).toMatch(
      /defer func\(\) \{\s*\n?\s+if err := client\.Sessions\.Destroy\(ctx, session\.ID\); err != nil \{/,
    );
  });

  it('CRITICAL Error-handling RFC 9457 problem-type-URL framing pinned in TS + Python. Go quickstart relies on errors.As-into-typed-class shape instead of explicit RFC 9457 string. Matches W776 /sdk/error-handling RFC 7807 (RFC 9457 is the successor).', () => {
    expect(read(TS_PAGE)).toMatch(/RFC 9457/);
    expect(read(PY_PAGE)).toMatch(/RFC 9457/);
  });

  it("CRITICAL 429-tier-limit error-branch pinned in all 3. The cap-exceeded handler 'Wait + retry, or upgrade tier' is the cross-SDK customer-action framing.", () => {
    expect(read(TS_PAGE)).toMatch(/err\.status === 429 && err\.type\.endsWith\('\/tier-limit'\)/);
    expect(read(PY_PAGE)).toMatch(
      /err\.status == 429 and \(err\.problem_type or ""\)\.endswith\("\/tier-limit"\)/,
    );
    // Go uses typed errors.As instead of status comparison.
    expect(read(GO_PAGE)).toMatch(/var rl \*driftstack\.RateLimitError/);
    expect(read(GO_PAGE)).toMatch(/var cl \*driftstack\.ConcurrencyLimitError/);
    expect(read(GO_PAGE)).toMatch(/var qe \*driftstack\.QuotaExceededError/);
  });

  it("CRITICAL 401-bad-API-key error-branch pinned in TS + Python. The 'bad API key' string is the cross-SDK customer-comms.", () => {
    expect(read(TS_PAGE)).toMatch(/console\.error\('bad API key'\)/);
    expect(read(PY_PAGE)).toMatch(/print\("bad API key"\)/);
  });

  it("CRITICAL Go errors.Is(err, driftstack.ErrAuth) sentinel-style match pinned. The 'bad API key' branch matches W776 /sdk/error-handling Go ErrAuth pattern.", () => {
    const p = read(GO_PAGE);

    expect(p).toMatch(/errors\.Is\(err, driftstack\.ErrAuth\):/);
    expect(p).toMatch(/log\.Print\("bad API key"\)/);
  });

  it('CRITICAL verifyWebhookSignature helper triplet pinned. The 3 names match W777 sdk/versioning cross-SDK-lockstep contract — verifyWebhookSignature (TS) + verify_webhook_signature (Python) + VerifyWebhookSignature (Go).', () => {
    expect(read(TS_PAGE)).toMatch(/import \{ verifyWebhookSignature \} from '@driftstack\/sdk'/);
    expect(read(PY_PAGE)).toMatch(/from driftstack import verify_webhook_signature/);
    expect(read(GO_PAGE)).toMatch(/driftstack\.VerifyWebhookSignature\(/);
  });

  it('CRITICAL 24h-rotation-grace prose pinned in all 3 + NO never-sent prev header read. The server folds both HMACs into the single x-driftstack-signature header as two v1= entries; the examples call the verifier with that one header only, and the grace prose describes the compound dual-v1= form (no separate prev header to read).', () => {
    // The examples must NOT instruct customers to read the never-sent
    // separate prev header from the request.
    expect(read(TS_PAGE)).not.toMatch(/x-driftstack-signature-prev/);
    expect(read(PY_PAGE)).not.toMatch(/x-driftstack-signature-prev/);
    expect(read(GO_PAGE)).not.toMatch(/X-Driftstack-Signature-Prev/);

    for (const PAGE of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      const p = read(PAGE);
      expect(p).toMatch(/24h signing-secret/);
      // The compound dual-v1= single-header form is the accurate contract.
      expect(p).toMatch(/v1=<new>,v1=<old>/);
    }
  });

  it("CRITICAL all 3 share 'Stuck? Email support@driftstack.dev with your account id (acc_…) and the failing x-request-id.' contact footer.", () => {
    for (const PAGE of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      const p = read(PAGE);
      expect(p).toMatch(/Stuck\? Email/);
      expect(p).toMatch(/\[support@driftstack\.dev\]\(mailto:support@driftstack\.dev\)/);
      expect(p).toMatch(/account id \(`acc_…`\) and the failing `x-request-id`\./);
    }
  });

  it('CRITICAL Next-steps 4-link set pinned in all 3 — /guides/session-lifecycle/ + /guides/profile-management/ + /webhooks/events/ + /sdk/error-handling/.', () => {
    for (const PAGE of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      const p = read(PAGE);
      expect(p).toMatch(/\[Session lifecycle reference\]\(\/guides\/session-lifecycle\/\)/);
      expect(p).toMatch(/\[Profile management\]\(\/guides\/profile-management\/\)/);
      expect(p).toMatch(/\[Webhook event catalog\]\(\/webhooks\/events\/\)/);
      expect(p).toMatch(/\[Error catalogue\]\(\/sdk\/error-handling\/\)/);
    }
  });

  it('CRITICAL TS + Go include /api/versioning link but Python skips. The cross-language asymmetry is intentional (acceptable; pin only that TS+Go have it).', () => {
    expect(read(TS_PAGE)).toMatch(/\[API versioning\]\(\/api\/versioning\/\)/);
    expect(read(GO_PAGE)).toMatch(/\[API versioning\]\(\/api\/versioning\/\)/);
  });

  it('CRITICAL every SDK quickstart requires a paid tier and distinguishes the restricted Free desktop credential', () => {
    for (const page of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      const p = read(page);
      expect(p).toMatch(/Any paid Driftstack tier, including Manual/);
      expect(p).toMatch(/A `ds_live_…` customer API key/);
      expect(p).toMatch(/restricted\s*`ds_test_…` device credential/);
      expect(p).toMatch(/not a general SDK or\s*sandbox key/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-sdk-quickstart-triplet-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
