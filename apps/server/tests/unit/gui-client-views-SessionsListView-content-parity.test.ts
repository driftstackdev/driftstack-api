// W478.B — drift guard for apps/gui-client/src/views/SessionsListView.tsx.
// V-534.P sessions list view. Drift here either drops the
// limit default of 25 (UI suddenly renders an unbounded list +
// blows the layout) or breaks the fmtTime ISO fallback (a
// malformed createdAt server response renders raw ISO text
// when it should fall back gracefully to the raw string — but
// the inverse problem if the fallback breaks: NaN dates render
// 'Invalid Date' in every Created column).
//
//   • V-534.P framing pinned: 'sessions list view.' + 'Wires
//     the V-534.O useSessionsList hook to the V-534.N
//     SessionStatusBadge primitive. Renders the loading/error/
//     ready states + a refresh button. Caller passes through
//     to FleetView / SessionsHistoryView at the parent level;
//     this component just surfaces the data.'
//   • fmtTime: ISO → new Date() → Number.isNaN guard returns
//     raw iso on parse failure + d.toLocaleString() on success.
//   • limit default 25 + useSessionsList({limit}) wiring.
//   • State-machine render: one loading authority drives the
//     skeleton + Refresh disabled/aria-busy/label state; error
//     'Could not load sessions: ${message}' role
//     alert + ready empty <EmptyState title='No sessions yet'> (W462 shared primitive) + ready non-empty
//     <table> with Id/URL/Status/Created columns.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/SessionsListView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W478.B apps/gui-client/src/views/SessionsListView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.P framing pinned: 'V-534.P — sessions list view.' + 'Wires the V-534.O useSessionsList hook to the V-534.N SessionStatusBadge primitive. Renders the loading/error/ready states + a refresh button. Caller passes through to FleetView / SessionsHistoryView at the parent level; this component just surfaces the data.'", () => {
    expect(body).toMatch(/\/\/ V-534\.P — sessions list view\./);
    expect(body).toMatch(
      /\/\/ Wires the V-534\.O useSessionsList hook to the V-534\.N\s*\/\/ SessionStatusBadge primitive\. Renders the loading\/error\/ready\s*\/\/ states \+ a refresh button\. Caller passes through to FleetView \/\s*\/\/ SessionsHistoryView at the parent level; this component just\s*\/\/ surfaces the data\./,
    );
  });

  it("fmtTime ISO fallback: new Date(iso).getTime() Number.isNaN guard returns raw iso on parse failure + d.toLocaleString() on success — pinned so a malformed createdAt server response renders the raw string rather than 'Invalid Date' in every Created column", () => {
    expect(body).toMatch(
      /function fmtTime\(iso: string\): string \{\s*const d = new Date\(iso\);\s*if \(Number\.isNaN\(d\.getTime\(\)\)\) return iso;\s*return d\.toLocaleString\(\);\s*\}/,
    );
  });

  it('limit default 25 + useSessionsList({limit}) wiring + one loading authority drives the refresh lifecycle; section aria-labelledby + h2 id sessions-list-heading', () => {
    expect(body).toMatch(/const limit = props\.limit \?\? 25;/);
    expect(body).toMatch(/const \{ state, refetch \} = useSessionsList\(\{ limit \}\);/);
    expect(body).toMatch(/const loading = state\.kind === 'loading';/);
    expect(body).toMatch(
      /<section className="space-y-4 p-4" aria-labelledby="sessions-list-heading">/,
    );
    expect(body).toMatch(/<h2[\s\S]*?id="sessions-list-heading"[\s\S]*?Sessions[\s\S]*?<\/h2>/);
    expect(body).toMatch(/onClick=\{\(\) => void refetch\(\)\}/);
    expect(body).toMatch(/disabled=\{loading\}\s*\n\s*aria-busy=\{loading\}/);
    expect(body).toMatch(/\{loading \? 'Refreshing…' : 'Refresh'\}/);
  });

  it("State-machine render: loading → <SkeletonRows> (W465) + error 'Could not load sessions: ${message}' role='alert' status-error tints + ready empty 'No sessions yet.' + ready non-empty <table> with Id/URL/Status/Created columns + SessionStatusBadge size='sm' + fmtTime(s.createdAt) on Created col", () => {
    // W465 — loading state upgraded from a bare <p> to the shared <SkeletonRows>.
    expect(body).toMatch(/import \{ SkeletonRows \} from '\.\.\/components\/Skeleton';/);
    expect(body).toMatch(/\{loading && <SkeletonRows rows=\{5\} label="Loading sessions" \/>\}/);
    expect(body).not.toMatch(
      /<p className="text-sm text-ink-secondary" role="status">\s*Loading sessions…/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*<div\s*role="alert"\s*className="rounded border border-status-error\/60 bg-status-error\/10 p-3 text-sm text-status-error"\s*>\s*Could not load sessions: \{state\.message\}\s*<\/div>\s*\)\}/,
    );
    // W462 — empty state now uses the shared <EmptyState> primitive (icon +
    // heading + description) instead of a bare <p>.
    expect(body).toMatch(/import \{ EmptyState \} from '\.\.\/components\/EmptyState';/);
    expect(body).toMatch(/state\.data\.sessions\.length === 0 && \(\s*<EmptyState/);
    expect(body).toMatch(/title="No sessions yet"/);
    expect(body).toMatch(/description="Sessions you start will appear here/);
    expect(body).not.toMatch(/<p className="text-sm text-ink-secondary">No sessions yet\.<\/p>/);
    expect(body).toMatch(/<SessionStatusBadge status=\{s\.status\} size="sm" \/>/);
    expect(body).toMatch(
      /<td className="py-1 text-ink-secondary">\{fmtTime\(s\.createdAt\)\}<\/td>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
