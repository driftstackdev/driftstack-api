// Drift guard for apps/gui-client/src/components/AgentSessionPanel.tsx.
// Pins the LK.6.b doc-comment + the LiveKit subscriber lifecycle +
// the iPhone 16 Pro aspect-ratio default + the onStateChange
// callback contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/gui-client/src/components/AgentSessionPanel.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client components/AgentSessionPanel content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('LK.6.b doc-comment framing pinned: AgentSessionPanel = LiveKit subscriber. Drift to dropping the LK.6.b anchor would orphan the engineering trace; drift to claiming the panel also captures input would mislead (LK.6.d is the input-capture follow-up)', () => {
    expect(body).toMatch(/\/\/ LK\.6\.b — AgentSessionPanel React component\./);
    expect(body).toMatch(
      /Subscribes to the LiveKit room hosting an agent session's video\s*\n?\s*\/\/ stream/,
    );
  });

  it('Lifecycle 3-state framing pinned: mount → createLivekitRoom + connect, on TrackSubscribed → attach video, on unmount/beforeunload → disconnect. Drift to dropping the disconnect-on-unmount step would leak the LiveKit websocket across navigations', () => {
    expect(body).toMatch(
      /On mount: createLivekitRoom\(\) \+ connect\(info\.ws_url, info\.token\)\./,
    );
    expect(body).toMatch(/On TrackSubscribed RemoteVideoTrack event: attach to the <video>\./);
    expect(body).toMatch(/On unmount \/ beforeunload: room\.disconnect\(\)\./);
  });

  it('subscriber-only LK.6.b scope pinned: input capture (LK.6.d) + latency measurement (LK.6.e) are deferred to follow-up sub-slices. Drift to growing the panel into input/latency would mix concerns that the LK.6.* split deliberately separates', () => {
    expect(body).toMatch(
      /Input capture \(LK\.6\.d\) \+ latency measurement \(LK\.6\.e\) land in\s*\n?\s*\/\/ follow-up sub-slices; the panel stays subscriber-only at LK\.6\.b/,
    );
  });

  it('AgentSessionPanelProps interface pinned: info (LiveKitInfo, required) + aspectRatio (optional) + onStateChange (optional callback). Drift to a different shape would break the dashboard consumer that passes these props', () => {
    expect(body).toMatch(/export interface AgentSessionPanelProps \{/);
    expect(body).toMatch(/info: LiveKitInfo;/);
    expect(body).toMatch(/aspectRatio\?: number;/);
    expect(body).toMatch(/onStateChange\?: \(state: LivekitConnectionState\) => void;/);
  });

  it('iPhone 16 Pro aspect-ratio default pinned: 1206/2622 ≈ 0.46 (the locked archetype iphone16pro_ios18_7_safari26_4). Drift to a different default would render a wrong-aspect video frame when callers omit aspectRatio', () => {
    expect(body).toMatch(/const IPHONE_16_PRO_ASPECT_RATIO = 1206 \/ 2622; \/\/ ≈ 0\.46/);
    expect(body).toMatch(/Defaults to iPhone 16/);
    expect(body).toMatch(/Pro \(1206×2622 px\) since that's the locked archetype/);
    expect(body).toMatch(/\(iphone16pro_ios18_7_safari26_4\) for v1\.0 per the orchestrator brief/);
  });

  it('Scale-to-fit container sizing pinned: the panel box is `h-full max-h-full max-w-full` + aspectRatio style (fills available HEIGHT, derives width from the iPhone aspect, centered by the parent), NOT `w-full`. Drift back to w-full re-introduces the stretched-giant view (height = width × 2.17 on a wide window); the <video> object-contain fills the box exactly', () => {
    expect(body).toMatch(
      /className="relative h-full max-h-full max-w-full overflow-hidden rounded-lg border border-white\/10 bg-black"/,
    );
    expect(body).toMatch(/style=\{\{ aspectRatio: aspectRatio\.toString\(\) \}\}/);
    // The video fills its (now correctly-sized) box and letterboxes via object-contain.
    expect(body).toMatch(/className="h-full w-full object-contain"/);
    // Guard the specific regression: the container must not revert to w-full.
    expect(body).not.toMatch(/className="relative w-full overflow-hidden/);
  });

  it('LiveKitInfo import from @driftstack/sdk pinned: drift to a local-only type would break the cross-package single-source-of-truth for the LiveKit join-info wire shape', () => {
    expect(body).toMatch(/import type \{ LiveKitInfo \} from '@driftstack\/sdk';/);
  });

  it('LiveKit helpers imported from ../lib/livekit pinned: createLivekitRoom + connectToAgentSession + LivekitConnectionState. Drift to inlining LiveKit-SDK calls would duplicate the helper logic + break the test-injectability', () => {
    expect(body).toMatch(
      /RoomEvent,\s*\n?\s*connectToAgentSession,\s*\n?\s*createLivekitRoom,\s*\n?\s*type LivekitConnectionState,\s*\n?\s*\} from '\.\.\/lib\/livekit';/,
    );
  });

  it('Connect effect reconnects ONLY on the connection identity (deps [info.ws_url, info.token]) and routes onStateChange through a ref — pinned so a consumer passing an inline onStateChange (the LK.6.c badge usage) cannot make the effect re-run every render and disconnect+reconnect the LiveKit room (streaming reconnect-thrash). A regression to [info, onStateChange] re-introduces that.', () => {
    // Connection-identity deps, not the whole info object / callback identity.
    expect(body).toMatch(/\}, \[info\.ws_url, info\.token\]\);/);
    expect(body).not.toMatch(/\}, \[info, onStateChange\]\);/);
    // onStateChange flows through a latest-value ref, decoupled from the effect.
    expect(body).toMatch(/const onStateChangeRef = useRef\(onStateChange\);/);
    expect(body).toMatch(/onStateChangeRef\.current\?\.\(next\);/);
  });
});
