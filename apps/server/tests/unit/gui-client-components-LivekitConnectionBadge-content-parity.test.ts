// Drift guard for apps/gui-client/src/components/LivekitConnectionBadge.tsx.
// Pins LK.6.c connection-state badge for the AgentSessionPanel chrome.
// 6-variant LivekitConnectionState → 6-shape badge (idle / connecting
// pulse / connected Live / reconnecting pulse / disconnected / error
// with message + Reconnect button). Drift to dropping the Reconnect
// affordance would orphan customers from manual recovery.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/LivekitConnectionBadge.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client/components/LivekitConnectionBadge content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.6.c module-level framing pinned: 'connection-state badge for the AgentSessionPanel chrome. Consumes a LivekitConnectionState (the same value the panel emits via onStateChange) and renders a colored pill + status label. Sized to sit above the video element without competing for real estate.' — pinned so the LK.6.c anchor + AgentSessionPanel-onStateChange-consumer + sit-above-video positioning contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ LK\.6\.c — connection-state badge for the AgentSessionPanel chrome\./,
    );
    expect(body).toMatch(
      /\/\/ Consumes a LivekitConnectionState \(the same value the panel emits\s*\/\/ via onStateChange\) and renders a colored pill \+ status label\.\s*\/\/ Sized to sit above the video element without competing for\s*\/\/ real estate\./,
    );
  });

  it("Auto-reconnect framing pinned: 'livekit-client handles transient drops itself (RoomEvent.Reconnecting / .Reconnected fire automatically; the panel's effect tracks both). When a customer-side reconnect is needed (e.g. the WS reaches its hard timeout), the parent view can remount the panel.' — pinned so the auto-reconnect-not-our-job + manual-recovery-via-remount contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Auto-reconnect: livekit-client handles transient drops itself\s*\/\/ \(RoomEvent\.Reconnecting \/ \.Reconnected fire automatically; the\s*\/\/ panel's effect tracks both\)\. When a customer-side reconnect is\s*\/\/ needed \(e\.g\. the WS reaches its hard timeout\), the parent view\s*\/\/ can remount the panel\./,
    );
  });

  it("6-shape badge state-to-label mapping pinned: 'idle' → 'Idle' / 'connecting' → 'Connecting…' (pulse) / 'connected' → 'Live' / 'reconnecting' → 'Reconnecting…' (pulse) / 'disconnected' → 'Disconnected' / 'error' → 'Error' (status-error) — pinned so the 6-state→6-label contract stays documented. Drift to a different label (e.g. 'Online' instead of 'Live') would mismatch downstream e2e + customer expectations", () => {
    expect(body).toMatch(
      /case 'idle':\s*return \{ label: 'Idle', className: 'bg-white\/10 text-ink-secondary', pulse: false \};/,
    );
    expect(body).toMatch(/label: 'Connecting…',/);
    expect(body).toMatch(/label: 'Live',\s*className: 'bg-status-ready\/20 text-status-ready',/);
    expect(body).toMatch(/label: 'Reconnecting…',/);
    expect(body).toMatch(/label: 'Disconnected',/);
    expect(body).toMatch(
      /case 'error':\s*return \{ label: 'Error', className: 'bg-status-error\/20 text-status-error', pulse: false \};/,
    );
  });

  it("Pulse-on-transient-states framing pinned: 'connecting' + 'reconnecting' set pulse:true; 'idle' + 'connected' + 'disconnected' + 'error' set pulse:false. The pulse className `animate-pulse` only applies when pulse:true. Drift to flipping pulse on 'connected' would create UI flicker on a stable connection", () => {
    expect(body).toMatch(/pulse: true,/);
    expect(body).toMatch(
      /className=\{`inline-block h-1\.5 w-1\.5 rounded-full bg-current \$\{\s*shape\.pulse \? 'animate-pulse' : ''\s*\}`\}/,
    );
  });

  it("Reconnectable-states (disconnected OR error) + role='status' + aria-live='polite' accessibility framing pinned. Drift to dropping role='status' / aria-live would break screen-reader announcement of connection state changes", () => {
    expect(body).toMatch(
      /const reconnectable = state\.kind === 'disconnected' \|\| state\.kind === 'error';/,
    );
    expect(body).toMatch(/role="status"\s*aria-live="polite"/);
  });

  it('Error-state message-rendering framing pinned: state.kind === \'error\' renders <span data-field="error-message">{state.message}</span>. Drift to dropping the error-message render would lose the underlying-error visibility to the customer', () => {
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*<span className="text-xs text-ink-muted" data-field="error-message">\s*\{state\.message\}\s*<\/span>\s*\)\}/,
    );
  });

  it("Reconnect button affordance pinned: data-action='reconnect' + onClick={onReconnect} + only renders when reconnectable && onReconnect !== undefined. Drift to always-rendering would surface a Reconnect button on already-connected states (confusing UX)", () => {
    expect(body).toMatch(
      /\{reconnectable && onReconnect !== undefined && \(\s*<button\s*type="button"\s*onClick=\{onReconnect\}/,
    );
    expect(body).toMatch(/data-action="reconnect"/);
  });
});
