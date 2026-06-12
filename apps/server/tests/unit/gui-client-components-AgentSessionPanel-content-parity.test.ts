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

  it('iPhone 16 Pro aspect-ratio default pinned: 1206/2622 ≈ 0.46 (the locked archetype iphone17_ios18_7_safari26_4; iPhone 17 shares iPhone 16 Pro geometry). Drift to a different default would render a wrong-aspect video frame when callers omit aspectRatio', () => {
    expect(body).toMatch(/const IPHONE_16_PRO_ASPECT_RATIO = 1206 \/ 2622; \/\/ ≈ 0\.46/);
    expect(body).toMatch(/Defaults to iPhone 16/);
    expect(body).toMatch(/Pro \(1206×2622 px\) since that's the locked archetype/);
    expect(body).toMatch(/\(iphone17_ios18_7_safari26_4\) for v1\.0 per the orchestrator brief/);
  });

  it('Scale-to-fit container sizing pinned: the panel box is `h-full max-h-full max-w-full` + aspectRatio style (fills available HEIGHT, derives width from the iPhone aspect, centered by the parent), NOT `w-full`. Drift back to w-full re-introduces the stretched-giant view (height = width × 2.17 on a wide window); the <video> object-contain fills the box exactly', () => {
    expect(body).toMatch(
      /className="relative h-full max-h-full max-w-full overflow-hidden rounded-lg border border-white\/10 bg-black"/,
    );
    expect(body).toMatch(/style=\{\{ aspectRatio: effectiveAspectRatio\.toString\(\) \}\}/);
    // The video fills its (now correctly-sized) box and letterboxes via object-contain.
    expect(body).toMatch(/className="h-full w-full object-contain"/);
    // Guard the specific regression: the container must not revert to w-full.
    expect(body).not.toMatch(/className="relative w-full overflow-hidden/);
  });

  it('Live-aspect mechanism pinned: the stream REAL dimensions (loadedmetadata videoWidth/videoHeight) win over the static aspectRatio prop (effectiveAspectRatio = liveAspect ?? aspectRatio), and onVideoDimensions reports them to the parent (the simulator window resizes to the archetype). Drift back to prop-only would hardcode every future archetype to the 16-Pro shape', () => {
    expect(body).toMatch(/const \[liveAspect, setLiveAspect\] = useState<number \| null>\(null\);/);
    expect(body).toMatch(/const effectiveAspectRatio = liveAspect \?\? aspectRatio;/);
    expect(body).toMatch(/onLoadedMetadata=\{/);
    expect(body).toMatch(/el\.videoWidth \/ el\.videoHeight/);
    expect(body).toMatch(/onVideoDimensions\?\.\(el\.videoWidth, el\.videoHeight\);/);
    expect(body).toMatch(/onVideoDimensions\?: \(width: number, height: number\) => void;/);
  });

  it('LiveKitInfo import from @driftstack/sdk pinned: drift to a local-only type would break the cross-package single-source-of-truth for the LiveKit join-info wire shape', () => {
    expect(body).toMatch(/import type \{ LiveKitInfo \} from '@driftstack\/sdk';/);
  });

  it('LiveKit helpers imported from ../lib/livekit pinned: createLivekitRoom + connectToAgentSession + LivekitConnectionState. Drift to inlining LiveKit-SDK calls would duplicate the helper logic + break the test-injectability', () => {
    expect(body).toMatch(
      /RoomEvent,\s*\n?\s*connectToAgentSession,\s*\n?\s*createLivekitRoom,\s*\n?\s*type LivekitConnectionState,\s*\n?\s*type Room,\s*\n?\s*\} from '\.\.\/lib\/livekit';/,
    );
    // Simulator control (founder 2026-06-11): the LK.6.d input-capture hook is
    // wired so `interactive` embeds (the floating-iPhone window) drive the device.
    expect(body).toMatch(/import \{ useInputCapture \} from '\.\.\/lib\/livekit-input-capture';/);
    expect(body).toMatch(/useInputCapture\(\{ room, videoRef, enabled: interactive \}\);/);
  });

  it('Connect effect reconnects ONLY on the connection identity (deps [info.ws_url, info.token]) and routes onStateChange through a ref — pinned so a consumer passing an inline onStateChange (the LK.6.c badge usage) cannot make the effect re-run every render and disconnect+reconnect the LiveKit room (streaming reconnect-thrash). A regression to [info, onStateChange] re-introduces that.', () => {
    // Connection-identity deps (+ retryNonce for the manual Reconnect), not the
    // whole info object / callback identity. retryNonce only changes on the
    // Reconnect button click, so it can't cause render-driven reconnect-thrash.
    expect(body).toMatch(/\}, \[info\.ws_url, info\.token, retryNonce\]\);/);
    expect(body).not.toMatch(/\}, \[info, onStateChange\]\);/);
    // onStateChange flows through a latest-value ref, decoupled from the effect.
    expect(body).toMatch(/const onStateChangeRef = useRef\(onStateChange\);/);
    expect(body).toMatch(/onStateChangeRef\.current\?\.\(next\);/);
  });

  it("W617 no-publisher detection: NO_PUBLISHER_TIMEOUT_MS = 10_000 module export; publisher tri-state ('waiting' → 'publishing' on TrackSubscribed video, 'waiting' → 'none' on post-connect timeout); the 'none' overlay offers the parent's onNoPublisher fallback (open-polling-viewer button) — pinned for the founder-hit connected-but-empty-room black screen (no browser worker publishing)", () => {
    expect(body).toMatch(/export const NO_PUBLISHER_TIMEOUT_MS = 10_000;/);
    expect(body).toMatch(
      /const \[publisher, setPublisher\] = useState<'waiting' \| 'publishing' \| 'none'>\('waiting'\);/,
    );
    expect(body).toMatch(/setPublisher\('publishing'\);/);
    expect(body).toMatch(/setPublisher\(\(p\) => \(p === 'waiting' \? 'none' : p\)\);/);
    // Timer cleared on unmount so a closed panel can't fire a stale fallback.
    expect(body).toMatch(/if \(noPublisherTimer !== null\) clearTimeout\(noPublisherTimer\);/);
    expect(body).toMatch(/data-overlay="publisher-state"/);
    expect(body).toMatch(/data-action="open-polling-viewer"/);
    expect(body).toMatch(/no browser worker is publishing on/);
  });
});
