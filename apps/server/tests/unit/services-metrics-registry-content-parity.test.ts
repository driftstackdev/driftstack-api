// Drift guard for apps/server/src/services/metrics-registry.ts. Pins the
// Arc 4 Wave 2.B sub-slice 8.18 in-process Prometheus metrics registry
// — counter + gauge surface, Prometheus 0.0.4 line-based exposition,
// METRIC_NAMES single-source-of-truth catalog, NUL-byte composite key.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/metrics-registry.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/metrics-registry content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 4 Wave 2.B sub-slice 8.18 module-level framing pinned: 'in-process metrics registry. Renders Prometheus exposition format directly; no external deps. The surface is intentionally narrow (counters + gauges, no histograms) — histograms can land in a follow-up when the first signal calls for them. The /metrics route (registerMetricsRoutes) scrapes via registry.render().' — pinned so the 8.18 anchor + no-external-deps + counter+gauge-only-no-histogram scope + /metrics scrape path stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 4 Wave 2\.B sub-slice 8\.18 \(v2-#8\) — in-process metrics registry\./,
    );
    expect(body).toMatch(
      /\/\/ Renders Prometheus exposition format directly; no external deps\. The\s*\/\/ surface is intentionally narrow \(counters \+ gauges, no histograms\) —\s*\/\/ histograms can land in a follow-up when the first signal calls for\s*\/\/ them\. The \/metrics route \(registerMetricsRoutes\) scrapes via\s*\/\/ registry\.render\(\)\./,
    );
  });

  it("Format-spec framing pinned: 'https://prometheus.io/docs/instrumenting/exposition_formats/ (text 0.0.4 — the simple line-based variant Prometheus + VictoriaMetrics + Grafana Agent all consume.)' — pinned so the 0.0.4 spec anchor + 3-consumer-compatibility (Prometheus + VictoriaMetrics + Grafana Agent) stay documented", () => {
    expect(body).toMatch(
      /\/\/ Format spec: https:\/\/prometheus\.io\/docs\/instrumenting\/exposition_formats\/\s*\/\/ \(text 0\.0\.4 — the simple line-based variant Prometheus \+ VictoriaMetrics\s*\/\/ \+ Grafana Agent all consume\.\)/,
    );
  });

  it("Label-cardinality framing pinned: 'callers MUST keep label values bounded (enum-like). The registry doesn't enforce this — it would punish legitimate dynamic label use — but high-cardinality labels (account_id, session_id) WILL blow up the scrape size. Convention: only enum-shaped labels (state names, action kinds, success/error) appear in counter labels here.' — pinned so the bounded-cardinality CONVENTION + 2-bad-example (account_id/session_id) + enum-shape rule stay documented (drift would invite per-customer-id labels that blow up the scrape)", () => {
    expect(body).toMatch(
      /\/\/ Label cardinality: callers MUST keep label values bounded \(enum-like\)\.\s*\/\/ The registry doesn't enforce this — it would punish legitimate dynamic\s*\/\/ label use — but high-cardinality labels \(account_id, session_id\) WILL\s*\/\/ blow up the scrape size\. Convention: only enum-shaped labels \(state\s*\/\/ names, action kinds, success\/error\) appear in counter labels here\./,
    );
  });

  it('METRIC_NAME_RE + LABEL_NAME_RE Prometheus-spec character-class regexes pinned: metric ^[a-zA-Z_:][a-zA-Z0-9_:]*$ + label ^[a-zA-Z_][a-zA-Z0-9_]*$. Drift would diverge from the Prometheus naming spec and cause scrape parser rejections', () => {
    expect(body).toMatch(/const METRIC_NAME_RE = \/\^\[a-zA-Z_:\]\[a-zA-Z0-9_:\]\*\$\/;/);
    expect(body).toMatch(/const LABEL_NAME_RE = \/\^\[a-zA-Z_\]\[a-zA-Z0-9_\]\*\$\/;/);
  });

  it("NUL-byte composite-key delimiter pinned: 'labelKey(labelKeys, labels)' joins labels-by-key with \\x00. Drift to a printable delimiter would let attackers smuggle composite-key collisions where one label-value contains the delimiter character", () => {
    expect(body).toMatch(
      /function labelKey\(labelKeys: readonly string\[\], labels: Labels \| undefined\): string \{\s*if \(labelKeys\.length === 0\) return '';\s*return labelKeys\.map\(\(k\) => labels\?\.\[k\] \?\? ''\)\.join\('\\x00'\);\s*\}/,
    );
  });

  it('Label-value escapeLabelValue 3-char escape pinned: backslash → \\\\ + double-quote → \\" + newline → \\n. Drift would let label values break the Prometheus line-based exposition format (especially newlines, which terminate samples in the wire format)', () => {
    expect(body).toMatch(
      /function escapeLabelValue\(v: string\): string \{\s*return v\.replace\(\/\\\\\/g, '\\\\\\\\'\)\.replace\(\/"\/g, '\\\\"'\)\.replace\(\/\\n\/g, '\\\\n'\);\s*\}/,
    );
  });

  it('MetricsRegistry 6-method surface pinned: registerCounter + registerGauge + inc + setGauge + getValue (test-only) + render. registerCounter + registerGauge throw on duplicate-name. inc rejects negative delta. Drift to allowing negative counter delta would defeat the monotonic-counter contract that Prometheus relies on for rate() calculations', () => {
    expect(body).toMatch(/export class MetricsRegistry \{/);
    expect(body).toMatch(
      /registerCounter\(name: string, help: string, labelKeys: readonly string\[\] = \[\]\): void/,
    );
    expect(body).toMatch(
      /registerGauge\(name: string, help: string, labelKeys: readonly string\[\] = \[\]\): void/,
    );
    expect(body).toMatch(/inc\(name: string, labels\?: Labels, delta = 1\): void/);
    expect(body).toMatch(/setGauge\(name: string, value: number, labels\?: Labels\): void/);
    expect(body).toMatch(/getValue\(name: string, labels\?: Labels\): number/);
    expect(body).toMatch(/render\(\): string/);
    expect(body).toMatch(/throw new Error\(`Metric already registered: \$\{name\}`\);/);
    expect(body).toMatch(
      /if \(delta < 0\) throw new Error\(`Counter delta must be non-negative; got \$\{delta\} for \$\{name\}`\);/,
    );
  });

  it('render() emits HELP + TYPE comment lines + sorted samples. Drift to skipping HELP/TYPE would diverge from the Prometheus spec; drift to unsorted samples would make scrape diffs noisy in observability tools', () => {
    expect(body).toMatch(
      /lines\.push\(`# HELP \$\{name\} \$\{def\.help\}`\);\s*lines\.push\(`# TYPE \$\{name\} \$\{def\.kind\}`\);/,
    );
    expect(body).toMatch(/const sortedNames = Array\.from\(this\.metrics\.keys\(\)\)\.sort\(\);/);
    expect(body).toMatch(/const sortedKeys = Array\.from\(def\.values\.keys\(\)\)\.sort\(\);/);
  });

  it("METRIC_NAMES catalog framing pinned: 'Stable metric-name catalog — single source-of-truth for counters emitted across the codebase. Drift guards key on these constants.' — pinned so the single-source-of-truth role + drift-guards-key-on-this contract stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Stable metric-name catalog — single source-of-truth for counters\s*\*\s+emitted across the codebase\. Drift guards key on these constants\. \*\/\s*export const METRIC_NAMES = \{/,
    );
    expect(body).toMatch(/\} as const;/);
  });

  it('METRIC_NAMES 18-entry catalog pinned: pairModeTransition + bundledLlmRequest + bundledLlmError + agentDecompose + byokAnthropicTest + rateLimit + auth + oauthToken + stripeWebhook + nowpaymentsWebhook + accountAuditEmit + adminAuditEmit + livekitTokenMint + emailSend + webhookDeliveryAttempt + webhookDeliveryTerminal + httpRequest + macNodeLivekitRegister + rateLimitStoreFallback. Drift to renaming a key would break every callsite that emits to that metric; drift to dropping a key would let the metric become an orphan-shaped string', () => {
    expect(body).toMatch(/pairModeTransitionTotal: 'driftstack_pair_mode_transition_total',/);
    expect(body).toMatch(/bundledLlmRequestTotal: 'driftstack_bundled_llm_request_total',/);
    expect(body).toMatch(/bundledLlmErrorTotal: 'driftstack_bundled_llm_error_total',/);
    expect(body).toMatch(/agentDecomposeTotal: 'driftstack_agent_decompose_total',/);
    expect(body).toMatch(/byokAnthropicTestTotal: 'driftstack_byok_anthropic_test_total',/);
    expect(body).toMatch(/rateLimitTotal: 'driftstack_rate_limit_total',/);
    expect(body).toMatch(/authTotal: 'driftstack_auth_total',/);
    expect(body).toMatch(/oauthTokenTotal: 'driftstack_oauth_token_total',/);
    expect(body).toMatch(/stripeWebhookTotal: 'driftstack_stripe_webhook_total',/);
    expect(body).toMatch(/nowpaymentsWebhookTotal: 'driftstack_nowpayments_webhook_total',/);
    expect(body).toMatch(/accountAuditEmitTotal: 'driftstack_account_audit_emit_total',/);
    expect(body).toMatch(/adminAuditEmitTotal: 'driftstack_admin_audit_emit_total',/);
    expect(body).toMatch(/livekitTokenMintTotal: 'driftstack_livekit_token_mint_total',/);
    expect(body).toMatch(/emailSendTotal: 'driftstack_email_send_total',/);
    expect(body).toMatch(
      /webhookDeliveryAttemptTotal: 'driftstack_webhook_delivery_attempt_total',/,
    );
    expect(body).toMatch(
      /webhookDeliveryTerminalTotal: 'driftstack_webhook_delivery_terminal_total',/,
    );
    expect(body).toMatch(/httpRequestTotal: 'driftstack_http_request_total',/);
    expect(body).toMatch(
      /macNodeLivekitRegisterTotal: 'driftstack_mac_node_livekit_register_total',/,
    );
    expect(body).toMatch(
      /rateLimitStoreFallbackTotal: 'driftstack_rate_limit_store_fallback_total',/,
    );
  });

  it("obs.15 HTTP-request route-template-not-URL framing pinned: 'The route label uses the TEMPLATE, never the URL, so account ids / session ids / etc. don't leak.' — pinned so the no-PII-in-route-label privacy contract stays documented (drift to logging raw URLs in the route label would create per-customer-id high-cardinality + leak PII into scrape output)", () => {
    expect(body).toMatch(
      /\/\/ The route label uses the TEMPLATE, never the URL, so account ids\s*\/\/ \/ session ids \/ etc\. don't leak\./,
    );
  });
});
