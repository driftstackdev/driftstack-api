// Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — in-process metrics registry.
//
// Renders Prometheus exposition format directly; no external deps. The
// surface is intentionally narrow (counters + gauges, no histograms) —
// histograms can land in a follow-up when the first signal calls for
// them. The /metrics route (registerMetricsRoutes) scrapes via
// registry.render().
//
// Format spec: https://prometheus.io/docs/instrumenting/exposition_formats/
// (text 0.0.4 — the simple line-based variant Prometheus + VictoriaMetrics
// + Grafana Agent all consume.)
//
// Label cardinality: callers MUST keep label values bounded (enum-like).
// The registry doesn't enforce this — it would punish legitimate dynamic
// label use — but high-cardinality labels (account_id, session_id) WILL
// blow up the scrape size. Convention: only enum-shaped labels (state
// names, action kinds, success/error) appear in counter labels here.

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type Labels = Readonly<Record<string, string>>;

interface CounterDef {
  readonly kind: 'counter';
  readonly help: string;
  readonly values: Map<string, number>;
  readonly labelKeys: readonly string[];
}

interface GaugeDef {
  readonly kind: 'gauge';
  readonly help: string;
  readonly values: Map<string, number>;
  readonly labelKeys: readonly string[];
}

type MetricDef = CounterDef | GaugeDef;

function validateMetricName(name: string): void {
  if (!METRIC_NAME_RE.test(name)) {
    throw new Error(`Invalid Prometheus metric name: ${name}`);
  }
}

function validateLabelNames(labelKeys: readonly string[]): void {
  for (const k of labelKeys) {
    if (!LABEL_NAME_RE.test(k)) {
      throw new Error(`Invalid Prometheus label name: ${k}`);
    }
  }
}

function labelKey(labelKeys: readonly string[], labels: Labels | undefined): string {
  if (labelKeys.length === 0) return '';
  return labelKeys.map((k) => labels?.[k] ?? '').join('\x00');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labelKeys: readonly string[], compositeKey: string): string {
  if (labelKeys.length === 0) return '';
  const parts = compositeKey.split('\x00');
  const pairs: string[] = [];
  for (let i = 0; i < labelKeys.length; i++) {
    const v = parts[i] ?? '';
    pairs.push(`${labelKeys[i]}="${escapeLabelValue(v)}"`);
  }
  return `{${pairs.join(',')}}`;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricDef>();

  registerCounter(name: string, help: string, labelKeys: readonly string[] = []): void {
    validateMetricName(name);
    validateLabelNames(labelKeys);
    if (this.metrics.has(name)) {
      throw new Error(`Metric already registered: ${name}`);
    }
    this.metrics.set(name, {
      kind: 'counter',
      help,
      labelKeys,
      values: new Map(),
    });
  }

  registerGauge(name: string, help: string, labelKeys: readonly string[] = []): void {
    validateMetricName(name);
    validateLabelNames(labelKeys);
    if (this.metrics.has(name)) {
      throw new Error(`Metric already registered: ${name}`);
    }
    this.metrics.set(name, {
      kind: 'gauge',
      help,
      labelKeys,
      values: new Map(),
    });
  }

  inc(name: string, labels?: Labels, delta = 1): void {
    const def = this.metrics.get(name);
    if (!def || def.kind !== 'counter') {
      throw new Error(`Counter not registered: ${name}`);
    }
    if (delta < 0) throw new Error(`Counter delta must be non-negative; got ${delta} for ${name}`);
    const key = labelKey(def.labelKeys, labels);
    def.values.set(key, (def.values.get(key) ?? 0) + delta);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    const def = this.metrics.get(name);
    if (!def || def.kind !== 'gauge') {
      throw new Error(`Gauge not registered: ${name}`);
    }
    const key = labelKey(def.labelKeys, labels);
    def.values.set(key, value);
  }

  /** Test-only: read a single value. */
  getValue(name: string, labels?: Labels): number {
    const def = this.metrics.get(name);
    if (!def) return 0;
    const key = labelKey(def.labelKeys, labels);
    return def.values.get(key) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const sortedNames = Array.from(this.metrics.keys()).sort();
    for (const name of sortedNames) {
      const def = this.metrics.get(name);
      if (!def) continue;
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} ${def.kind}`);
      const sortedKeys = Array.from(def.values.keys()).sort();
      for (const k of sortedKeys) {
        const labelStr = renderLabels(def.labelKeys, k);
        lines.push(`${name}${labelStr} ${def.values.get(k) ?? 0}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Stable metric-name catalog — single source-of-truth for counters
 *  emitted across the codebase. Drift guards key on these constants. */
export const METRIC_NAMES = {
  pairModeTransitionTotal: 'driftstack_pair_mode_transition_total',
  bundledLlmRequestTotal: 'driftstack_bundled_llm_request_total',
  bundledLlmErrorTotal: 'driftstack_bundled_llm_error_total',
  // Arc 7 obs.3 — agent decompose call counter. Labelled by
  // result-kind (plan / clarify / refuse) so the dashboard can
  // ratio "useful decomposes" (plan) against the no-op kinds
  // (clarify + refuse). Mirrors the agent.decompose.* audit-log
  // surface but at metrics-cardinality (bounded) rather than
  // per-call audit rows.
  // Retention purge outcome counter, labelled by `arm` (byok |
  // proxy_secrets | profiles | snapshots) and `outcome` (purged |
  // failed | skipped).
  //
  // The account-deletion sweep carries three separate privacy-policy.md §9
  // erasure commitments on one 30-day clock, and until now it emitted nothing:
  // if a tick started failing, or an arm was never wired, the only trace was a
  // log line nobody is watching for. `skipped` is the load-bearing label — it
  // is the signal for the failure mode that actually happened, an arm switched
  // off by an unrelated flag while the sweeper still reported success. Alert on
  // `skipped`, or on the ABSENCE of `purged` over a window longer than the
  // sweep interval; a promise that quietly stops running looks identical to one
  // with nothing to do, and only the counter tells them apart.
  retentionPurgeTotal: 'driftstack_retention_purge_total',
  // Liveness of each self-re-arming job chain: 1 when a pending row exists for
  // that job_type, 0 when none does.
  //
  // Every recurring sweep survives by enqueueing its own successor, and every
  // register* helper carries a comment warning that a throw without a re-arm
  // leaves the chain "dead until a process restart". Nothing detected that.
  // Zero here IS that state, per job type, and it is the difference between a
  // sweep that has nothing to do and a sweep that will never run again.
  //
  // Refreshed at SCRAPE time rather than from a job tick, deliberately: a
  // watchdog that rides on a chain dies with the chain it watches.
  scheduledJobChainPending: 'driftstack_scheduled_job_chain_pending',
  agentDecomposeTotal: 'driftstack_agent_decompose_total',
  // Arc 7 obs.4 — BYOK Anthropic /test endpoint outcome counter.
  // Labelled by outcome (ok / invalid / quota_exceeded / unknown
  // / not_set / not_wired) so the dashboard can chart customer
  // BYOK health (ok+invalid is the customer signal; quota_exceeded
  // tells us their Anthropic account is throttling; not_wired
  // means the deployment hasn't shipped the AI-B1.b real tester).
  byokAnthropicTestTotal: 'driftstack_byok_anthropic_test_total',
  // Arc 7 obs.5 — rate-limit consume counter. Labelled by bucket
  // (e.g. 'global', 'sessions:create') + outcome (allowed | exceeded).
  // Bucket cardinality is fixed by the call sites that register
  // rateLimit('<bucket>'); not customer-id-cardinality. Visible as a
  // capacity-planning signal (which buckets saturate first under load)
  // and a security signal (which clients are hitting limits hard).
  rateLimitTotal: 'driftstack_rate_limit_total',
  // Arc 7 obs.6 — auth-resolution outcome counter. Labelled by outcome
  // (ok / unauthorized / invalid / revoked / expired / forbidden /
  // error). A jump in 'invalid' or 'revoked' is a brute-force /
  // credential-stuffing signal; a jump in 'ok' tracks legitimate
  // traffic growth.
  authTotal: 'driftstack_auth_total',
  // Arc 7 obs.7 — OAuth /token exchange outcome counter. Labels are
  // the OAuthError code set (ok / invalid_grant / invalid_client /
  // invalid_request / invalid_scope / access_denied /
  // unauthorized_client / error). Spike in 'invalid_grant' tracks
  // PKCE mismatches + expired-code retries; spike in 'invalid_client'
  // tracks attempted brute-force against the client_secret hash.
  oauthTokenTotal: 'driftstack_oauth_token_total',
  // Arc 7 obs.8 — Stripe webhook outcome counter. Bounded outcome
  // labels: handled / duplicate / ignored / error (route-side dispatch
  // outcomes) + signature_invalid / signature_missing / empty_body /
  // malformed_event (pre-dispatch reject paths). Spike in 'error'
  // signals a Stripe contract change or a downstream bug; spike in
  // 'signature_invalid' signals webhook-spoofing attempts.
  stripeWebhookTotal: 'driftstack_stripe_webhook_total',
  // Arc 7 obs.9 — NOWPayments IPN receiver outcome counter. Same
  // shape as obs.8 (signature_missing / signature_invalid / empty_body
  // / malformed_event / ok). Distinct counter because the threat
  // model (crypto-payment spoofing) and the operational baseline
  // (NOWPayments traffic volume) are different from Stripe — mixing
  // them under one label set would hide the per-provider signal.
  nowpaymentsWebhookTotal: 'driftstack_nowpayments_webhook_total',
  // Arc 7 obs.10 — customer-audit-log emission counter. Labelled by
  // the AccountAuditAction's top-level prefix (`api_key`, `session`,
  // `agent_session`, `billing`, `team`, etc.) and the actor type
  // (customer | system | staff). Cardinality stays bounded by the
  // prefix count rather than the full action enum. Security signal:
  // surges in `api_key` actor=customer can fingerprint compromised
  // accounts; surges in `staff` actor signal admin activity.
  accountAuditEmitTotal: 'driftstack_account_audit_emit_total',
  // Arc 7 obs.11 — admin-audit-log emission counter. Labelled by the
  // AdminAuditAction's top-level prefix only (actor is always
  // 'staff' for the admin surface). Surfaces operator activity by
  // category — incident management vs account suspension vs
  // refund recording — so the dashboard can chart admin-action
  // distribution over time.
  adminAuditEmitTotal: 'driftstack_admin_audit_emit_total',
  // Arc 7 obs.12 — LiveKit token mint counter. Labelled by role
  // (publisher | subscriber) and outcome (ok / not_found / validation).
  // Publisher tokens are issued for capture-side processes; subscriber
  // tokens for the live-preview dashboard surface. A surge in
  // not_found is either a 404 enumeration probe or a session-id
  // mismatch bug; a surge in 'ok' tracks WebRTC adoption.
  livekitTokenMintTotal: 'driftstack_livekit_token_mint_total',
  // Arc 7 obs.13 — outbound email send counter. Labelled by template
  // (signup-verification / password-reset / billing-receipt / etc.)
  // and outcome (ok / postmark_pending_approval / recipient_inactive
  // / transport_error / config_error — the classifyEmailError code
  // set). A spike in 'postmark_pending_approval' = the approval is
  // still blocking transactional traffic; ops priority bump.
  emailSendTotal: 'driftstack_email_send_total',
  // Arc 7 obs.14 — outbound webhook delivery counters. The dispatcher
  // emits TWO counters per delivery:
  //   - attempt_total{outcome} — every HTTP attempt (success /
  //     http_error / timeout / transport_error). Spike in
  //     transport_error or timeout fingerprints a customer endpoint
  //     outage.
  //   - terminal_total{terminal_state} — only on terminal state
  //     transitions (delivered | dlq). dlq counter tracks customers
  //     whose endpoints have been unreachable for the full retry curve.
  webhookDeliveryAttemptTotal: 'driftstack_webhook_delivery_attempt_total',
  webhookDeliveryTerminalTotal: 'driftstack_webhook_delivery_terminal_total',
  // Arc 7 obs.15 — foundational HTTP request counter. Labelled by
  // method × route template × status class. Cardinality is bounded
  // by:
  //   - method: 5 (GET/POST/PUT/DELETE/PATCH)
  //   - route: Fastify's parameterized route template (e.g.
  //     `/v1/sessions/:id`), bounded by the count of registered routes
  //   - status_class: 5 (1xx/2xx/3xx/4xx/5xx)
  // The route label uses the TEMPLATE, never the URL, so account ids
  // / session ids / etc. don't leak.
  httpRequestTotal: 'driftstack_http_request_total',
  // Arc 7 obs.16 — LK.2 Mac LiveKit credential registration counter.
  // Labelled by outcome (ok / validation / encryption_error / not_found
  // / unknown). Surfaces operator-side credential-provisioning health:
  //   - `ok` is the happy path (Mac harness POSTed; row persisted).
  //   - `validation` = Zod parse failed (bad UUID, bad URL).
  //   - `encryption_error` = AES-256-GCM seal failed (key length wrong;
  //     ops alert).
  //   - `not_found` = mac_node_id has no fleet_nodes row (V-820
  //     provisioning hasn't run for this Mac yet).
  //   - `unknown` = anything else (best-effort bucket).
  // Bounded cardinality. Companion to admin_audit_emit_total which
  // tracks the successful audit-row writes; this counter sees the
  // pre-audit reject paths too.
  macNodeLivekitRegisterTotal: 'driftstack_mac_node_livekit_register_total',
  // DoS hardening — rate-limit primary-store (Redis) failure counter.
  // Incremented each time a limiter's primary store throws and it
  // degrades to the bounded per-instance memory fallback. Labelled by
  // limiter ('account' | 'ip'). ANY non-zero value is an alert signal:
  // the cluster is running on coarse per-instance limiting, not the
  // shared Redis buckets. Bounded cardinality.
  rateLimitStoreFallbackTotal: 'driftstack_rate_limit_store_fallback_total',
} as const;
