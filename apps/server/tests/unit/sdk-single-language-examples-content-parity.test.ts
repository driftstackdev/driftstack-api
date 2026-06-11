// W802 — single-language SDK-example surface parity. One-hundred-
// twenty-eighth in the drift-guard series. Closes the remaining gap
// in packages/*/examples/ — these 5 files demo language-idiomatic
// patterns that have no cross-SDK twin (TS-only retry-policy-opt-
// out; Python-only LangChain wrapper + pytest fixture; Go-only
// goroutine-pool + scraping pipeline). Each is load-bearing for its
// SDK's docs page; drift would orphan documentation cross-links.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const RL = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/rate-limit-handling.ts');
const LC = resolve(REPO_ROOT, 'packages/sdk-python/examples/langchain_tool.py');
const PF = resolve(REPO_ROOT, 'packages/sdk-python/examples/pytest_fixture.py');
const GP = resolve(REPO_ROOT, 'packages/sdk-go/examples/goroutine_pool/main.go');
const SP = resolve(REPO_ROOT, 'packages/sdk-go/examples/scraping_pipeline/main.go');

describe('W802 single-language SDK example parity', () => {
  it('all 5 single-language example files exist at canonical paths', () => {
    expect(existsSync(RL)).toBe(true);
    expect(existsSync(LC)).toBe(true);
    expect(existsSync(PF)).toBe(true);
    expect(existsSync(GP)).toBe(true);
    expect(existsSync(SP)).toBe(true);
  });

  // ─── TS rate-limit-handling.ts ────────────────────────────────

  it("CRITICAL TS rate-limit-handling header framing pinned. The 'SDK's default retry policy already honours 429 + Retry-After. This example shows how to opt OUT of automatic retries and handle 429 yourself' wording is the load-bearing 'why this example exists vs error-handling.ts' contrast.", () => {
    const p = read(RL);
    expect(p).toMatch(
      /\/\/ The SDK's default retry policy already honours 429 \+ Retry-After\. This\s*\n\/\/ example shows how to opt OUT of automatic retries and handle 429 yourself/,
    );
    expect(p).toMatch(
      /\(useful when you want jitter aligned with your own job scheduler, or when\s*\n\/\/ you want to surface RateLimitError to a queue\)\./,
    );
  });

  it('CRITICAL TS retry-opt-out shape pinned — `retry: { maxAttempts: 0 }` with `// disable built-in retries` comment. Drift to a different config key (retries, retryConfig, retryPolicy) would break the only quickstart-level demonstration of retry-disable.', () => {
    const p = read(RL);
    expect(p).toMatch(/retry: \{ maxAttempts: 0 \}, \/\/ disable built-in retries/);
  });

  it('CRITICAL TS RateLimitError import + instanceof catch + retryAfterSeconds*1000 sleep + 5-attempt cap pinned. The `for (let attempt = 0; attempt < 5; attempt++)` loop + `RateLimitError.retryAfterSeconds * 1000` (ms conversion) is the canonical TS manual-retry recipe.', () => {
    const p = read(RL);
    expect(p).toMatch(/import \{ Driftstack, RateLimitError \} from '@driftstack\/sdk';/);
    expect(p).toMatch(/for \(let attempt = 0; attempt < 5; attempt\+\+\) \{/);
    expect(p).toMatch(/if \(err instanceof RateLimitError\) \{/);
    expect(p).toMatch(/const wait = err\.retryAfterSeconds \* 1000;/);
    expect(p).toMatch(/await new Promise\(\(resolve\) => setTimeout\(resolve, wait\)\);/);
    expect(p).toMatch(/console\.error\('gave up after 5 attempts'\);/);
  });

  it("CRITICAL TS 'manual-retry' label + create-then-destroy cleanup pinned. The label distinguishes this example's sessions in the dashboard from quickstart/profile-management. Drift would lose that signal.", () => {
    const p = read(RL);
    expect(p).toMatch(/label: 'manual-retry'/);
    expect(p).toMatch(/await client\.sessions\.destroy\(session\.id\);/);
  });

  // ─── Python langchain_tool.py ─────────────────────────────────

  it("CRITICAL Python LangChain-tool header framing pinned. The 'LangChain API churns; refer to your installed LangChain version's docs' + 'one tool per session-creation, one per navigation pattern we've seen work for AI-agent QA pipelines' is the load-bearing 'this is a sketch not a contract' framing.", () => {
    const p = read(LC);
    expect(p).toMatch(/LangChain tool wrapper: expose Driftstack as a tool an agent can call\./);
    expect(p).toMatch(
      /This is a sketch — the LangChain API churns; refer to your installed\s*\nLangChain version's docs for the canonical Tool shape\./,
    );
    expect(p).toMatch(/one tool per session-creation, one per navigation/);
  });

  it("CRITICAL Python pip-install + import pattern pinned. The 'pip install langchain-core' install hint + lazy `from langchain_core.tools import Tool` import inside the function (so this file imports without LangChain installed in the SDK's own env) is the canonical optional-dependency convention.", () => {
    const p = read(LC);
    expect(p).toMatch(/pip install langchain-core/);
    expect(p).toMatch(
      /try:\s*\n\s+from langchain_core\.tools import Tool\s*\n\s+except ImportError as err:/,
    );
    expect(p).toMatch(/Install langchain-core to use this helper: pip install langchain-core/);
  });

  it("CRITICAL Python build_driftstack_tools 3-tool set pinned — driftstack_create_session + driftstack_navigate + driftstack_destroy_session. The 3-tool minimum is the canonical 'agent can run a session end-to-end' surface; drift would orphan agent-framework docs.", () => {
    const p = read(LC);
    expect(p).toMatch(/def build_driftstack_tools\(client: Driftstack\) -> list\[Any\]:/);
    expect(p).toMatch(/name="driftstack_create_session"/);
    expect(p).toMatch(/name="driftstack_navigate"/);
    expect(p).toMatch(/name="driftstack_destroy_session"/);
  });

  it("CRITICAL Python navigate-tool JSON-shaped-string framing pinned. The 'LangChain tools are typically str-in str-out; agents pass JSON-shaped strings. Customers can swap to StructuredTool for schema-typed inputs' wording explains the JSON-payload pattern + the StructuredTool upgrade path.", () => {
    const p = read(LC);
    expect(p).toMatch(
      /LangChain tools are typically str-in str-out; agents pass\s*\n\s+# JSON-shaped strings\. Customers can swap to ``StructuredTool``\s*\n\s+# for schema-typed inputs\./,
    );
    expect(p).toMatch(/args = _json\.loads\(payload\)/);
    expect(p).toMatch(
      /result = client\.sessions\.navigate\(args\["session_id"\], \{"url": args\["url"\]\}\)/,
    );
  });

  // ─── Python pytest_fixture.py ─────────────────────────────────

  it("CRITICAL Python pytest-fixture header framing pinned. The 'Drop the contents of mock_driftstack into your project\\'s conftest.py' + 'Tests can then depend on the fixture and get a Driftstack client whose responses are controlled by respx' is the load-bearing 'where to put this and what it does' contract.", () => {
    const p = read(PF);
    expect(p).toMatch(/pytest fixture pattern — mock the Driftstack SDK in customer tests\./);
    expect(p).toMatch(
      /Drop the contents of ``mock_driftstack`` into your project's\s*\n``conftest\.py``/,
    );
    expect(p).toMatch(/pip install pytest respx/);
  });

  it('CRITICAL Python fixture shape pinned — @pytest.fixture + mock_driftstack yields (client, mock) tuple via Generator[tuple[Driftstack, respx.MockRouter], None, None]. Drift to a different fixture name or return shape would break every example assertion in the docstring.', () => {
    const p = read(PF);
    expect(p).toMatch(/@pytest\.fixture\s*\n?def mock_driftstack\(\)/);
    expect(p).toMatch(/-> Generator\[tuple\[Driftstack, respx\.MockRouter\], None, None\]:/);
    expect(p).toMatch(/yield client, mock/);
  });

  it("CRITICAL Python fixture _BASE = 'https://api.driftstack.test' pinned. The .test TLD (RFC 2606) is the canonical mock-base-URL convention; drift to a real host would let escaped requests hit production.", () => {
    const p = read(PF);
    expect(p).toMatch(/_BASE = "https:\/\/api\.driftstack\.test"/);
  });

  it("CRITICAL Python SESSION_FIXTURE archetype pinned to 'iphone17_ios18_7_safari26_4' + status 'ready'. Matches V-136 LOCKED_ARCHETYPE_ID + the canonical default session-state shape. Drift would let customer test fixtures diverge from production session shape.", () => {
    const p = read(PF);
    expect(p).toMatch(/"status": "ready"/);
    expect(p).toMatch(/"archetype": "iphone17_ios18_7_safari26_4"/);
    expect(p).toMatch(/SESSION_FIXTURE = \{/);
    expect(p).toMatch(/"id": "ses_00000000-0000-4000-8000-000000000001"/);
  });

  it("CRITICAL Python ds_test_fakefakefakefake API-key convention pinned. The 'ds_test_' prefix matches the test-key namespace convention (vs ds_live_ for production); drift would let test fixtures look like live keys.", () => {
    const p = read(PF);
    expect(p).toMatch(/api_key="ds_test_fakefakefakefakefakefakefakefake"/);
  });

  // ─── Go goroutine_pool ────────────────────────────────────────

  it("CRITICAL Go goroutine-pool header framing pinned. The 'worker-pool pattern: fan out N concurrent session ops, collect results' + 'Honours the SDK's tier rate limit because each worker uses the same client (which retries + bounded retries; rate-limit excursions automatically back off)' is the load-bearing 'why one client across workers is safe' anchor.", () => {
    const p = read(GP);
    expect(p).toMatch(
      /\/\/ Package main shows a worker-pool pattern: fan out N concurrent\s*\n\/\/ session ops, collect results\. Honours the SDK's tier rate limit/,
    );
    expect(p).toMatch(
      /\/\/ because each worker uses the same client \(which retries \+ bounded\s*\n\/\/ retries; rate-limit excursions automatically back off\)\./,
    );
  });

  it('CRITICAL Go numWorkers=4 const + 5-url test set pinned. The 4 workers + 5 urls demonstrates the queue-drain pattern (one worker re-pickups after first 4 are done). Drift would lose the canonical worker-count vs queue-depth pedagogy.', () => {
    const p = read(GP);
    expect(p).toMatch(/const numWorkers = 4/);
    expect(p).toMatch(/"https:\/\/example\.com\/",/);
    expect(p).toMatch(/"https:\/\/example\.org\/",/);
    expect(p).toMatch(/"https:\/\/example\.net\/",/);
    expect(p).toMatch(/"https:\/\/golang\.org\/",/);
    expect(p).toMatch(/"https:\/\/httpbin\.org\/get",/);
  });

  it('CRITICAL Go worker shape pinned — chan-based fan-out + sync.WaitGroup + close(jobs)→worker exits + close(results) in goroutine. Drift would break the canonical Go worker-pool idiom.', () => {
    const p = read(GP);
    expect(p).toMatch(/jobs := make\(chan string, len\(urls\)\)/);
    expect(p).toMatch(/results := make\(chan string, len\(urls\)\)/);
    expect(p).toMatch(/var wg sync\.WaitGroup/);
    expect(p).toMatch(
      /for i := 0; i < numWorkers; i\+\+ \{\s*\n\s+wg\.Add\(1\)\s*\n\s+go worker\(i\)\s*\n\s+\}/,
    );
    expect(p).toMatch(/close\(jobs\)/);
    expect(p).toMatch(/go func\(\) \{\s*\n\s+wg\.Wait\(\)\s*\n\s+close\(results\)\s*\n\s+\}\(\)/);
  });

  it('CRITICAL Go worker 3-step flow inside the for-range: Create → Navigate → GetState → Destroy (deferred even on err). The ERR path Destroys the session before continue — drift would leak sessions on navigate errors.', () => {
    const p = read(GP);
    expect(p).toMatch(/session, err := client\.Sessions\.Create\(ctx, nil\)/);
    expect(p).toMatch(
      /client\.Sessions\.Navigate\(ctx, session\.ID, &driftstack\.NavigateRequest\{/,
    );
    expect(p).toMatch(/state, err := client\.Sessions\.GetState\(ctx, session\.ID\)/);
    // Destroy must happen on both success + navigate-error paths.
    const destroyCount = (p.match(/_ = client\.Sessions\.Destroy\(ctx, session\.ID\)/g) ?? [])
      .length;
    expect(destroyCount).toBeGreaterThanOrEqual(2);
  });

  // ─── Go scraping_pipeline ─────────────────────────────────────

  it("CRITICAL Go scraping-pipeline header framing pinned. The 'target list → session per-target → navigate + capture → collect outputs' + 'one session per workflow unit. Pairs well with goroutine_pool when scaling' is the load-bearing 'resource composition pattern customers use most often' anchor.", () => {
    const p = read(SP);
    expect(p).toMatch(
      /\/\/ Package main is a small scraping pipeline: target list → session\s*\n\/\/ per-target → navigate \+ capture → collect outputs\./,
    );
    expect(p).toMatch(
      /\/\/ Demonstrates the resource composition pattern customers use most\s*\n\/\/ often \(one session per workflow unit\)\. Pairs well with goroutine_pool\s*\n\/\/ when scaling\./,
    );
  });

  it('CRITICAL Go scrape() helper shape pinned — 60s ctx.WithTimeout + defer-Destroy-with-Background-context + NotFoundError errors.As path + base64.StdEncoding decode + os.WriteFile to OUT_DIR. Drift to a different timeout would either hang or pre-empt; drift to no-Destroy-defer would leak sessions on early-return.', () => {
    const p = read(SP);
    expect(p).toMatch(
      /ctx, cancel := context\.WithTimeout\(context\.Background\(\), 60\*time\.Second\)/,
    );
    expect(p).toMatch(/defer cancel\(\)/);
    expect(p).toMatch(
      /defer func\(\) \{\s*\n\s+_ = client\.Sessions\.Destroy\(context\.Background\(\), session\.ID\)\s*\n\s+\}\(\)/,
    );
    expect(p).toMatch(/var ne \*driftstack\.NotFoundError\s*\n\s+if errors\.As\(err, &ne\) \{/);
    expect(p).toMatch(/return fmt\.Errorf\("upstream 404 for %s", url\)/);
    expect(p).toMatch(/base64\.StdEncoding\.DecodeString\(cap\.Data\)/);
    expect(p).toMatch(/os\.WriteFile\(path, bytes, 0o644\)/);
  });

  it('CRITICAL Go OUT_DIR env-var (default "./scrape-output") + os.MkdirAll(0o755) pinned. The env-var-with-default lets the example work both interactively and in CI without configuration.', () => {
    const p = read(SP);
    expect(p).toMatch(/outDir := os\.Getenv\("OUT_DIR"\)/);
    expect(p).toMatch(/if outDir == "" \{\s*\n\s+outDir = "\.\/scrape-output"\s*\n\s+\}/);
    expect(p).toMatch(/os\.MkdirAll\(outDir, 0o755\)/);
  });

  it("CRITICAL Go scraping 2-target set pinned — example.com + go.dev. The 2-target minimum demonstrates the per-target-isolation property (one target's failure doesn't cancel the other). Drift to a single target would lose this pedagogy.", () => {
    const p = read(SP);
    expect(p).toMatch(/\{"example", "https:\/\/example\.com\/"\}/);
    expect(p).toMatch(/\{"go", "https:\/\/go\.dev\/"\}/);
  });

  it("CRITICAL Go log.Printf per-target ok/failed status pinned. The '[%s] ok' / '[%s] failed: %v' framing is the canonical per-target progress signal — drift would either silence the demo or print confusingly.", () => {
    const p = read(SP);
    expect(p).toMatch(/log\.Printf\("\[%s\] failed: %v", target\.name, err\)/);
    expect(p).toMatch(/log\.Printf\("\[%s\] ok", target\.name\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-single-language-examples-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
