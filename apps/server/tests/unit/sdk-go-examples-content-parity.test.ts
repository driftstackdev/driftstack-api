// W621 — drift guard for packages/sdk-go/examples/*/main.go (9 files).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const E = (rel: string) => resolve(REPO_ROOT, `packages/sdk-go/examples/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W621 sdk-go/examples content parity', () => {
  it('quickstart/main.go: go run ./examples/quickstart + DRIFTSTACK_API_KEY env-gate + DRIFTSTACK_BASE_URL WithBaseURL Option + driftstack.New + defer Close + ctx.Background + 4-step (Create label=quickstart → Navigate example.com → Capture CaptureScreenshot → idempotent Destroy) pinned', () => {
    const body = read(E('quickstart/main.go'));
    expect(body).toMatch(
      /^\/\/ Package main is the quickstart example for the Driftstack Go SDK\.$/m,
    );
    expect(body).toMatch(/DRIFTSTACK_API_KEY=ds_live_… go run \.\/examples\/quickstart/);
    expect(body).toMatch(/^package main$/m);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
    expect(body).toMatch(/apiKey := os\.Getenv\("DRIFTSTACK_API_KEY"\)/);
    expect(body).toMatch(/opts := \[\]driftstack\.Option\{\}/);
    expect(body).toMatch(/if base := os\.Getenv\("DRIFTSTACK_BASE_URL"\); base != "" \{/);
    expect(body).toMatch(/opts = append\(opts, driftstack\.WithBaseURL\(base\)\)/);
    expect(body).toMatch(/client := driftstack\.New\(apiKey, opts\.\.\.\)/);
    expect(body).toMatch(/defer client\.Close\(\)/);
    expect(body).toMatch(/ctx := context\.Background\(\)/);
    expect(body).toMatch(
      /session, err := client\.Sessions\.Create\(ctx, &driftstack\.CreateSessionRequest\{Label: label\}\)/,
    );
    expect(body).toMatch(/URL: "https:\/\/example\.com\/",/);
    expect(body).toMatch(
      /cap, err := client\.Sessions\.Capture\(ctx, session\.ID, &driftstack\.CaptureRequest\{/,
    );
    expect(body).toMatch(/Kind: driftstack\.CaptureScreenshot,/);
    expect(body).toMatch(/\/\/ Destroy\. Idempotent — safe to call twice\./);
    expect(body).toMatch(/if err := client\.Sessions\.Destroy\(ctx, session\.ID\); err != nil \{/);
    expect(existsSync(E('quickstart/main.go'))).toBe(true);
  });

  it('billing_flow/main.go: /billing-page mirror + account_owner scope + Billing.GetState branching (no-sub → CreateCheckoutSession TierAPIBuilder + success/cancel urls / has-sub → CreatePortalSession) pinned (trial-pack block removed 2026-05-27)', () => {
    const body = read(E('billing_flow/main.go'));
    expect(body).toMatch(/^\/\/ Example: customer billing self-serve flow\.$/m);
    expect(body).toMatch(/customer-dashboard \/billing page in code form/);
    expect(body).toMatch(/`account_owner` scope \(or the legacy `admin` compat alias\)/);
    expect(body).toMatch(/state, err := client\.Billing\.GetState\(ctx\)/);
    expect(body).toMatch(/if state\.Subscription == nil \{/);
    expect(body).toMatch(
      /resp, err := client\.Billing\.CreateCheckoutSession\(ctx, &driftstack\.CreateCheckoutSessionRequest\{/,
    );
    expect(body).toMatch(/Tier:\s+driftstack\.TierAPIBuilder,/);
    expect(body).toMatch(/SuccessURL: "https:\/\/app\.driftstack\.io\/billing\?ok=1",/);
    expect(body).toMatch(/CancelURL:\s+"https:\/\/app\.driftstack\.io\/billing\?cancelled=1",/);
    expect(body).toMatch(/portal, err := client\.Billing\.CreatePortalSession\(ctx\)/);
    expect(existsSync(E('billing_flow/main.go'))).toBe(true);
  });

  it('error_handling/main.go: typed-error catch (errors.As for payload + errors.Is for category) + 5-attempt manual retry with RateLimitError.RetryAfterSeconds fallback to 1<<attempt + ConcurrencyLimitError CurrentSessions/Limit + QuotaExceededError RecordType/Current/Limit + ErrAuth sentinel pinned', () => {
    const body = read(E('error_handling/main.go'));
    expect(body).toMatch(
      /^\/\/ Package main shows the typed-error catch patterns: errors\.As for$/m,
    );
    expect(body).toMatch(/^\/\/ payload, errors\.Is for category\.$/m);
    expect(body).toMatch(/for attempt := 0; attempt < 5; attempt\+\+ \{/);
    expect(body).toMatch(/s, err := client\.Sessions\.Create\(ctx, nil\)/);
    expect(body).toMatch(/var rl \*driftstack\.RateLimitError/);
    expect(body).toMatch(/if errors\.As\(err, &rl\) \{/);
    expect(body).toMatch(/wait := time\.Duration\(rl\.RetryAfterSeconds\) \* time\.Second/);
    expect(body).toMatch(/wait = time\.Duration\(1<<attempt\) \* time\.Second/);
    expect(body).toMatch(/var cle \*driftstack\.ConcurrencyLimitError/);
    expect(body).toMatch(
      /log\.Fatalf\("concurrent-session ceiling: %d\/%d", cle\.CurrentSessions, cle\.Limit\)/,
    );
    expect(body).toMatch(/var qe \*driftstack\.QuotaExceededError/);
    expect(body).toMatch(
      /log\.Fatalf\("quota exhausted for %s: %d\/%d", qe\.RecordType, qe\.Current, qe\.Limit\)/,
    );
    expect(body).toMatch(/\/\/ Sentinel-based catch-all for category\./);
    expect(body).toMatch(/if errors\.Is\(err, driftstack\.ErrAuth\) \{/);
    expect(existsSync(E('error_handling/main.go'))).toBe(true);
  });

  it('pagination/main.go: pre-Go-1.23 no-generators raw-List page-loop pattern + V-119 webhook-deliveries 1:1 + Pattern 1 walk-every-session newest-first + Pattern 2 early-exit on FIND_SESSION_LABEL match + cursor NextCursor + limit 50/100 pinned', () => {
    const body = read(E('pagination/main.go'));
    expect(body).toMatch(
      /^\/\/ Package main shows the cursor-pagination loop pattern\. Go pre-1\.23 has$/m,
    );
    expect(body).toMatch(
      /^\/\/ no generators \/ range-over-func, so the SDK exposes raw List\(\.\.\.\)$/m,
    );
    expect(body).toMatch(/translates 1:1 to webhook deliveries \(client\.Webhooks\./);
    expect(body).toMatch(/ListDeliveries\) — same shape: Data \+ NextCursor \+ has_more\./);
    expect(body).toMatch(/\/\/ Pattern 1 — walk every session, newest first\./);
    expect(body).toMatch(
      /page, err := client\.Sessions\.List\(ctx, &driftstack\.ListSessionsQuery\{/,
    );
    expect(body).toMatch(/Limit:\s+50,/);
    expect(body).toMatch(/Cursor: cursor,/);
    expect(body).toMatch(/if page\.NextCursor == nil \{/);
    expect(body).toMatch(/cursor = \*page\.NextCursor/);
    expect(body).toMatch(/\/\/ Pattern 2 — early-exit on the first match\./);
    expect(body).toMatch(/target := os\.Getenv\("FIND_SESSION_LABEL"\)/);
    expect(body).toMatch(/Limit:\s+100,/);
    expect(body).toMatch(/if s\.Label != nil && \*s\.Label == target \{/);
    expect(existsSync(E('pagination/main.go'))).toBe(true);
  });

  it('profile_management/main.go: 8-step flow (Create demo-Unix → Iterate Limit=50 visit-callback returning (bool, error) → Get → Update newName → V-313 Clone(ctx,id,nil) → V-312 Capture label=baseline → Restore Name+suffix-restored → cleanup loop) pinned', () => {
    const body = read(E('profile_management/main.go'));
    expect(body).toMatch(
      /^\/\/ Package main is the profile-management example for the Driftstack$/m,
    );
    expect(body).toMatch(/end-to-end: create →$/m);
    expect(body).toMatch(
      /\/\/ list → get → update → clone \(V-313\) → snapshot capture \(V-312\) →/,
    );
    expect(body).toMatch(
      /created, err := client\.Profiles\.Create\(ctx, &driftstack\.CreateProfileRequest\{/,
    );
    expect(body).toMatch(/Name: fmt\.Sprintf\("demo-%d", time\.Now\(\)\.Unix\(\)\),/);
    expect(body).toMatch(
      /if err := client\.Profiles\.Iterate\(ctx, &driftstack\.ListProfilesQuery\{Limit: 50\},/,
    );
    expect(body).toMatch(/func\(p \*driftstack\.Profile\) \(bool, error\) \{/);
    expect(body).toMatch(/fetched, err := client\.Profiles\.Get\(ctx, created\.ID\)/);
    expect(body).toMatch(
      /updated, err := client\.Profiles\.Update\(ctx, created\.ID, &driftstack\.UpdateProfileRequest\{/,
    );
    expect(body).toMatch(/\/\/ 5\. V-313 clone — server auto-derives "\(copy\)" naming\./);
    expect(body).toMatch(/cloned, err := client\.Profiles\.Clone\(ctx, updated\.ID, nil\)/);
    expect(body).toMatch(/\/\/ 6\. V-312 snapshot capture — frozen point-in-time copy\./);
    expect(body).toMatch(/snap, err := client\.ProfileSnapshots\.Capture\(ctx, updated\.ID,/);
    expect(body).toMatch(/Label:\s+"baseline",/);
    expect(body).toMatch(/restored, err := client\.ProfileSnapshots\.Restore\(ctx, snap\.ID,/);
    expect(body).toMatch(
      /&driftstack\.RestoreSnapshotRequest\{Name: updated\.Name \+ "-restored"\}/,
    );
    expect(body).toMatch(
      /for _, id := range \[\]string\{restored\.ID, cloned\.ID, updated\.ID\} \{/,
    );
    expect(existsSync(E('profile_management/main.go'))).toBe(true);
  });

  it('webhook_receiver/main.go: stdlib-only net/http + VerifyWebhookSignature + X-Driftstack-Signature header + Event JSON unmarshal + 2-case switch (EventSessionCompleted SessionCompletedData + EventAPIKeyRevoked APIKeyRevokedData) + 204 NoContent within 30s + listen :4242 pinned', () => {
    const body = read(E('webhook_receiver/main.go'));
    expect(body).toMatch(/^\/\/ Package main is a stdlib-only webhook receiver: verify the$/m);
    expect(body).toMatch(/No third-party HTTP framework$/m);
    expect(body).toMatch(/var secret = os\.Getenv\("DRIFTSTACK_WEBHOOK_SECRET"\)/);
    expect(body).toMatch(/func handler\(w http\.ResponseWriter, r \*http\.Request\) \{/);
    expect(body).toMatch(/if r\.URL\.Path != "\/webhook" \{/);
    expect(body).toMatch(/body, err := io\.ReadAll\(r\.Body\)/);
    expect(body).toMatch(
      /if !driftstack\.VerifyWebhookSignature\(body, r\.Header\.Get\("X-Driftstack-Signature"\), secret\) \{/,
    );
    expect(body).toMatch(/http\.Error\(w, "bad signature", http\.StatusUnauthorized\)/);
    expect(body).toMatch(/var evt driftstack\.Event/);
    expect(body).toMatch(/switch evt\.Type \{/);
    expect(body).toMatch(/case driftstack\.EventSessionCompleted:/);
    expect(body).toMatch(/var data driftstack\.SessionCompletedData/);
    expect(body).toMatch(/case driftstack\.EventAPIKeyRevoked:/);
    expect(body).toMatch(/var data driftstack\.APIKeyRevokedData/);
    expect(body).toMatch(/\/\/ 2xx confirms receipt\. Driftstack expects this within 30s\./);
    expect(body).toMatch(/w\.WriteHeader\(http\.StatusNoContent\)/);
    expect(body).toMatch(/http\.ListenAndServe\(":4242", mux\)/);
    expect(existsSync(E('webhook_receiver/main.go'))).toBe(true);
  });

  it('goroutine_pool/main.go: worker-pool fan-out N=4 concurrent + 5-URL job list (example.com/.org/.net + golang.org + httpbin.org/get) + sync.WaitGroup + jobs/results channels + per-worker create-session → navigate → state-title → destroy pinned', () => {
    const body = read(E('goroutine_pool/main.go'));
    expect(body).toMatch(/^\/\/ Package main shows a worker-pool pattern: fan out N concurrent$/m);
    expect(body).toMatch(/^const numWorkers = 4$/m);
    expect(body).toMatch(/"https:\/\/example\.com\/",/);
    expect(body).toMatch(/"https:\/\/example\.org\/",/);
    expect(body).toMatch(/"https:\/\/example\.net\/",/);
    expect(body).toMatch(/"https:\/\/golang\.org\/",/);
    expect(body).toMatch(/"https:\/\/httpbin\.org\/get",/);
    expect(body).toMatch(/jobs := make\(chan string, len\(urls\)\)/);
    expect(body).toMatch(/results := make\(chan string, len\(urls\)\)/);
    expect(body).toMatch(/var wg sync\.WaitGroup/);
    expect(body).toMatch(/worker := func\(id int\) \{/);
    expect(body).toMatch(/for url := range jobs \{/);
    expect(body).toMatch(/session, err := client\.Sessions\.Create\(ctx, nil\)/);
    expect(body).toMatch(/state, err := client\.Sessions\.GetState\(ctx, session\.ID\)/);
    expect(body).toMatch(/_ = client\.Sessions\.Destroy\(ctx, session\.ID\)/);
    expect(body).toMatch(/for i := 0; i < numWorkers; i\+\+ \{/);
    expect(body).toMatch(/wg\.Add\(1\)/);
    expect(body).toMatch(/go worker\(i\)/);
    expect(existsSync(E('goroutine_pool/main.go'))).toBe(true);
  });

  it('scraping_pipeline/main.go: target list → session per-target → navigate + screenshot capture + base64.StdEncoding.DecodeString → os.WriteFile <name>.png + OUT_DIR default ./scrape-output + 60s context timeout + errors.As NotFoundError handling + per-target defer cleanup pinned', () => {
    const body = read(E('scraping_pipeline/main.go'));
    expect(body).toMatch(
      /^\/\/ Package main is a small scraping pipeline: target list → session$/m,
    );
    expect(body).toMatch(/outDir := os\.Getenv\("OUT_DIR"\)/);
    expect(body).toMatch(/outDir = "\.\/scrape-output"/);
    expect(body).toMatch(/if err := os\.MkdirAll\(outDir, 0o755\); err != nil \{/);
    expect(body).toMatch(/\{"example", "https:\/\/example\.com\/"\},/);
    expect(body).toMatch(/\{"go", "https:\/\/go\.dev\/"\},/);
    expect(body).toMatch(
      /^func scrape\(client \*driftstack\.Client, name, url, outDir string\) error \{$/m,
    );
    expect(body).toMatch(
      /ctx, cancel := context\.WithTimeout\(context\.Background\(\), 60\*time\.Second\)/,
    );
    expect(body).toMatch(/_ = client\.Sessions\.Destroy\(context\.Background\(\), session\.ID\)/);
    expect(body).toMatch(/var ne \*driftstack\.NotFoundError/);
    expect(body).toMatch(/if errors\.As\(err, &ne\) \{/);
    expect(body).toMatch(/return fmt\.Errorf\("upstream 404 for %s", url\)/);
    expect(body).toMatch(
      /cap, err := client\.Sessions\.Capture\(ctx, session\.ID, &driftstack\.CaptureRequest\{/,
    );
    expect(body).toMatch(/Kind: driftstack\.CaptureScreenshot,/);
    expect(body).toMatch(/bytes, err := base64\.StdEncoding\.DecodeString\(cap\.Data\)/);
    expect(body).toMatch(/path := filepath\.Join\(outDir, name\+"\.png"\)/);
    expect(body).toMatch(/if err := os\.WriteFile\(path, bytes, 0o644\); err != nil \{/);
    expect(existsSync(E('scraping_pipeline/main.go'))).toBe(true);
  });

  it('crypto_checkout/main.go: V-666 + crypto/rand + hex.EncodeToString 32-char idempotency key (no google/uuid dep) + ptr[T any] generic helper + 6-step flow (Quote → CreateCheckout with CreateCheckoutOptions IdempotencyKey V-666.AO → UpdateNote PO-0001 → Get → Receipt → Iterate paid 7d RFC3339 with visit-callback returning bool) + non-refundable pinned', () => {
    const body = read(E('crypto_checkout/main.go'));
    expect(body).toMatch(/^\/\/ Example: crypto-checkout self-serve flow \(V-666\)\.$/m);
    expect(body).toMatch(/\/\/ Crypto payments are non-refundable\./);
    expect(body).toMatch(/^\s+"crypto\/rand"$/m);
    expect(body).toMatch(/^\s+"encoding\/hex"$/m);
    expect(body).toMatch(/^func ptr\[T any\]\(v T\) \*T \{ return &v \}$/m);
    expect(body).toMatch(/\/\/ newIdempotencyKey returns a fresh random 32-hex-char key/);
    expect(body).toMatch(/Avoids a/);
    expect(body).toMatch(/google\/uuid dependency for the example/);
    expect(body).toMatch(/^func newIdempotencyKey\(\) string \{$/m);
    expect(body).toMatch(/var b \[16\]byte/);
    expect(body).toMatch(/return hex\.EncodeToString\(b\[:\]\)/);
    expect(body).toMatch(/quote, err := client\.CryptoOrders\.Quote\(ctx, map\[string\]any\{/);
    expect(body).toMatch(/"product": "solo_manual",/);
    expect(body).toMatch(/key := newIdempotencyKey\(\)/);
    expect(body).toMatch(/order, err := client\.CryptoOrders\.CreateCheckout\(/);
    expect(body).toMatch(/&driftstack\.CreateCheckoutOptions\{IdempotencyKey: &key\},/);
    expect(body).toMatch(/client\.CryptoOrders\.UpdateNote\(ctx, orderID, map\[string\]any\{/);
    expect(body).toMatch(/"customer_note": "demo PO-0001",/);
    expect(body).toMatch(/latest, err := client\.CryptoOrders\.Get\(ctx, orderID\)/);
    expect(body).toMatch(/receipt, err := client\.CryptoOrders\.Receipt\(ctx, orderID\)/);
    expect(body).toMatch(
      /since := time\.Now\(\)\.Add\(-7 \* 24 \* time\.Hour\)\.UTC\(\)\.Format\(time\.RFC3339\)/,
    );
    expect(body).toMatch(/err = client\.CryptoOrders\.Iterate\(/);
    expect(body).toMatch(/&driftstack\.ListCryptoOrdersOptions\{/);
    expect(body).toMatch(/Status:\s+ptr\("paid"\),/);
    expect(body).toMatch(/Limit:\s+ptr\(50\),/);
    expect(body).toMatch(/CreatedAfter: &since,/);
    expect(body).toMatch(/func\(o driftstack\.CryptoOrderEnvelope\) bool \{/);
    expect(existsSync(E('crypto_checkout/main.go'))).toBe(true);
  });

  it('agent_chat/main.go: AgentSessions.Create + Message multi-turn (plan-executed/clarify/refuse switch) + DRIFTSTACK_BYOK_ANTHROPIC_API_KEY env-gate building MessageOptions{ByokAPIKey: byokKey} only when non-empty + ErrFeatureUnavailable activation-gate exit code 2 + Get final state + Close idempotent — pinned so slice 138\'s BYOK demo survives + so a future refactor that drops the `if byokKey != ""` guard (which would send an empty x-byok-anthropic-api-key header) trips the test (cross-SDK parity contract from slices 126-128)', () => {
    const body = read(E('agent_chat/main.go'));
    expect(body).toMatch(/DRIFTSTACK_API_KEY=ds_live_\.\.\. go run \.\/examples\/agent_chat/);
    expect(body).toMatch(/DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-\.\.\./);
    expect(body).toMatch(/byokKey := os\.Getenv\("DRIFTSTACK_BYOK_ANTHROPIC_API_KEY"\)/);
    expect(body).toMatch(/var msgOpts \*driftstack\.MessageOptions/);
    expect(body).toMatch(/if byokKey != "" \{/);
    expect(body).toMatch(/msgOpts = &driftstack\.MessageOptions\{ByokAPIKey: byokKey\}/);
    expect(body).toMatch(
      /resp, err := client\.AgentSessions\.Message\(ctx, session\.ID, prompt, msgOpts\)/,
    );
    expect(body).toMatch(/case "plan-executed":/);
    expect(body).toMatch(/case "clarify":/);
    expect(body).toMatch(/case "refuse":/);
    expect(body).toMatch(/errors\.Is\(err, driftstack\.ErrFeatureUnavailable\)/);
    expect(body).toMatch(/os\.Exit\(2\)/);
    expect(body).toMatch(/client\.AgentSessions\.Get\(ctx, session\.ID\)/);
    expect(body).toMatch(/client\.AgentSessions\.Close\(ctx, session\.ID\)/);
    expect(existsSync(E('agent_chat/main.go'))).toBe(true);
  });
});
