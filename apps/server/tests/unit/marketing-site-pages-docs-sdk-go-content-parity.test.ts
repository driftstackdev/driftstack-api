// W514.A — drift guard for apps/marketing-site/src/pages/docs/sdk-go.astro.
// V-706 Go SDK quickstart. Drift here either changes the module path (would
// create marketing↔go-proxy divergence) or breaks the typed-errors framing
// (would mislead about errors.As / errors.Is patterns).
//
//   • V-706 doc-comment framing + V-703/V-704 SDK-trilogy companion.
//   • Module: github.com/driftstackdev/driftstack-api/packages/sdk-go.
//   • Go ≥ 1.22 + zero non-stdlib deps + net/http JSON.
//   • driftstack.NewClient(Config{APIKey, BaseURL}) + no-network-on-construct
//     + http.Client-pooled.
//   • sessions.Create no target URL + Sessions.Navigate to URL.
//   • 5-state SessionStatus constants: SessionCreating / SessionReady /
//     SessionBusy / SessionDestroyed / SessionErrored.
//   • 5-method drive surface: Navigate / Interact / Wait / Capture / Destroy.
//   • Typed errors with errors.As + errors.Is + ErrConflict sentinel +
//     RetryAfterSeconds.
//   • RFC 9457 4-field apiError shape: Status / ProblemType / Message / Problem.
//   • context.Context first-arg + cancellation cascades.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-go.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W514.A apps/marketing-site/src/pages/docs/sdk-go.astro content parity', () => {
  const body = read(LIB);

  it("V-706 framing pinned: 'Go SDK quickstart. Third entry in the SDK quickstart trilogy (TypeScript V-703 / Python V-704). Same skeleton, Go-idiomatic examples. Pitched at backend teams running Go services that need a browser leg for scrape / E2E / generate-PDF workloads.' — pinned so the V-706 anchor + V-703/V-704 trilogy cross-ref + target-audience framing all survive (drift to dropping the trilogy anchor would orphan the doc from the sister-SDK reference)", () => {
    expect(body).toMatch(
      /\/\/ V-706 — Go SDK quickstart\. Third entry in the SDK quickstart trilogy\s*\n?\s*\/\/ \(TypeScript V-703 \/ Python V-704\)\. Same skeleton, Go-idiomatic\s*\n?\s*\/\/ examples\. Pitched at backend teams running Go services that need a\s*\n?\s*\/\/ browser leg for scrape \/ E2E \/ generate-PDF workloads\./,
    );
  });

  it('tagged pre-1.0 module install is pinned with reproducibility, Go floor, and dependency posture', () => {
    expect(body).toMatch(
      /go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go@latest/,
    );
    expect(body).toContain('The Go SDK is published as a tagged pre-1.0 module');
    expect(body).toMatch(
      /Commit the resulting\s*\n?\s*<code>go\.mod<\/code> and <code>go\.sum<\/code> for reproducible deployments/,
    );
    expect(body).not.toMatch(/@<exact-commit>|first tag pending/i);
    expect(body).toMatch(
      /Go ≥ 1\.22 is supported\. The module has zero non-stdlib runtime\s*\n?\s*dependencies\s*\n?\s*\(it speaks raw JSON over <code>net\/http<\/code>\); no\s*\n?\s*transitive bloat\./,
    );
  });

  it('driftstack.New(apiKey, opts...) functional-options constructor + WithBaseURL override + no-error-on-construct + no-network-on-construct + http.Client-pooled framing pinned — pinned so the constructor + WithBaseURL functional option + New-does-not-return-an-error + no-network-on-construct + http.Client-pooled-reuse commitments survive (drift to claiming a network call at construct-time would mislead about init cost). The constructor shape was corrected to driftstack.New(os.Getenv("DRIFTSTACK_API_KEY")) with driftstack.WithBaseURL(...) functional options, matching packages/sdk-go/client.go (func New(apiKey string, opts ...Option) *Client + func WithBaseURL); the previous NewClient(Config{APIKey, BaseURL}) struct-config shape no longer exists.', () => {
    expect(body).toMatch(/client := driftstack\.New\(os\.Getenv\("DRIFTSTACK_API_KEY"\)\)/);
    expect(body).toMatch(
      /\/\/ BaseURL defaults to https:\/\/api\.driftstack\.dev; pass\s*\n?\s*\/\/ driftstack\.WithBaseURL\(\.\.\.\) to override for staging or\s*\n?\s*\/\/ self-hosted deployments\. New does not return an error\./,
    );
    expect(body).toMatch(
      /The constructor does not make any network calls\. Reuse one\s*\n?\s*client across your process — it is internally pooled via\s*\n?\s*<code>http\.Client<\/code> with sensible defaults/,
    );
    // Anti-drift: the previous struct-config constructor must NOT return —
    // NewClient(Config{...}) is not the SDK's exported surface.
    expect(body).not.toMatch(/driftstack\.NewClient\(driftstack\.Config\{/);
  });

  it('Sessions.Create + CreateSessionRequest (Archetype omitted to inherit the locked launch default iphone17_ios18_7_safari26_4 + PurposeProductionCustomer) + 5-state SessionStatus constants pinned: SessionCreating + SessionReady + SessionBusy + SessionDestroyed + SessionErrored + \'switch on those for exhaustive compile-time coverage\' + no-target-URL framing — pinned so the omit-Archetype-to-inherit-locked-default + Purpose field + 5-state-constant + exhaustive-switch + no-URL-on-create commitments survive (drift to dropping any state constant would shrink the typed-status surface). The Archetype field is now omitted (commented) in the sample to inherit the locked launch default rather than passed as a literal "default".', () => {
    expect(body).toMatch(
      /session, err := client\.Sessions\.Create\(ctx, &driftstack\.CreateSessionRequest\{/,
    );
    expect(body).toMatch(
      /\/\/ Omit Archetype to inherit the locked launch default\s*\n?\s*\/\/ \(iphone17_ios18_7_safari26_4\); pass a real registry slug\s*\n?\s*\/\/ to pin a specific device profile\./,
    );
    expect(body).toMatch(/Purpose:\s+driftstack\.PurposeProductionCustomer/);
    expect(body).toMatch(
      /<code>SessionStatus<\/code> type with the constants\s*\n?\s*<code>SessionCreating<\/code>, <code>SessionReady<\/code>,\s*\n?\s*<code>SessionBusy<\/code>, <code>SessionDestroyed<\/code>, and\s*\n?\s*<code>SessionErrored<\/code> — switch on those for exhaustive\s*\n?\s*compile-time coverage\./,
    );
    expect(body).toMatch(
      /The create call doesn't take a target\s*\n?\s*URL; drive the session to a URL with\s*\n?\s*<code>client\.Sessions\.Navigate\(\.\.\.\)<\/code>\./,
    );
  });

  it("5-method drive surface: Navigate + Interact + Wait + Capture + Destroy (idempotent) + 'no built-in wait-until-terminal helper' framing pinned — pinned so the 5-method drive surface + no-magic-wait-helper + idempotent-destroy survive (drift to claiming a wait-until-terminal helper exists would mislead about the SDK surface)", () => {
    expect(body).toMatch(
      /There is no built-in <em>wait-until-terminal<\/em> helper\. Drive\s*\n?\s*the session through its lifecycle with\s*\n?\s*<code>Navigate<\/code>, <code>Interact<\/code>,\s*\n?\s*<code>Wait<\/code>, <code>Capture<\/code>, then\s*\n?\s*<code>Destroy<\/code> when you're done\./,
    );
    expect(body).toMatch(/\/\/ Idempotent\./);
  });

  it("Wait kind='time' + Capture kind='screenshot' + Destroy framing pinned + 'For batch workloads, prefer webhooks over polling.' — pinned so the Wait/Capture/Destroy snippets + webhooks-over-polling commitment survive (drift to dropping the prefer-webhooks framing would let batch-workload customers default to polling). Wait uses the canonical NewTimeCondition() constructor — the previous pin asserted `Kind: \"time\"` + `DurationMs: 1000` directly on WaitRequest, but the actual SDK shape is `Condition: WaitCondition{Kind, MS}` per packages/sdk-go/types.go:393 (the WaitRequest wraps a WaitCondition; the time-variant uses MS not DurationMs). Customer Go code copy-pasting from the previous shape would not compile.", () => {
    expect(body).toMatch(/Condition:\s+driftstack\.NewTimeCondition\(1000\)/);
    expect(body).toMatch(/Kind: "screenshot"/);
    expect(body).toMatch(/shot\.ByteSize/);
    expect(body).toMatch(/client\.Sessions\.Destroy\(ctx, session\.ID\)/);
    // The previous (wrong) flat shape must NOT return.
    expect(body).not.toMatch(/Kind:\s+"time"/);
    expect(body).not.toMatch(/DurationMs: 1000/);
    expect(body).toMatch(
      /For batch workloads, prefer\s*\n?\s*<a href="\/docs\/webhooks\/">webhooks<\/a> over polling\./,
    );
    expect(body).not.toMatch(/href="\/docs\/webhooks"/);
  });

  it('Sessions.List pagination framing pinned: ListSessionsQuery{Limit: 50} + page.Data range + page.NextCursor nil-pointer + deref *page.NextCursor as query.Cursor — pinned so the List + NextCursor-nil + deref-refeed-pattern survives (drift to dropping NextCursor would create marketing↔server-cursor divergence). NextCursor is a *string (nil when there are no more pages), matching packages/sdk-go/agent_sessions.go:190 (NextCursor *string); the previous empty-string framing was wrong — the refeed dereferences *page.NextCursor.', () => {
    expect(body).toMatch(
      /page, err := client\.Sessions\.List\(ctx, &driftstack\.ListSessionsQuery\{Limit: 50\}\)/,
    );
    expect(body).toMatch(/for _, s := range page\.Data \{/);
    expect(body).toMatch(/s\.Status == driftstack\.SessionDestroyed/);
    expect(body).toMatch(
      /\/\/ page\.NextCursor is nil when there are no more pages; otherwise\s*\n?\s*\/\/ pass \*page\.NextCursor as query\.Cursor on the next call to walk\s*\n?\s*\/\/ the full history\./,
    );
    // Anti-drift: the previous empty-string-sentinel framing must NOT return —
    // NextCursor is a *string (nil-on-last-page), not a "" empty string.
    expect(body).not.toMatch(/page\.NextCursor is "" when there are no more pages/);
  });

  it('Typed-errors surface pinned: ValidationError + RateLimitError + ConcurrencyLimitError + NotFoundError + errors.As recover-typed-shape + errors.Is sentinel-match + ErrRateLimit + ErrValidation + ErrConflict 409-any-subclass — pinned so the 4-named-error + errors.As/errors.Is + 3-sentinel surface (ErrRateLimit/ErrValidation/ErrConflict) survives (drift to renaming any subclass would create marketing↔SDK divergence)', () => {
    expect(body).toMatch(
      /<code>ValidationError<\/code>, <code>RateLimitError<\/code>,\s*\n?\s*<code>ConcurrencyLimitError<\/code>,\s*\n?\s*<code>NotFoundError<\/code>, etc\./,
    );
    expect(body).toMatch(/var rl \*driftstack\.RateLimitError/);
    expect(body).toMatch(/if errors\.As\(err, &rl\)/);
    expect(body).toMatch(/rl\.RetryAfterSeconds/);
    expect(body).toMatch(/var ve \*driftstack\.ValidationError/);
    expect(body).toMatch(/if errors\.Is\(err, driftstack\.ErrConflict\)/);
    expect(body).toMatch(/\/\/ any 409, regardless of subclass/);
  });

  it('apiError 4-attribute RFC 9457 shape is pinned', () => {
    expect(body).toMatch(
      /Every typed error embeds an <code>apiError<\/code> shape with\s*\n?\s*<code>Status<\/code>, <code>ProblemType<\/code> \(the RFC 9457\s*\n?\s*URI\), <code>Message<\/code>, and <code>Problem<\/code> \(the full\s*\n?\s*parsed problem map\)\. Read additional extension fields off\s*\n?\s*<code>err\.Problem<\/code>\./,
    );
  });

  it('context.Context propagation is pinned without an unverified leak absolute', () => {
    expect(body).toMatch(
      /Every method takes a <code>context\.Context<\/code> as its first\s*\n?\s*argument\. Cancellation cascades through the underlying HTTP\s*\n?\s*requests, so a parent deadline \(or an HTTP request cancellation\s*\n?\s*in a Gin \/ chi \/ standard <code>http\.Server<\/code> handler\)\s*\n?\s*cleanly aborts the underlying in-flight HTTP call\./,
    );
    expect(body).not.toMatch(/No goroutine leaks even/);
  });

  it('7-where-to-go-next cluster: /api-reference + /docs/sdk-go-crypto-orders + /docs/sdk-typescript + /docs/sdk-python + /docs/webhooks + /docs/cost-monitoring + /docs/error-codes — pinned so the 7-related-doc navigation surface stays complete (drift to dropping /docs/sdk-go-crypto-orders would orphan the V-666 crypto-checkout cross-reference)', () => {
    const relatedDocs = [
      ['/api-reference', 'Curated API map'],
      ['/docs/sdk-go-crypto-orders', 'Crypto orders'],
      ['/docs/sdk-typescript', 'TypeScript SDK'],
      ['/docs/sdk-python', 'Python SDK'],
      ['/docs/webhooks', 'Webhooks'],
      ['/docs/cost-monitoring', 'Cost monitoring'],
      ['/docs/error-codes', 'Error codes'],
    ] as const;

    for (const [path, label] of relatedDocs) {
      expect(body).toContain(`<a href="${path}/">${label}</a>`);
      expect(body).not.toContain(`<a href="${path}">${label}</a>`);
    }
    expect(body).toContain('complete interactive reference');
  });

  it('paid customer-key and Free desktop-device boundary is explicit', () => {
    expect(body).toContain('SDK automation requires an API-enabled paid tier');
    expect(body).toContain('<code>ds_live_…</code> customer API key');
    expect(body).toContain('<code>ds_test_…</code> device credential');
    expect(body).toContain('not an SDK');
    expect(body).toContain('sandbox key');
  });

  it("developers@driftstack.dev + 'within one business day' SLA pinned — pinned so the developer-channel routing + 1-business-day response commitment stays consistent across SDK pages (drift to a different SLA would create cross-page divergence)", () => {
    expect(body).toMatch(
      /<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>\.\s*\n?\s*We respond within one business day\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
