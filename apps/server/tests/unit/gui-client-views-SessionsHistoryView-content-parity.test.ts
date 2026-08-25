// W483.A — drift guard for apps/gui-client/src/views/SessionsHistoryView.tsx.
// V-334 sessions history view. Drift here either drops the
// status === 'destroyed' || 'errored' filter (active sessions
// leak into history view — founder confused about why a
// 'ready' session is in the post-mortem list) or breaks the
// destroyed-at newest-first sort (oldest terminations first
// instead of newest — debugging recent failures becomes a
// scroll-to-end exercise).
//
//   • V-334 framing pinned: 'Sessions history view. Shows
//     TERMINATED sessions (destroyed + errored) with their
//     lifetime + reason.' + 'Mirrors the SessionsView state-
//     machine (poll-on-mount, refresh button) but scoped to
//     terminal-state sessions only.' + 'Useful for the founder
//     running locally to verify session lifecycle + spot
//     patterns in failures (which archetype keeps erroring,
//     which durations are abnormal). Active sessions live in
//     SessionsView; this is the post-mortem complement.'
//   • HistoryState 4-field (sessions + refreshedAt nullable +
//     loading + error nullable).
//   • Status filter: status === 'destroyed' || status ===
//     'errored'.
//   • Newest-first sort by destroyed_at via getTime() with
//     null-coalesce to 0.
//   • Shared humanizeError with fixed actionable fallback.
//   • !client early return → 'Configure API access' empty
//     state.
//   • errored status pill in status-error/20 tint else
//     surface-elevated.
//   • fmtDuration piecewise: <1000 → 'ms', <60_000 → 's' (1 dp
//     via Math.round/10), <3_600_000 → 'm' (1 dp), else 'h' (1
//     dp).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/SessionsHistoryView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W483.A apps/gui-client/src/views/SessionsHistoryView.tsx content parity', () => {
  const body = read(LIB);

  it("V-334 framing pinned: 'V-334 — Sessions history view. Shows TERMINATED sessions (destroyed + errored) with their lifetime + reason. Mirrors the SessionsView state-machine (poll-on-mount, refresh button) but scoped to terminal-state sessions only.' + 'Active sessions live in SessionsView; this is the post-mortem complement.'", () => {
    expect(body).toMatch(
      /\/\/ V-334 — Sessions history view\. Shows TERMINATED sessions\s*\/\/ \(destroyed \+ errored\) with their lifetime \+ status\. Mirrors the\s*\/\/ SessionsView state-machine \(poll-on-mount, refresh button\) but\s*\/\/ scoped to terminal-state sessions only\./,
    );
    expect(body).toMatch(
      /\/\/ Useful for the founder running locally to verify session lifecycle\s*\/\/ \+ spot patterns in failures \(which archetype keeps erroring,\s*\/\/ which durations are abnormal\)\. Active sessions live in\s*\/\/ SessionsView; this is the post-mortem complement\./,
    );
  });

  it('HistoryState 4-field (sessions: Session[] + refreshedAt: number | null + loading: boolean + error: string | null) — pinned shape so a refactor that adds new state fields without considering the existing branches breaks here first', () => {
    expect(body).toMatch(
      /interface HistoryState \{\s*sessions: Session\[\];\s*refreshedAt: number \| null;\s*loading: boolean;\s*error: string \| null;\s*\}/,
    );
  });

  it("Terminal-only filter: page.data.filter(s.status === 'destroyed' || s.status === 'errored') — pinned so active sessions don't leak into post-mortem view; newest-first sort by endedAtMs (destroyed_at ?? last_state_at ?? created_at) so reasonless errors interleave by when they actually ended instead of sinking to the bottom at time 0", () => {
    expect(body).toMatch(
      /const terminated = page\.data\.filter\(\s*\(s\) => s\.status === 'destroyed' \|\| s\.status === 'errored',\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Newest first\. Errored sessions often have no destroyed_at \(the\s*\/\/ box never ran a clean teardown\), so falling back to last_state_at\s*\/\/ then created_at keeps them interleaved by when they actually ended\s*\/\/ instead of dumping every reasonless error at the bottom \(time 0\)\.\s*terminated\.sort\(\(a, b\) => endedAtMs\(b\) - endedAtMs\(a\)\);/,
    );
    // The endedAtMs helper drives that most-reliable-timestamp-first sort.
    expect(body).toMatch(
      /function endedAtMs\(s: Session\): number \{\s*const iso = s\.destroyed_at \?\? s\.last_state_at \?\? s\.created_at;\s*const ms = new Date\(iso\)\.getTime\(\);\s*return Number\.isNaN\(ms\) \? 0 : ms;\s*\}/,
    );
  });

  it('history failures use the shared safe humanizer with fixed actionable copy', () => {
    expect(body).toMatch(/import \{ humanizeError \} from '\.\.\/lib\/humanize-error';/);
    expect(body).toMatch(
      /const message = humanizeError\(err, "Couldn't load session history\. Try again\."\);/,
    );
    const bypassMutation = body.replace('humanizeError(err,', 'String(err) || (');
    expect(bypassMutation).not.toMatch(/humanizeError\(err,/);
  });

  it("!client early-return: 'Configure API access' section-label + 'Set up your API key in Settings to view session history.' subline — pinned so the unauthenticated user sees a useful direction instead of an empty list", () => {
    expect(body).toMatch(
      /if \(!client\) \{\s*return \(\s*<div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">\s*<span className="section-label">Configure API access<\/span>\s*<p className="max-w-md text-sm text-ink-secondary">\s*Set up your API key in Settings to view session history\.\s*<\/p>/,
    );
  });

  it('Render: history framing + retryable ErrorBanner + shared empty state', () => {
    expect(body).toMatch(/<h2[\s\S]*?Past sessions[\s\S]*?<\/h2>/);
    expect(body).toMatch(
      /Ended sessions \(destroyed or errored\) with their lifetime and final status\. Active\s*sessions live under "Active" in the sidebar\./,
    );
    expect(body).toMatch(
      /\{state\.error !== null && \(\s*<ErrorBanner\s*message=\{state\.error\}\s*onRetry=\{\(\) => void refresh\(\)\}\s*retrying=\{state\.loading\}\s*onDismiss=\{\(\) => setState\(\(s\) => \(\{ \.\.\.s, error: null \}\)\)\}/,
    );
    // W463 — empty state upgraded to the shared <EmptyState> primitive.
    expect(body).toMatch(/import \{ EmptyState \} from '\.\.\/components\/EmptyState';/);
    // Empty state shows only when there is genuinely nothing AND we are not
    // mid first-load (skeleton owns that window) — gated on hasSessions/showSkeleton.
    expect(body).toMatch(
      /!hasSessions && !showSkeleton && state\.error === null && \(\s*<EmptyState/,
    );
    expect(body).toMatch(/title="No past sessions yet"/);
    expect(body).toMatch(
      /description="Sessions that have ended — destroyed or errored — show up here\."/,
    );
    expect(body).not.toMatch(
      /No terminated sessions yet\. They show up here once destroyed or errored\./,
    );
  });

  it("Per-row: id mono + archetype + fmtDuration(created_at, endedIso) + shared <RelativeTime iso={endedIso} tooltipPrefix={destroyed_at ? 'Ended' : 'Last state (errored)'}> (null → '—'), where endedIso = destroyed_at ?? last_state_at (errored sessions lack a clean-teardown destroyed_at); errored rows also show a 'Reason not reported by the harness' italic line; status rendered via the shared <SessionStatusBadge> (replacing the ad-hoc status-error/20 span pill)", () => {
    // endedIso falls back to last_state_at so an errored (no destroyed_at)
    // row still shows *when* it ended rather than a bare em dash.
    expect(body).toMatch(/const endedIso = s\.destroyed_at \?\? s\.last_state_at;/);
    expect(body).toMatch(
      /\{s\.archetype\} · \{fmtDuration\(s\.created_at, endedIso\)\} ·\{' '\}\s*\{endedIso \? \(\s*<RelativeTime\s*iso=\{endedIso\}\s*tooltipPrefix=\{s\.destroyed_at \? 'Ended' : 'Last state \(errored\)'\}\s*\/>\s*\) : \(\s*'—'\s*\)\}/,
    );
    // Errored sessions surface a plain-language "no reason" note.
    expect(body).toMatch(
      /\{s\.status === 'errored' && \(\s*<p className="mt-0\.5 text-2xs text-ink-muted italic">\s*Reason not reported by the harness\s*<\/p>\s*\)\}/,
    );
    // The status pill is now the shared SessionStatusBadge component.
    expect(body).toMatch(
      /import \{ SessionStatusBadge \} from '\.\.\/components\/SessionStatusBadge';/,
    );
    expect(body).toMatch(/<SessionStatusBadge status=\{s\.status\} size="sm" \/>/);
    // The old ad-hoc status-error/20 span pill is gone.
    expect(body).not.toMatch(/bg-status-error\/20 text-status-error/);
  });

  it("fmtDuration piecewise: !destroyedIso → '—' / ms < 0 → '—' (negative-time guard for clock skew) / <1000 → `${ms}ms` (raw) / <60_000 → `${Math.round(ms/100)/10}s` (1 decimal) / <3_600_000 → `${Math.round(ms/6_000)/10}m` (1 decimal) / else `${Math.round(ms/360_000)/10}h` (1 decimal)", () => {
    expect(body).toMatch(
      /function fmtDuration\(createdIso: string, destroyedIso: string \| null\): string \{\s*if \(!destroyedIso\) return '—';\s*const ms = new Date\(destroyedIso\)\.getTime\(\) - new Date\(createdIso\)\.getTime\(\);\s*if \(ms < 0\) return '—';\s*if \(ms < 1000\) return `\$\{ms\}ms`;\s*if \(ms < 60_000\) return `\$\{Math\.round\(ms \/ 100\) \/ 10\}s`;\s*if \(ms < 3_600_000\) return `\$\{Math\.round\(ms \/ 6_000\) \/ 10\}m`;\s*return `\$\{Math\.round\(ms \/ 360_000\) \/ 10\}h`;\s*\}/,
    );
  });

  it("Polish parity with sibling SessionsView: SkeletonRows first-load state (showSkeleton = loading && !hasSessions), a 'Refreshed <formatTime>' indicator surfacing the previously-dead refreshedAt state, and a header count next to the title", () => {
    expect(body).toMatch(/import \{ SkeletonRows \} from '\.\.\/components\/Skeleton';/);
    expect(body).toMatch(/const hasSessions = state\.sessions\.length > 0;/);
    expect(body).toMatch(/const showSkeleton = state\.loading && !hasSessions;/);
    expect(body).toMatch(
      /\{showSkeleton && <SkeletonRows rows=\{5\} label="Loading session history…" \/>\}/,
    );
    // refreshedAt was tracked in state but never rendered before this slice.
    expect(body).toMatch(
      /\{state\.refreshedAt !== null && \(\s*<p className="mt-1 text-2xs text-ink-muted">\s*Refreshed <span className="mono">\{formatTime\(state\.refreshedAt\)\}<\/span>/,
    );
    // Header count next to the title (only when there are sessions).
    expect(body).toMatch(
      /\{hasSessions && \(\s*<span className="text-sm font-normal text-ink-muted">\{state\.sessions\.length\}<\/span>\s*\)\}/,
    );
  });

  it('Relative time uses the shared RelativeTime component (Intl.RelativeTimeFormat + semantic <time> + absolute-time tooltip) rather than an ad-hoc local formatter — keeps "X ago" rendering consistent across views', () => {
    expect(body).toMatch(/import \{ RelativeTime \} from '\.\.\/components\/RelativeTime';/);
    // The ad-hoc fmtWhen helper was removed in favour of the shared component.
    expect(body).not.toMatch(/function fmtWhen\(/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
