// V-295c2 — public status snapshot writer.
//
// Reads the same data the public `/v1/status/incidents` endpoint
// surfaces and writes it as a single JSON object to R2 under
// `status/incidents-public.json`. The status-site CF Pages frontend
// falls back to the R2 URL when the live API fetch fails — keeping
// the page current even during API outages.
//
// Cadence: bootstrap calls processSnapshot() in the same 60s poller
// as the health probe. Each tick rewrites the same key (no history,
// no per-tick proliferation).
//
// Shape: matches GET /v1/status/incidents: bounded data plus exact
// total/open/outage aggregates and an explicit truncation bit. The status
// site validates the same contract for live and fallback reads.

import type { Incident } from '@driftstack/api-types';
import type { Logger } from '../lib/logger.js';
import type { R2 } from '../lib/r2.js';
import type { IncidentRow, IncidentsService } from './incidents.js';

export const STATUS_SNAPSHOT_KEY = 'status/incidents-public.json';

export interface StatusSnapshotConfig {
  /** Resolved-history window; defaults to 90 days so the same snapshot can
   *  back both the current-status and history pages. Open rows are all-time. */
  windowMs?: number;
  /** Max incidents to include; defaults to 50 (matches the public API). */
  limit?: number;
  /** Override for tests; defaults to STATUS_SNAPSHOT_KEY. */
  key?: string;
}

function publicIncident(row: IncidentRow): Incident {
  return {
    id: `inc_${row.id}`,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    affected_components: [...row.affectedComponents],
    public: row.public,
    started_at: row.startedAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export class StatusSnapshotService {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly key: string;
  private running = false;

  constructor(
    private readonly incidents: IncidentsService,
    private readonly r2: R2,
    private readonly logger: Logger,
    config: StatusSnapshotConfig = {},
  ) {
    this.windowMs = config.windowMs ?? 90 * 24 * 60 * 60 * 1000;
    this.limit = config.limit ?? 50;
    this.key = config.key ?? STATUS_SNAPSHOT_KEY;
  }

  /** Write one snapshot to R2. Idempotent — same key, full overwrite. */
  async processSnapshot(now: Date): Promise<{ count: number; bytes: number }> {
    // A slow R2 call can outlive the fixed 60s bootstrap interval. Admit only
    // one writer per service instance so an older tick cannot finish after and
    // overwrite a newer canonical snapshot. The warning makes the skipped fire
    // explicit while zero counters preserve the established result contract;
    // the next interval retries.
    if (this.running) {
      this.logger.warn(
        { component: 'status-snapshot' },
        'processSnapshot skipped — previous snapshot is still in progress',
      );
      return { count: 0, bytes: 0 };
    }
    this.running = true;
    try {
      const since = new Date(now.getTime() - this.windowMs);
      const feed = await this.incidents.publicFeed({
        since,
        limit: this.limit,
      });
      const body = JSON.stringify({
        generated_at: now.toISOString(),
        data: feed.rows.map(publicIncident),
        total: feed.total,
        open_count: feed.openCount,
        open_outage_count: feed.openOutageCount,
        truncated: feed.truncated,
      });
      const buffer = Buffer.from(body, 'utf-8');
      await this.r2.putObject({
        key: this.key,
        body: buffer,
        contentType: 'application/json; charset=utf-8',
      });
      this.logger.debug?.(
        {
          component: 'status-snapshot',
          count: feed.rows.length,
          open_count: feed.openCount,
          open_outage_count: feed.openOutageCount,
          truncated: feed.truncated,
          bytes: buffer.byteLength,
        },
        'wrote status snapshot to R2',
      );
      return { count: feed.rows.length, bytes: buffer.byteLength };
    } finally {
      this.running = false;
    }
  }
}
