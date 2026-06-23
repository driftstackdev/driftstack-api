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
    // Low-latency: on subscribe, minimize the receiver jitter buffer for the
    // interactive simulator (pairs with adaptiveStream:false). Guarded no-op on
    // older livekit-client.
    expect(body).toMatch(/track\.setPlayoutDelay\?\.\(0\);/);
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
    // No white border (founder 2026-06-23 / A3 W2827): a white rim outlined the
    // object-contain-shrunken view. bg-black + no border → flush in bezel-black.
    expect(body).toMatch(
      /className="relative h-full max-h-full max-w-full overflow-hidden rounded-lg bg-black"/,
    );
    // Guard the regression: the panel box must NOT carry a white border again.
    expect(body).not.toMatch(/border border-white\/10 bg-black"/);
    expect(body).toMatch(/style=\{\{ aspectRatio: effectiveAspectRatio\.toString\(\) \}\}/);
    // The video fills its (now correctly-sized) box and letterboxes via object-contain.
    expect(body).toMatch(/className="h-full w-full object-contain"/);
    // Guard the specific regression: the container must not revert to w-full.
    expect(body).not.toMatch(/className="relative w-full overflow-hidden/);
  });

  it('Fixed-canonical box aspect pinned (founder 2026-06-23 / A3 W2840): the box aspect is the FIXED canonical device aspect (effectiveAspectRatio = aspectRatio, default 1206/2622 ≡ 402:874), NOT the SFU-downscaled live track aspect — driving the box from videoWidth/videoHeight (≈ but ≠ 402:874) letterboxed the view a few px inside the exactly-402:874 screen-host = "iPhone rendered smaller". The <video> object-contain absorbs the tiny SFU drift sub-pixel. onVideoDimensions still reports the REAL dims for the one-time WINDOW resize. Regression-guard: do NOT revert the BOX aspect to liveAspect.', () => {
    expect(body).toMatch(/const effectiveAspectRatio = aspectRatio;/);
    expect(body).toMatch(/style=\{\{ aspectRatio: effectiveAspectRatio\.toString\(\) \}\}/);
    // The real dims still flow to the parent's window-resize (NOT the box aspect).
    expect(body).toMatch(/onLoadedMetadata=\{/);
    expect(body).toMatch(/onVideoDimensions\?\.\(el\.videoWidth, el\.videoHeight\);/);
    expect(body).toMatch(/onVideoDimensions\?: \(width: number, height: number\) => void;/);
    // Guard the regression: the box aspect must NOT be driven by the live track
    // aspect again (that reintroduces the SFU-drift letterbox / shrunken view).
    expect(body).not.toMatch(/effectiveAspectRatio = liveAspect/);
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
    // The hook now receives the <video> element via STATE (videoEl, lifted from
    // the ref callback so the effect re-runs when it mounts) and an onPublishError
    // forwarded up to surface a dead-control-channel badge — still wired through
    // the ../lib/livekit-input-capture helper, not inlined SDK calls.
    expect(body).toMatch(
      /useInputCapture\(\{ room, videoElement: videoEl, enabled: interactive, onPublishError \}\);/,
    );
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

  it("W617 no-publisher detection: NO_PUBLISHER_TIMEOUT_MS = 30_000 module export (raised from 10s so a COLD worker spawn — fresh browser fork → page load → LiveKit join — doesn't prematurely flip to the 'no video' message right as the stream appears, founder's first real launch 2026-06-18); publisher tri-state ('waiting' → 'publishing' on TrackSubscribed video, 'waiting' → 'none' on post-connect timeout); the 'none' overlay offers the parent's onNoPublisher fallback (open-polling-viewer button) — pinned for the founder-hit connected-but-empty-room black screen (no browser worker publishing)", () => {
    expect(body).toMatch(/export const NO_PUBLISHER_TIMEOUT_MS = 30_000;/);
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
