// V-295b — system health probe poller.
//
// Runs once per `processTick` (60s in production, driven by bootstrap
// setInterval). For each configured target the service:
//
//   1. Probes the target via the injected `Prober` (HTTP HEAD/GET).
//   2. Inserts a `system_health_probes` row recording ok / latency /
//      http_status / error_message.
//   3. Inspects the last `failureThreshold` probes for that target. If
//      ALL failed AND no open auto-incident exists for that target,
//      auto-creates an incident (severity = 'major', public = true,
//      auto_probe_target = target).
//   4. Inspects the last `recoveryThreshold` probes. If ALL succeeded
//      AND there IS an open auto-incident for that target, auto-resolves
//      it (writes a final 'resolved' update, stamps resolved_at).
//
// Dependencies are intentionally injected (no fetch / no Date.now
// calls) so tests can drive the service deterministically.
//
// This service does NOT write admin_audit_log rows — auto-actions
// have no admin actor. The probe table itself is the audit trail
// (every probe + every threshold trigger is recoverable from rows).

import type { Logger } from '../lib/logger.js';
import type { IncidentRow, IncidentsService } from './incidents.js';

/**
 * Sanitize a probe error for a PUBLIC incident description (V-295b hardening).
 *
 * A probe's `errorMessage` is either a benign `HTTP <status>` (the probe's own
 * result — safe to surface on the public status page) or a raw network-layer
 * error from `fetch`, which can embed internal infrastructure detail
 * (`connect ECONNREFUSED 10.0.0.5:8443`, `getaddrinfo ENOTFOUND internal-host`).
 * Only the `HTTP <status>` shape is echoed publicly; any other error collapses
 * to a generic phrase so a network failure can never disclose an internal
 * IP/host on a `public: true` incident. The raw error is still retained
 * verbatim in `system_health_probes.errorMessage` for internal/admin diagnosis.
 */
export function sanitizePublicProbeError(errorMessage: string | null): string {
  if (errorMessage !== null && /^HTTP \d{3}$/.test(errorMessage)) {
    return errorMessage;
  }
  return 'a connectivity error';
}

export interface ProbeRecordRow {
  id: string;
  target: string;
  probedAt: Date;
  ok: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
}

export interface Prober {
  probe(target: HealthProbeTarget): Promise<ProbeResult>;
}

export interface HealthProbeTarget {
  /** Stable slug stored in `system_health_probes.target` and
   *  `incidents.auto_probe_target`. */
  id: string;
  /** Human-readable name used in auto-created incident titles. */
  label: string;
  /** Absolute URL to probe. */
  url: string;
  /** Per-probe timeout in ms; default 5_000. */
  timeoutMs?: number;
}

export interface ProbesRepo {
  recordProbe(input: {
    target: string;
    ok: boolean;
    latencyMs: number | null;
    httpStatus: number | null;
    errorMessage: string | null;
    probedAt: Date;
  }): Promise<ProbeRecordRow>;
  /** Last N probes for a target, newest first. */
  recentForTarget(target: string, n: number): Promise<ProbeRecordRow[]>;
  /** Delete probes older than `before`. Returns count pruned. */
  pruneOlderThan(before: Date): Promise<number>;
  /**
   * V-295e — counts of ok/not-ok probes per target since `since`.
   * Used by the SLA endpoint. Returns one row per target that has
   * at least one probe in the window.
   */
  countByTargetSince(since: Date): Promise<
    {
      target: string;
      okCount: number;
      failCount: number;
      lastProbeAt: Date;
      lastFailureAt: Date | null;
    }[]
  >;
}

export interface HealthProbeServiceConfig {
  /** Targets to probe each tick. */
  targets: readonly HealthProbeTarget[];
  /** Number of consecutive failures before auto-create. Default 3. */
  failureThreshold?: number;
  /** Number of consecutive successes before auto-resolve. Default 3. */
  recoveryThreshold?: number;
  /** Probe history retention. Default 30 days. */
  retentionMs?: number;
}

export class HealthProbeService {
  private readonly failureThreshold: number;
  private readonly recoveryThreshold: number;
  private readonly retentionMs: number;
  private lastPruneAt: Date | null = null;
  // Re-entrancy guard for processTick (see its doc comment).
  private ticking = false;

  constructor(
    private readonly probes: ProbesRepo,
    private readonly incidents: IncidentsService,
    private readonly prober: Prober,
    private readonly logger: Logger,
    private readonly config: HealthProbeServiceConfig,
  ) {
    this.failureThreshold = config.failureThreshold ?? 3;
    this.recoveryThreshold = config.recoveryThreshold ?? 3;
    this.retentionMs = config.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  /** One full tick across all configured targets. Re-entrancy-guarded: the
   *  bootstrap poller is a naive `setInterval` that does NOT await the prior
   *  tick, so a tick slower than the interval would overlap the next fire.
   *  Overlap would double the probe load AND double-create incidents (the
   *  findOpen→create threshold path has no DB uniqueness guard). Skip the
   *  overlapping fire (`skipped: true`) — strictly safer than racing; the next
   *  interval re-probes. */
  async processTick(now: Date): Promise<{
    probed: number;
    autoCreated: number;
    autoResolved: number;
    /** True when this fire was skipped because a prior tick was still running. */
    skipped?: boolean;
  }> {
    if (this.ticking) {
      this.logger.warn(
        { component: 'health-probe' },
        'processTick skipped — previous tick still in progress (>interval)',
      );
      return { probed: 0, autoCreated: 0, autoResolved: 0, skipped: true };
    }
    this.ticking = true;
    try {
      return await this.runTick(now);
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(now: Date): Promise<{
    probed: number;
    autoCreated: number;
    autoResolved: number;
  }> {
    let autoCreated = 0;
    let autoResolved = 0;

    await Promise.all(
      this.config.targets.map(async (target) => {
        try {
          const result = await this.prober.probe(target);
          await this.probes.recordProbe({
            target: target.id,
            ok: result.ok,
            latencyMs: result.latencyMs,
            httpStatus: result.httpStatus,
            errorMessage: result.errorMessage,
            probedAt: now,
          });
          const action = await this.evaluateThresholds(target, now);
          if (action === 'created') autoCreated += 1;
          if (action === 'resolved') autoResolved += 1;
        } catch (err) {
          // The probe + record path itself failed (DB outage, etc).
          // Log warn — we will retry next tick. Do NOT throw, or the
          // bootstrap interval treats it as a poller-loop error.
          this.logger.warn(
            {
              component: 'health-probe',
              target: target.id,
              err:
                err instanceof Error
                  ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                  : { value: err },
            },
            'health probe tick failed for target',
          );
        }
      }),
    );

    // Hourly prune to keep table small. Only prunes if last prune was
    // more than an hour ago — cheap idempotent op.
    if (!this.lastPruneAt || now.getTime() - this.lastPruneAt.getTime() > 60 * 60 * 1000) {
      try {
        const before = new Date(now.getTime() - this.retentionMs);
        const pruned = await this.probes.pruneOlderThan(before);
        if (pruned > 0) {
          this.logger.info({ component: 'health-probe', pruned }, 'pruned old probe rows');
        }
        this.lastPruneAt = now;
      } catch (err) {
        this.logger.warn(
          {
            component: 'health-probe',
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'probe prune failed (will retry next hour)',
        );
      }
    }

    return { probed: this.config.targets.length, autoCreated, autoResolved };
  }

  private async evaluateThresholds(
    target: HealthProbeTarget,
    now: Date,
  ): Promise<'created' | 'resolved' | 'noop'> {
    const window = Math.max(this.failureThreshold, this.recoveryThreshold);
    const recent = await this.probes.recentForTarget(target.id, window);
    const open = await this.incidents.findOpenAutoIncident(target.id);

    // Auto-create: last `failureThreshold` probes all failed AND no
    // open auto-incident exists.
    if (
      !open &&
      recent.length >= this.failureThreshold &&
      recent.slice(0, this.failureThreshold).every((p) => !p.ok)
    ) {
      const lastErr = recent[0]?.errorMessage ?? null;
      // This description is published verbatim on the unauthenticated status
      // site. Never interpolate `target.url`: an operator may legitimately
      // point a probe at an internal failover origin or a URL carrying
      // deployment-specific path/query detail. The stable title/component id
      // identifies the affected surface; the private probe row retains the
      // exact target id and raw diagnostic for operators.
      const created = await this.incidents.create({
        title: `${target.label} health check failing`,
        description: `Auto-detected: ${this.failureThreshold} consecutive health checks failed. Latest error: ${sanitizePublicProbeError(lastErr)}.`,
        severity: 'major',
        affectedComponents: [target.id],
        public: true,
        startedAt: now,
        createdByAdminId: null,
        createdByAdminKeyId: null,
        autoProbeTarget: target.id,
      });
      this.logger.warn(
        {
          component: 'health-probe',
          target: target.id,
          incidentId: created.incident.id,
          consecutiveFailures: this.failureThreshold,
        },
        'auto-created incident on health probe failure threshold',
      );
      return 'created';
    }

    // Auto-resolve: last `recoveryThreshold` probes all succeeded AND
    // an open auto-incident exists.
    if (
      open &&
      recent.length >= this.recoveryThreshold &&
      recent.slice(0, this.recoveryThreshold).every((p) => p.ok)
    ) {
      await this.resolveOpen(open);
      this.logger.info(
        {
          component: 'health-probe',
          target: target.id,
          incidentId: open.id,
          consecutiveSuccesses: this.recoveryThreshold,
        },
        'auto-resolved incident on health probe recovery threshold',
      );
      return 'resolved';
    }

    return 'noop';
  }

  private async resolveOpen(open: IncidentRow): Promise<void> {
    await this.incidents.resolve({
      incidentId: open.id,
      message: `Auto-resolved: ${this.recoveryThreshold} consecutive successful probes. Service recovered.`,
      postedByAdminId: null,
      postedByAdminKeyId: null,
    });
  }
}

// ── Default Prober: native fetch with timeout ──────────────────────────
//
// In production, bootstrap wires this. Tests use a fake.

export class FetchProber implements Prober {
  async probe(target: HealthProbeTarget): Promise<ProbeResult> {
    const timeoutMs = target.timeoutMs ?? 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(target.url, {
        method: 'GET',
        signal: controller.signal,
        // No Authorization header — /health is public by design.
        headers: { accept: 'application/json' },
      });
      const latencyMs = Date.now() - start;
      const ok = res.ok;
      // Probe decisions use headers only. Dispose the body before clearing the
      // timeout so a target cannot retain one stream per poll by returning
      // headers and then never completing its response. Cleanup failure does
      // not change the observed HTTP status.
      await res.body?.cancel().catch(() => undefined);
      return {
        ok,
        latencyMs,
        httpStatus: res.status,
        errorMessage: ok ? null : `HTTP ${res.status}`,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs,
        httpStatus: null,
        errorMessage: message.slice(0, 500),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
