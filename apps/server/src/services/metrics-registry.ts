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
//
// Histograms DID land, and the paragraph above is kept because it is the record
// of why they were deferred: the first signal that called for them was the
// agent turn. "Far too slow" is a complaint about a DISTRIBUTION — a mean turn
// time hides the one customer in five who waits a minute for the first sign of
// life — and a counter cannot carry a distribution. They are cumulative
// `_bucket{le=…}` / `_sum` / `_count` series, the shape `histogram_quantile`
// reads, with FIXED bucket bounds declared at registration so the series count
// is a property of the code and never of the traffic.

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

interface HistogramSeries {
  /** Per-bound counts, NOT cumulative; render() accumulates. One per bucket. */
  readonly counts: number[];
  sum: number;
  count: number;
}

interface HistogramDef {
  readonly kind: 'histogram';
  readonly help: string;
  /** Unused for a histogram; present so every MetricDef has a `values` map. */
  readonly values: Map<string, number>;
  readonly labelKeys: readonly string[];
  /** Upper bounds, strictly ascending; `+Inf` is implied. */
  readonly buckets: readonly number[];
  readonly series: Map<string, HistogramSeries>;
}

/** Test-only view of one histogram series. */
export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  /** Cumulative count per declared upper bound, in bucket order. */
  readonly cumulative: readonly number[];
}

type MetricDef = CounterDef | GaugeDef | HistogramDef;

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

  /**
   * `labelKeys` is LAST on purpose. The label-cardinality guard reads the
   * trailing array literal of every registration as its label keys; with the
   * buckets last, every histogram would read as label-less and the guard that
   * stops a `session_id` label would never see one.
   */
  registerHistogram(
    name: string,
    help: string,
    buckets: readonly number[],
    labelKeys: readonly string[] = [],
  ): void {
    validateMetricName(name);
    validateLabelNames(labelKeys);
    if (labelKeys.includes('le')) {
      throw new Error(`Histogram label "le" is reserved for the bucket bound: ${name}`);
    }
    if (this.metrics.has(name)) {
      throw new Error(`Metric already registered: ${name}`);
    }
    if (buckets.length === 0) throw new Error(`Histogram needs at least one bucket: ${name}`);
    for (let i = 0; i < buckets.length; i += 1) {
      const bound = buckets[i] ?? Number.NaN;
      const previous = i === 0 ? Number.NEGATIVE_INFINITY : (buckets[i - 1] ?? Number.NaN);
      if (!Number.isFinite(bound) || !(bound > previous)) {
        throw new Error(`Histogram buckets must be finite and strictly ascending: ${name}`);
      }
    }
    this.metrics.set(name, {
      kind: 'histogram',
      help,
      labelKeys,
      values: new Map(),
      buckets: [...buckets],
      series: new Map(),
    });
  }

  /**
   * Record one observation. A non-finite or negative value is DROPPED rather
   * than thrown: every histogram here measures a duration or a count, a
   * negative one is a clock artefact, and a `NaN` in `_sum` would poison the
   * series for the life of the process.
   */
  observe(name: string, value: number, labels?: Labels): void {
    const def = this.metrics.get(name);
    if (!def || def.kind !== 'histogram') {
      throw new Error(`Histogram not registered: ${name}`);
    }
    if (!Number.isFinite(value) || value < 0) return;
    const key = labelKey(def.labelKeys, labels);
    let series = def.series.get(key);
    if (series === undefined) {
      series = { counts: def.buckets.map(() => 0), sum: 0, count: 0 };
      def.series.set(key, series);
    }
    series.sum += value;
    series.count += 1;
    const index = def.buckets.findIndex((bound) => value <= bound);
    if (index >= 0) series.counts[index] = (series.counts[index] ?? 0) + 1;
  }

  /** Test-only: read one histogram series. */
  getHistogram(name: string, labels?: Labels): HistogramSnapshot {
    const def = this.metrics.get(name);
    if (!def || def.kind !== 'histogram') return { count: 0, sum: 0, cumulative: [] };
    const series = def.series.get(labelKey(def.labelKeys, labels));
    if (series === undefined) {
      return { count: 0, sum: 0, cumulative: def.buckets.map(() => 0) };
    }
    let running = 0;
    const cumulative = series.counts.map((c) => {
      running += c;
      return running;
    });
    return { count: series.count, sum: series.sum, cumulative };
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
      if (def.kind === 'histogram') {
        for (const k of Array.from(def.series.keys()).sort()) {
          const series = def.series.get(k);
          if (series === undefined) continue;
          const base = renderLabels(def.labelKeys, k);
          // `le` joins the series' own labels inside one brace pair.
          const withLe = (le: string): string =>
            base === '' ? `{le="${le}"}` : `${base.slice(0, -1)},le="${le}"}`;
          let running = 0;
          def.buckets.forEach((bound, i) => {
            running += series.counts[i] ?? 0;
            lines.push(`${name}_bucket${withLe(String(bound))} ${running}`);
          });
          lines.push(`${name}_bucket${withLe('+Inf')} ${series.count}`);
          lines.push(`${name}_sum${base} ${series.sum}`);
          lines.push(`${name}_count${base} ${series.count}`);
        }
        continue;
      }
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
  // Process-level unhandled-rejection backstop counter.
  //
  // The backstop deliberately keeps the process ALIVE when a fire-and-forget
  // promise rejects, so one missed .catch() cannot take the control plane down.
  // The cost of that choice is silence: the only trace was a log line, and the
  // counter it already kept was exported for "a future metrics scrape" that was
  // never wired. A path that starts rejecting on every request therefore looked
  // identical to a healthy one on every dashboard.
  //
  // Unlabelled on purpose. The rejection reason is unbounded text and would be
  // unbounded cardinality; the log line carries name + message + stack for
  // diagnosis, and this exists to make the RATE visible enough to go look.
  unhandledRejectionTotal: 'driftstack_unhandled_rejection_total',
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
  // ── AI agent turns ────────────────────────────────────────────────────
  //
  // Until these existed the only evidence of how the AI automation behaved in
  // production was a grep over proxy access logs. Everything below is emitted
  // from ONE place — services/agent-turn-telemetry.ts, at the message route's
  // seam — so a request that reaches the handler is counted exactly once
  // whatever path it took out. A request refused by a preHandler (401/403, the
  // per-caller rate limit's 429) never gets there: see httpRequestTotal and
  // rateLimitTotal for those.
  //
  // Every label is a closed enum declared in that file. None is ever a session
  // id, account id, URL, selector, task text or anything a model wrote.
  //
  // One request to POST /v1/agent-sessions/:id/message, by `outcome`. The 409s
  // are outcomes on purpose: a quarter of production requests ended in one,
  // and a counter that only saw turns that RAN could not have shown it.
  agentTurnTotal: 'driftstack_agent_turn_total',
  // Wall time of one request, by `outcome`.
  agentTurnDurationSeconds: 'driftstack_agent_turn_duration_seconds',
  // Time spent in each runtime phase, by `phase`, summed over a turn's repeats
  // (a re-plan re-enters `planning`).
  agentTurnPhaseDurationSeconds: 'driftstack_agent_turn_phase_duration_seconds',
  // Seconds from the request arriving to the FIRST progress event of the turn,
  // by `transport`. "It never shows thinking progress" is this number.
  agentTurnTimeToFirstProgressSeconds: 'driftstack_agent_turn_time_to_first_progress_seconds',
  // Settled model calls by `call_kind` (plan | re_plan | answer | unattributed)
  // and `model` (the catalogue ids, or `other`).
  agentTurnModelCallTotal: 'driftstack_agent_turn_model_call_total',
  // Tokens by `token_type` (input | output | cache_read | cache_write),
  // `call_kind` and `model`.
  agentTurnTokensTotal: 'driftstack_agent_turn_tokens_total',
  // Re-plan attempts in one turn, by `outcome`. A histogram with integer
  // bounds: the share of turns that needed a second look is the signal.
  agentTurnReplans: 'driftstack_agent_turn_replans',
  // The step a turn died on, by `reason` (the death-reason class) and
  // `step_kind` (the intent kind). Where real tasks die.
  agentTurnStepFailureTotal: 'driftstack_agent_turn_step_failure_total',
  // Per-turn diagnostics row writes, by `outcome` (ok | error | dropped | shed).
  // The write is fire-and-forget by design, so this counter is the ONLY place
  // its failure shows: `error` or `dropped` means the operator view is going
  // blind. `shed` is the per-minute budget on rows for turned-away requests
  // doing its job under a 409/429 storm, and is not a failure.
  agentTurnTelemetryWriteTotal: 'driftstack_agent_turn_telemetry_write_total',
  // WAS A BEHAVIOUR PROFILE ATTACHED TO THE SESSION THAT ACTED? One increment
  // per DISPATCHED click / send_keys attempt, retries included, by `verb`
  // (AGENT_ACTION_PROFILE_VERBS), `profile_attached`
  // (AGENT_PROFILE_ATTACHED_VALUES: true | false | unreported) and `outcome`
  // (AGENT_ACTION_OUTCOMES, the executor's own notion of a step's outcome).
  //
  // ⛔ A CONFIGURATION FACT, NOT A DETECTABILITY VERDICT. The device's flag is
  // `persona != nil`: whether a behaviour profile was resolved for the session.
  // `false` is a misconfiguration nothing else reports, because the step still
  // SUCCEEDS; `true` is NECESSARY AND NOT SUFFICIENT for the human-like path to
  // have run, and nothing here measures what the device then did. `unreported`
  // is a step with no usable result and is never read as `true`. Emitted from
  // recordAgentActionProfileAttached in services/agent-turn-telemetry.ts.
  agentActionProfileAttachedTotal: 'driftstack_agent_action_profile_attached_total',
  // WHICH OF THE DEVICE'S TWO SCROLL IMPLEMENTATIONS RAN, by `path`
  // (AGENT_SCROLL_PATHS: flick | segmented | unreported) and `outcome`.
  //
  // ⛔ NOT AN INDEPENDENT SIGNAL, AND NEVER ALERTED ON. The device picks the
  // path with the SAME predicate as `profile_attached` above, so the two are one
  // fact seen twice — a dashboard must not present them as corroborating. BOTH
  // paths are native touch sequences; `segmented` differs only in having a flat
  // cadence. Emitted from recordAgentScrollPath in
  // services/agent-turn-telemetry.ts.
  agentScrollPathTotal: 'driftstack_agent_scroll_path_total',
  // The look before a tap: one read-only `perceive` for the tap's selector,
  // asking the device what it resolves to and what is at its tap point (see
  // agent-executor-control-plane.ts). Emitted from recordPreTapLook in
  // services/agent-turn-telemetry.ts; `outcome` is PRE_TAP_LOOK_OUTCOMES (the
  // look's own verdict vocabulary), `resolved_by` is PRE_TAP_LOOK_RESOLVERS
  // (native | script | none | unanswered — the per-step resolution path, and the
  // native→script transition is what a detector would see) and `then` is
  // PRE_TAP_LOOK_NEXT_ACTIONS (tapped | typed | refused | not_sent).
  // Looks by outcome. `covered` and `not_found` are taps that were NOT sent.
  // EXTENDED rather than duplicated: the look already emitted one row per
  // pre-tap look here, so the resolution path is two more labels on the same
  // event and not a second counter that would have to agree with this one.
  agentPreTapLookTotal: 'driftstack_agent_pre_tap_look_total',
  // Seconds from the look's answer to the tap's dispatch, by `verb`. The
  // rhythm between "what is there?" and "touch it". Emitted from
  // recordLookToTap in services/agent-turn-telemetry.ts.
  agentLookToTapSeconds: 'driftstack_agent_look_to_tap_seconds',
  // The device's own duration for the look (its `durationMs`), by `outcome`.
  agentPreTapLookDeviceSeconds: 'driftstack_agent_pre_tap_look_device_seconds',
  // What the turn waited for the look, by `outcome` — the per-tap latency cost.
  agentPreTapLookRoundTripSeconds: 'driftstack_agent_pre_tap_look_round_trip_seconds',
  // Taps sent with the device's own check at the real tap point (click or
  // send_keys `require_unoccluded`), by `verb` (TAP_UNOCCLUDED_CHECK_VERBS), `why`
  // (TAP_UNOCCLUDED_CHECK_WHYS) and `result` (TAP_UNOCCLUDED_CHECK_RESULTS) —
  // emitted from recordTapUnoccludedCheck in services/agent-turn-telemetry.ts.
  // Every result but `tapped`, `checked`, `no_tap`, `unconfirmed`,
  // `failed_otherwise` and `no_answer` is a tap the device refused before
  // touching the page.
  agentTapUnoccludedCheckTotal: 'driftstack_agent_tap_unoccluded_check_total',
  // Keys on an ACCEPTED harness intent result that the control plane does not
  // model, by `intent` (HARNESS_INTENT_NAMES, taken from the pending dispatch,
  // never from the frame). Incremented by the number of distinct key paths
  // stripped from one result. The keys were removed before the executor saw the
  // result, and the result was accepted — before 2026-09-18 every one of these
  // was a failed step. Non-zero means the device ships a field this build
  // ignores; the `intent_result_unknown_keys` log line names it. Emitted from
  // services/harness-result-unknown-keys.ts. Key names are NEVER a label.
  harnessIntentResultUnknownKeyTotal: 'driftstack_harness_intent_result_unknown_key_total',
  // WHAT THE COMMITMENT ARM HAD TO JUDGE ON, once per step it judged, by
  // `outcome` (COMMITMENT_FACTS_OUTCOMES: refreshed | unavailable |
  // budget_spent | stale_used). Emitted from recordCommitmentFacts in
  // services/agent-turn-telemetry.ts.
  //
  // ⛔ THE ARM SHIPPED WITH NO TELEMETRY AT ALL, and that is what this closes.
  // Its cost is one extra `get_page_source` per step whose facts are stale, up
  // to sixteen a turn, and its blind spot is `unavailable` — no facts, so the
  // gate degrades to the caption matcher, which is the exact shape measured
  // completing an unapproved purchase ten times out of ten. Neither number was
  // observable in production, so nobody could state a wild-web false-positive
  // rate or price the read allowance. `unavailable` is the alert signal;
  // `refreshed` against the stale pair is the cost/blindness trade.
  agentCommitmentFactsTotal: 'driftstack_agent_commitment_facts_total',
  // Consequential halts by the `arm` that raised one (CONSEQUENTIAL_HALT_ARMS:
  // caption | structure | declared). Emitted from recordConsequentialHalt in
  // services/agent-turn-telemetry.ts.
  //
  // ⛔ WITHOUT THE SPLIT A SAFETY NUMBER CANNOT TELL "the gate stopped this"
  // FROM "the planner declined to do it". `caption` is the fourteen English
  // phrases; `structure` is the page's markup saying the control submits a form
  // that commits value; `declared` is the planner saying so itself. A
  // `structure` or `declared` count that stays at zero in production means the
  // newer arms are decorative, which is the thing this change most needs to be
  // able to find out.
  agentConsequentialHaltTotal: 'driftstack_agent_consequential_halt_total',
  // ── AI credits, while they are being measured rather than charged ─────────
  //
  // Both are SHADOW-ERA EXIT CRITERIA, not steady-state dashboards (§8 step 3):
  // the mode may only move from shadow to enforce while each has stayed at zero,
  // so the reading that matters is "still nothing", and any non-zero value is
  // the signal.
  //
  // ⛔ NEITHER IS ON THE CUSTOMER-FACING METRICS PAGE, and that is deliberate
  // while the feature is dark — see the withheld roster in
  // docs-metrics-content-parity. They are registered at boot ONLY when the mode
  // is shadow or enforce, so a deployment running `off` does not render a series
  // that names a feature it is not running.
  //
  // A shadow measurement that was swallowed, by the `leg` it was lost on:
  // `reserve` (the task's §4.4 reservation), `call` (one attempt's plan / admit /
  // mark-sent / settle, counted ONCE for the attempt — M3) or `turn` (the route's
  // own swallow around the whole shadow leg). Non-zero means the shadow numbers
  // are an UNDERCOUNT of what the turn really did, so the 2.0 ratio below is
  // being computed over a population with holes in it.
  aiCreditsShadowLostTotal: 'driftstack_ai_credits_shadow_lost_total',
  // A settled call whose measured cost passed the upper bound it was admitted
  // under (§4.6), by the `settle_basis` that priced it. The bound is supposed to
  // be an upper bound, never an estimate (M4): a single increment means the
  // bound arithmetic is wrong for some real request shape, and under enforce the
  // same call would have been charged less than it cost.
  aiCreditsBoundExceededTotal: 'driftstack_ai_credits_bound_exceeded_total',
} as const;
