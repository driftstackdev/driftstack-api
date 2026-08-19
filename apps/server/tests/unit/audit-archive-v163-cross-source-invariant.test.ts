// W932 — V-163 AuditArchiveService cross-source invariant.
// Two-hundred-fifty-eighth in the drift-guard series. Pins the
// audit-archive sweep service per ADR-006:
//
//   V-163 anchor — 'AuditArchiveService per ADR-006'.
//
//   Sweep semantics — 'rows older than 90 days from FIVE Postgres
//   tables into Cloudflare R2 as gzip-compressed JSON Lines,
//   partitioned by YYYY/MM/. After successful upload + checksum,
//   DELETEs the archived rows. Records each sweep in
//   audit_archive_runs'.
//
//   HOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000 (= 90 days).
//
//   DEFAULT_BATCH_SIZE = 10_000, declared without a reader. This
//   header used to repeat the constant's own claim that it "keeps
//   memory bounded on large windows"; no code path reads it, so the
//   arm below pins the value and the absence together.
//
//   AUDIT_TABLES (5-entry tuple; this header said 4 until 2026-08-17,
//   two waves after W438 added the fifth):
//     - admin_audit_log         (timestamp column).
//     - processed_stripe_events (received_at column).
//     - legal_acceptances       (accepted_at column).
//     - webhook_deliveries      (created_at column).
//     - session_events          (created_at column).
//
//   R2 object key shape per ADR-006 §2:
//     <prefix>/<table_name>/YYYY/MM/<table_name>_YYYY-MM.jsonl.gz.
//
//   Default r2Prefix = 'audit-archive'.
//
//   Failure modes (3 per ADR §3):
//     - R2 upload fails → DELETE skipped; ledger row records
//       deletedFromPostgres=false. Next run retries.
//     - DELETE fails → R2 file remains, ledger row records the
//       upload; next run notices existing R2 key + overwrites
//       idempotently.
//     - Partial archive → archive query union may double-count
//       until cleanup completes. Acceptable for monthly cadence.
//
//   Cron cadence — 'External scheduler invokes archiveAll(now) on
//   the 1st of each month at 02:00 UTC. The service does NOT manage
//   scheduling'.
//
//   rowsToJsonl(rows) — empty input returns '' (no trailing newline).
//
//   sha256Checksum — sha256 hex of compressed gzip bytes.
//
// stays in lockstep across apps/server/src/services/audit-archive.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOT_RETENTION_MS,
  DEFAULT_BATCH_SIZE,
  AUDIT_TABLES,
  archiveObjectKey,
  rowsToJsonl,
} from '../../src/services/audit-archive.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W932 V-163 audit-archive cross-source invariant', () => {
  // ─── V-163 anchor + ADR-006 reference ────────────────────────

  it("CRITICAL apps/server/src/services/audit-archive.ts header pins V-163 anchor — 'V-163 — AuditArchiveService per ADR-006'. The V-163 + ADR-006 chain is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/V-163 — AuditArchiveService per ADR-006/);
  });

  // ─── Sweep semantics framing ─────────────────────────────────

  it("CRITICAL sweep framing — 'Sweeps rows older than 90 days from five Postgres tables — the four audit-shaped (admin_audit_log / processed_stripe_events / legal_acceptances / webhook_deliveries) plus session_events — into Cloudflare R2 as gzip-compressed JSON Lines, partitioned by YYYY/MM/. After successful upload + checksum, DELETEs the archived rows. Records each sweep in audit_archive_runs'. The gzip-JSONL + ledger contract is the V-163 central design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/Sweeps rows older than 90 days from five Postgres tables — the four/);
    expect(p).toMatch(/audit-shaped \(admin_audit_log \/ processed_stripe_events \//);
    expect(p).toMatch(
      /\/ webhook_deliveries\) plus the high-volume\s*\n?\s*\/\/ session_events action log/,
    );
    expect(p).toMatch(/Lines, partitioned by YYYY\/MM\/\. After successful upload/);
    expect(p).toMatch(
      /DELETEs the archived rows\. Records each sweep in\s*\n?\s*\/\/\s*audit_archive_runs/,
    );
  });

  // ─── HOT_RETENTION_MS = 90 days ──────────────────────────────

  it('CRITICAL HOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000 (= 7_776_000_000 ms = 90 days). The 90-day hot retention is the ADR-006 boundary; drift would change R2 archive coverage.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/90 days in milliseconds — the hot-retention threshold/);
    expect(p).toMatch(/export const HOT_RETENTION_MS = 90 \* 24 \* 60 \* 60 \* 1000;/);
    expect(HOT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(HOT_RETENTION_MS).toBe(7_776_000_000);
  });

  // ─── DEFAULT_BATCH_SIZE = 10_000 ─────────────────────────────

  it('CRITICAL DEFAULT_BATCH_SIZE = 10_000, and it is DECLARED WITHOUT A READER. This pin used to assert the sentence "keeps memory bounded on large windows" and this description used to call it "the memory ceiling per sweep tick". Neither was true: archiveTable reads every archivable row with no bound and holds the result set, a projected copy, a JSONL string and a gzip buffer. Two pins froze a claim the code never made — so the pin now records the value AND the fact that nothing reads it.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/DECLARED WITHOUT A READER/);
    expect(p).toMatch(/export const DEFAULT_BATCH_SIZE = 10_000;/);
    expect(DEFAULT_BATCH_SIZE).toBe(10_000);
  });

  it('CRITICAL the batch size has a reader, or it says it has none. Two states are honest — a constant with a reader, or a constant that admits it has none. The state to fail is the third: no reader and no notice, which is what shipped and what two pins then froze in place. Wiring it must therefore delete the notice, and deleting the notice must wire it.', () => {
    const src = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    // References OUTSIDE the declaration itself and outside its doc comment.
    const readers = src
      .split('\n')
      .filter((l) => l.includes('DEFAULT_BATCH_SIZE'))
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .filter((l) => !/export const DEFAULT_BATCH_SIZE/.test(l));
    const admitsNoReader = /DECLARED WITHOUT A READER/.test(src);
    // EXCLUSIVE, not `||`. The first version of this arm was an OR, which the
    // description above already contradicted — it says wiring the constant must
    // delete the notice. An OR passes the state where a reader exists AND the
    // notice still claims there is none, which is the stale comment this whole
    // change is about, and the mutation that added a reader duly SURVIVED.
    expect(
      readers.length > 0 !== admitsNoReader,
      readers.length > 0
        ? 'DEFAULT_BATCH_SIZE now has a reader, so remove the DECLARED WITHOUT A READER notice and say what it bounds'
        : 'DEFAULT_BATCH_SIZE has no reader and no notice — that is a memory bound that exists only in a comment',
    ).toBe(true);
  });

  // ─── AUDIT_TABLES 5-entry tuple ──────────────────────────────

  it('CRITICAL AUDIT_TABLES is 5-entry as-const tuple — admin_audit_log/timestamp + processed_stripe_events/received_at + legal_acceptances/accepted_at + webhook_deliveries/created_at + session_events/created_at (W438). The table set + timestamp-column-name pairs are what window queries gate on.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/export const AUDIT_TABLES = \[/);
    expect(p).toMatch(/\{ tableName: 'admin_audit_log', timestampColumn: 'timestamp' \},/);
    expect(p).toMatch(
      /\{ tableName: 'processed_stripe_events', timestampColumn: 'received_at' \},/,
    );
    expect(p).toMatch(/\{ tableName: 'legal_acceptances', timestampColumn: 'accepted_at' \},/);
    expect(p).toMatch(/\{ tableName: 'webhook_deliveries', timestampColumn: 'created_at' \},/);
    expect(p).toMatch(/\{ tableName: 'session_events', timestampColumn: 'created_at' \},/);
    expect(p).toMatch(/\] as const;/);
    expect(AUDIT_TABLES).toHaveLength(5);
    expect(AUDIT_TABLES.map((t) => t.tableName)).toEqual([
      'admin_audit_log',
      'processed_stripe_events',
      'legal_acceptances',
      'webhook_deliveries',
      'session_events',
    ]);
  });

  // ─── 3-failure-mode framing per ADR §3 ───────────────────────

  it('CRITICAL 3 failure modes per ADR §3 — (1) R2 upload fails → DELETE skipped; ledger row records deletedFromPostgres=false. Next run retries. (2) DELETE fails → R2 file remains, ledger row records the upload; next run notices the existing R2 key and overwrites idempotently. (3) Partial archive → both queries still work; archive query union may double-count until cleanup completes. Acceptable edge case for monthly cadence. The 3-mode taxonomy is the failure-handling contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/Failure modes \(per ADR §3\):/);
    expect(p).toMatch(/- R2 upload fails → DELETE skipped; ledger row records the/);
    expect(p).toMatch(/attempt with deletedFromPostgres=false\. Next run retries\./);
    expect(p).toMatch(/- DELETE fails → R2 file remains, ledger row records the upload;/);
    expect(p).toMatch(/next run notices the existing R2 key and overwrites idempotently\./);
    expect(p).toMatch(/- Partial archive → both queries still work; archive query/);
    expect(p).toMatch(/union may double-count until cleanup completes\. Acceptable/);
    expect(p).toMatch(/edge case for monthly cadence\./);
  });

  // ─── Cron cadence framing ────────────────────────────────────

  it("V-1006 CRITICAL cron cadence framed as ADR-006's DESIGN, not as something that happens. This arm used to pin 'Cron / external scheduler invokes archiveAll(now) on the 1st of each month at 02:00 UTC' — present tense, and false on every clause: nothing constructs the service, archiveAll() takes no arguments so archiveAll(now) never described a real call, and audit_archive_runs has zero rows. The stateless-about-time property it was really protecting is kept, and pinned, on its own.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(
      /ADR-006 designs a\s*\n?\s*\/\/ monthly cron to call this on the 1st at 02:00 UTC/,
    );
    // The retracted wording, paraphrased in the negative so it cannot return.
    expect(p).not.toMatch(/Cron \/ external scheduler invokes archiveAll/);
    // What the old arm was actually defending: the service takes its clock from
    // the constructor and schedules nothing itself.
    expect(p).toMatch(/it does not\s*\n?\s*\/\/ manage scheduling/);
  });

  // ─── archiveObjectKey ADR-006 §2 shape ───────────────────────

  it("CRITICAL archiveObjectKey JSDoc pins ADR-006 §2 shape — '<prefix>/<table_name>/YYYY/MM/<table_name>_YYYY-MM.jsonl.gz'. The stable-key shape is the R2 partition contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/Compose the R2 object key for a given table \+ window\. Stable shape/);
    expect(p).toMatch(/per ADR-006 §2:/);
    expect(p).toMatch(/<prefix>\/<table_name>\/YYYY\/MM\/<table_name>_YYYY-MM\.jsonl\.gz/);
  });

  it('CRITICAL archiveObjectKey runtime — prefix + table + YYYY/MM partitioning + table_YYYY-MM.jsonl.gz filename. Verified with 2026-05.', () => {
    const key = archiveObjectKey(
      'audit-archive',
      'admin_audit_log',
      new Date('2026-05-15T00:00:00Z'),
    );
    expect(key).toBe('audit-archive/admin_audit_log/2026/05/admin_audit_log_2026-05.jsonl.gz');
  });

  it('CRITICAL archiveObjectKey zero-pads month — January = 01 not 1; December = 12. The 2-digit padStart prevents the alphabetical sort breaking month order.', () => {
    const jan = archiveObjectKey('p', 'admin_audit_log', new Date('2026-01-15T00:00:00Z'));
    expect(jan).toContain('/2026/01/');
    const dec = archiveObjectKey('p', 'admin_audit_log', new Date('2026-12-15T00:00:00Z'));
    expect(dec).toContain('/2026/12/');
  });

  it('CRITICAL archiveObjectKey uses UTC — getUTCFullYear + getUTCMonth. Drift to local-time would let timezone-offset push month boundaries the wrong direction.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/const yyyy = windowStart\.getUTCFullYear\(\)\.toString\(\);/);
    expect(p).toMatch(
      /const mm = \(windowStart\.getUTCMonth\(\) \+ 1\)\.toString\(\)\.padStart\(2, '0'\);/,
    );
  });

  // ─── rowsToJsonl runtime ─────────────────────────────────────

  it("CRITICAL rowsToJsonl JSDoc — 'Serialise a batch of rows to newline-delimited JSON. Empty input returns an empty string (no trailing newline)'. The no-trailing-newline contract matches JSONL spec.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/Serialise a batch of rows to newline-delimited JSON\. Empty input/);
    expect(p).toMatch(/returns an empty string \(no trailing newline\)/);
  });

  it('CRITICAL rowsToJsonl runtime — N rows → N JSON.stringify joined by \\n. No trailing newline. Empty array → empty string.', () => {
    expect(rowsToJsonl([])).toBe('');
    expect(rowsToJsonl([{ a: 1 }])).toBe('{"a":1}');
    expect(rowsToJsonl([{ a: 1 }, { b: 2 }, { c: 3 }])).toBe('{"a":1}\n{"b":2}\n{"c":3}');
    // No trailing newline:
    expect(rowsToJsonl([{ a: 1 }, { b: 2 }]).endsWith('\n')).toBe(false);
  });

  // ─── selectArchivableRows stable order framing ───────────────

  it("CRITICAL selectArchivableRows JSDoc — 'Returns rows in stable order (timestamp asc, id asc) so the JSONL output is deterministic for a given window'. The stable-order contract is what makes the sha256 checksum reproducible.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(/Returns rows in stable order \(timestamp asc, id asc\) so the/);
    expect(p).toMatch(/JSONL output is deterministic for a given window/);
  });

  // ─── sha256Checksum + gzip framing ───────────────────────────

  it('CRITICAL sha256Checksum computed from compressed gzip bytes — createHash("sha256").update(compressed).digest("hex"). The checksum-of-compressed (not pre-compression) is what lets ledger entries verify R2 bytes exactly.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'));
    expect(p).toMatch(
      /const sha256Checksum = createHash\('sha256'\)\.update\(compressed\)\.digest\('hex'\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/audit-archive-v163-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
