// LK.6.b — drift guard for AgentSessionPanel component. Text-reads
// the file to pin the props contract, the room lifecycle, the
// connection-state callback surface, and the iPhone-17-Pro aspect
// ratio default (matches the locked archetype for v1.0).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PANEL = resolve(REPO_ROOT, 'apps/gui-client/src/components/AgentSessionPanel.tsx');

describe('LK.6.b — AgentSessionPanel React component', () => {
  it('component file exists', () => {
    expect(existsSync(PANEL)).toBe(true);
  });

  const body = readFileSync(PANEL, 'utf8');

  it('exports AgentSessionPanel + AgentSessionPanelProps', () => {
    expect(body).toMatch(/export function AgentSessionPanel/);
    expect(body).toMatch(/export interface AgentSessionPanelProps/);
  });

  it('props.info typed as LiveKitInfo from the SDK (no duplicate type)', () => {
    expect(body).toMatch(/import type \{ LiveKitInfo \} from '@driftstack\/sdk'/);
    expect(body).toMatch(/info:\s*LiveKitInfo/);
  });

  it('uses the wrapper helpers (createLivekitRoom + connectToAgentSession)', () => {
    expect(body).toMatch(/createLivekitRoom\(\)/);
    expect(body).toMatch(/connectToAgentSession\(room, info\)/);
  });

  it('wires RoomEvent.TrackSubscribed to attach the remote video track', () => {
    expect(body).toMatch(/RoomEvent\.TrackSubscribed/);
    expect(body).toMatch(/track\.attach\(el\)/);
  });

  it('reflects the 4 main connection states in onStateChange callback', () => {
    expect(body).toMatch(/kind: 'connecting'/);
    expect(body).toMatch(/kind: 'connected'/);
    expect(body).toMatch(/kind: 'reconnecting'/);
    expect(body).toMatch(/kind: 'disconnected'/);
  });

  it('handles connection errors by surfacing the error message into state', () => {
    expect(body).toMatch(/kind: 'error',\s*message/);
  });

  it('disconnects the room on unmount (cleanup function)', () => {
    expect(body).toMatch(/return \(\) => \{[\s\S]+?room as any\)\.disconnect\(\)/);
  });

  it('default aspectRatio matches iPhone 16 Pro (locked archetype for v1.0)', () => {
    expect(body).toMatch(/1206 \/ 2622/);
  });

  it('video element has aria-label for screen readers', () => {
    expect(body).toMatch(/aria-label="Agent session live video stream"/);
  });

  it('mute + autoplay + playsInline set on the <video> element', () => {
    // Required for browser autoplay-policy compliance — muted +
    // playsInline is the canonical "let video play without click"
    // combination.
    expect(body).toMatch(/autoPlay/);
    expect(body).toMatch(/playsInline/);
    expect(body).toMatch(/\bmuted\b/);
  });

  it('renders an overlay with status text + a spinner + a Reconnect affordance when not connected', () => {
    expect(body).toMatch(/data-overlay="connection-state"/);
    expect(body).toMatch(/Connecting to the live stream…/);
    expect(body).toMatch(/reconnecting…/);
    expect(body).toMatch(/disconnected\./);
    // user-friendly UX: a spinner while connecting + a Reconnect button to
    // recover from an error/disconnect without reloading.
    expect(body).toMatch(/animate-spin/);
    expect(body).toMatch(/data-action="reconnect-stream"/);
  });
});
