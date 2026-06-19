// LK.6.c — drift guard for LivekitConnectionBadge component.
// Text-reads the file to pin the per-state shape (label + color +
// pulse), the reconnect-button surface, and the a11y attributes.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BADGE = resolve(REPO_ROOT, 'apps/gui-client/src/components/LivekitConnectionBadge.tsx');

describe('LK.6.c — LivekitConnectionBadge component', () => {
  it('component file exists', () => {
    expect(existsSync(BADGE)).toBe(true);
  });

  const body = readFileSync(BADGE, 'utf8');

  it('exports LivekitConnectionBadge + LivekitConnectionBadgeProps', () => {
    expect(body).toMatch(/export function LivekitConnectionBadge/);
    expect(body).toMatch(/export interface LivekitConnectionBadgeProps/);
  });

  it('consumes LivekitConnectionState type from the wrapper module', () => {
    expect(body).toMatch(/import type \{ LivekitConnectionState \} from '\.\.\/lib\/livekit'/);
  });

  it('shapeFor() branches on all 6 state.kind values (idle/connecting/connected/reconnecting/disconnected/error)', () => {
    expect(body).toMatch(/case 'idle':/);
    expect(body).toMatch(/case 'connecting':/);
    expect(body).toMatch(/case 'connected':/);
    expect(body).toMatch(/case 'reconnecting':/);
    expect(body).toMatch(/case 'disconnected':/);
    expect(body).toMatch(/case 'error':/);
  });

  it('connected state renders the "Live" label (semantic — not "Connected")', () => {
    expect(body).toMatch(/label: 'Live'/);
  });

  it('transient states (connecting / reconnecting) pulse the indicator dot', () => {
    // Both should have pulse: true.
    const connecting = body.indexOf("case 'connecting':");
    const connectingBlock = body.slice(connecting, connecting + 200);
    expect(connectingBlock).toMatch(/pulse:\s*true/);

    const reconnecting = body.indexOf("case 'reconnecting':");
    const reconnectingBlock = body.slice(reconnecting, reconnecting + 200);
    expect(reconnectingBlock).toMatch(/pulse:\s*true/);
  });

  it('error state surfaces the error message (state.message) in the chrome', () => {
    expect(body).toMatch(/state\.kind === 'error'/);
    expect(body).toMatch(/state\.message/);
  });

  it('exposes a Reconnect button surface on disconnected + error states', () => {
    expect(body).toMatch(/data-action="reconnect"/);
    expect(body).toMatch(
      /reconnectable\s*=\s*state\.kind === 'disconnected' \|\| state\.kind === 'error'/,
    );
  });

  it('Reconnect button only renders when onReconnect prop is provided (no dangling no-op)', () => {
    expect(body).toMatch(/reconnectable && onReconnect !== undefined/);
  });

  it('a11y: role="status" + aria-live="polite" so screen readers announce state transitions', () => {
    expect(body).toMatch(/role="status"/);
    expect(body).toMatch(/aria-live="polite"/);
  });

  it('per-state color: connected=status-ready, transient=status-busy, error=status-error, idle/disconnected=neutral (theme-aware status tokens; resolve to emerald/amber/rose/neutral via CSS vars)', () => {
    expect(body).toMatch(/status-ready/);
    expect(body).toMatch(/status-busy/);
    expect(body).toMatch(/status-error/);
  });

  it('exposes data-state attribute carrying the kind discriminator (test selectors)', () => {
    expect(body).toMatch(/data-state=\{state\.kind\}/);
  });
});
