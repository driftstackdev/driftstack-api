// W476.B — drift guard for apps/gui-client/src/components/SessionStatusBadge.tsx.
// V-534.N SessionStatusBadge. Drift here either drops the
// 5-status label map (an unknown status falls through to the
// raw enum string — UI shows 'busy_evicted' instead of a clean
// label) or breaks the 'busy' tone's animate-pulse class (the
// active session no longer visually pulses to indicate live
// activity — operators can't tell at a glance which session is
// currently in use).
//
//   • V-534.N framing pinned: 'SessionStatusBadge presentational
//     component.' + 'Mirrors V-534.M TierBadge for session
//     statuses. Maps a session status to a label + tone so views
//     (FleetView, LiveSessionView, SessionsHistoryView) can render
//     a consistent chip without duplicating the mapping.'
//   • SessionStatus 5-value union (creating | ready | busy |
//     destroyed | errored).
//   • SessionStatusBadgeProps: status forward-compat string (any
//     string for new-status tolerance) + size?: 'sm'|'md'.
//   • STATUS_LABEL 5-entry (Creating/Ready/Busy/Destroyed/Errored)
//     + STATUS_TONE 5-entry mapping to Tone 5-union + TONE_CLASSES
//     5-entry with bg-status-*/15 text-status-* border-status-*/30
//     + SIZE_CLASSES sm/md.
//   • sessionStatusLabelFor + sessionStatusToneFor: ?? 'neutral'
//     fallback for unknown statuses (forward-compat).
//   • Render: role='status' + aria-label `Session status: ${label}`
//     + busy tone dot with animate-pulse.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/SessionStatusBadge.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W476.B apps/gui-client/src/components/SessionStatusBadge.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.N framing pinned: 'V-534.N — SessionStatusBadge presentational component.' + 'Mirrors V-534.M TierBadge for session statuses. Maps a session status to a label + tone so views (FleetView, LiveSessionView, SessionsHistoryView) can render a consistent chip without duplicating the mapping.'", () => {
    expect(body).toMatch(/\/\/ V-534\.N — SessionStatusBadge presentational component\./);
    expect(body).toMatch(
      /\/\/ Mirrors V-534\.M TierBadge for session statuses\. Maps a session\s*\/\/ status to a label \+ tone so views \(FleetView, LiveSessionView,\s*\/\/ SessionsHistoryView\) can render a consistent chip without\s*\/\/ duplicating the mapping\./,
    );
  });

  it("SessionStatus 5-value union ('creating' | 'ready' | 'busy' | 'destroyed' | 'errored') + SessionStatusBadgeProps: status forward-compat 'Accepts any string for forward-compat with future statuses.' + size? 'sm' | 'md'", () => {
    expect(body).toMatch(
      /export type SessionStatus = 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/,
    );
    expect(body).toMatch(
      /export interface SessionStatusBadgeProps \{\s*\/\*\* Accepts any string for forward-compat with future statuses\. \*\/\s*status: string;\s*size\?: 'sm' \| 'md';\s*\}/,
    );
  });

  it('STATUS_LABEL 5-entry (Creating/Ready/Busy/Destroyed/Errored) + STATUS_TONE 5-entry mapping to Tone 5-union (neutral/success/busy/warning/error) with creating→neutral, ready→success, busy→busy, destroyed→warning, errored→error', () => {
    expect(body).toMatch(
      /const STATUS_LABEL: Record<string, string> = \{\s*creating: 'Creating',\s*ready: 'Ready',\s*busy: 'Busy',\s*destroyed: 'Destroyed',\s*errored: 'Errored',\s*\};/,
    );
    expect(body).toMatch(/type Tone = 'neutral' \| 'success' \| 'busy' \| 'warning' \| 'error';/);
    expect(body).toMatch(
      /const STATUS_TONE: Record<string, Tone> = \{\s*creating: 'neutral',\s*ready: 'success',\s*busy: 'busy',\s*destroyed: 'warning',\s*errored: 'error',\s*\};/,
    );
  });

  it('TONE_CLASSES 5-entry (neutral/success/busy/warning/error) with bg-status-{success,info,warning,error}/15 + text-status-{success,info,warning,error} + border-status-{success,info,warning,error}/30 (info for busy tone); SIZE_CLASSES sm (px-1.5 py-0.5 text-xs) + md (px-2 py-0.5 text-sm)', () => {
    expect(body).toMatch(
      /const TONE_CLASSES: Record<Tone, string> = \{\s*neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',\s*success: 'bg-status-success\/15 text-status-success border-status-success\/30',\s*busy: 'bg-status-busy\/15 text-status-busy border-status-busy\/30',\s*warning: 'bg-status-warning\/15 text-status-warning border-status-warning\/30',\s*error: 'bg-status-error\/15 text-status-error border-status-error\/30',\s*\};/,
    );
    expect(body).toMatch(
      /const SIZE_CLASSES: Record<NonNullable<SessionStatusBadgeProps\['size'\]>, string> = \{\s*sm: 'px-1\.5 py-0\.5 text-xs',\s*md: 'px-2 py-0\.5 text-sm',\s*\};/,
    );
  });

  it("Exported helpers: sessionStatusLabelFor + sessionStatusToneFor with ?? fallback (label→raw status, tone→'neutral') for forward-compat with future server statuses", () => {
    expect(body).toMatch(
      /export function sessionStatusLabelFor\(status: string\): string \{\s*return STATUS_LABEL\[status\] \?\? status;\s*\}/,
    );
    expect(body).toMatch(
      /export function sessionStatusToneFor\(status: string\): Tone \{\s*return STATUS_TONE\[status\] \?\? 'neutral';\s*\}/,
    );
  });

  it("Render: role='status' + aria-label `Session status: ${label}` + size default 'md' + busy-tone dot with animate-pulse (live-activity indicator) + ternary chain for dot bg color", () => {
    expect(body).toMatch(/role="status"\s*aria-label=\{`Session status: \$\{label\}`\}/);
    expect(body).toMatch(/const size = props\.size \?\? 'md';/);
    expect(body).toMatch(
      /tone === 'success'\s*\? 'bg-status-success'\s*: tone === 'busy'\s*\? 'bg-status-busy animate-pulse'\s*: tone === 'warning'\s*\? 'bg-status-warning'\s*: tone === 'error'\s*\? 'bg-status-error'\s*: 'bg-ink-muted'/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
