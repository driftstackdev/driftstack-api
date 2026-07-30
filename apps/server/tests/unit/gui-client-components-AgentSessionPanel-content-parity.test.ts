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
    // The callback now also receives the Room so a consumer can act on the
    // exact room the transition belongs to.
    expect(body).toMatch(/onStateChange\?: \(state: LivekitConnectionState, room: Room\) => void;/);
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
    // the ref callback so the effect re-runs when it mounts), an onPublishError
    // forwarded up to surface a dead-control-channel badge, and the per-archetype
    // captured-frame `logical` dims (A3 84de32ad4d content-only fork) so the tap/
    // scroll mapping adapts to the dispatched device — still wired through the
    // ../lib/livekit-input-capture helper, not inlined SDK calls.
    expect(body).toMatch(/useInputCapture\(\{/);
    expect(body).toMatch(/room,\s*\n?\s*videoElement: videoEl,\s*\n?\s*enabled: interactive,/);
    expect(body).toMatch(/onPublishError,/);
    expect(body).toMatch(/logical: inputLogical,/);
  });

  it('Connect effect reconnects ONLY on the connection identity (deps [info.ws_url, info.token]) and routes onStateChange through a ref — pinned so a consumer passing an inline onStateChange (the LK.6.c badge usage) cannot make the effect re-run every render and disconnect+reconnect the LiveKit room (streaming reconnect-thrash). A regression to [info, onStateChange] re-introduces that.', () => {
    // Connection-identity deps (+ retryNonce for the manual Reconnect), not the
    // whole info object / callback identity. retryNonce only changes on the
    // Reconnect button click, so it can't cause render-driven reconnect-thrash.
    expect(body).toMatch(/\}, \[info\.ws_url, info\.token, retryNonce\]\);/);
    expect(body).not.toMatch(/\}, \[info, onStateChange\]\);/);
    // onStateChange flows through a latest-value ref, decoupled from the effect.
    expect(body).toMatch(/const onStateChangeRef = useRef\(onStateChange\);/);
    expect(body).toMatch(/onStateChangeRef\.current\?\.\(next, room\);/);
  });

  it("W617 no-publisher detection: NO_PUBLISHER_TIMEOUT_MS = 30_000 module export (raised from 10s so a COLD worker spawn — fresh browser fork → page load → LiveKit join — doesn't prematurely flip to the 'no video' message right as the stream appears, founder's first real launch 2026-06-18); publisher tri-state ('waiting' → 'publishing' on TrackSubscribed video, 'waiting' → 'none' on post-connect timeout); the 'none' overlay offers the parent's onNoPublisher fallback (open-polling-viewer button) — pinned for the founder-hit connected-but-empty-room black screen (no browser worker publishing)", () => {
    expect(body).toMatch(/export const NO_PUBLISHER_TIMEOUT_MS = 30_000;/);
    expect(body).toMatch(
      /const \[publisher, setPublisher\] = useState<'waiting' \| 'publishing' \| 'none'>\('waiting'\);/,
    );
    // Publisher transitions go through the effect-local `setP` writer, which
    // also mirrors into publisherRef and notifies onPublisher.
    expect(body).toMatch(/setP\('publishing'\);/);
    // The post-connect timeout escalates to 'none' only while the panel is
    // still waiting — a publisher that arrived first must not be overwritten.
    expect(body).toMatch(/if \(publisherRef\.current === 'waiting'\) setP\('none'\);/);
    // Timer cleared on unmount so a closed panel can't fire a stale fallback.
    expect(body).toMatch(/if \(noPublisherTimer !== null\) clearTimeout\(noPublisherTimer\);/);
    expect(body).toMatch(/data-overlay="publisher-state"/);
    expect(body).toMatch(/data-action="open-polling-viewer"/);
    // The no-publisher overlay is scoped HONESTLY to the live-view/video failure
    // (not "couldn't start the session" — the task may have run; the founder read
    // the old copy as "nothing happened") and drops the false "proxy may be down"
    // cause-assertion (the common real cause is the device's screen-capture grant).
    expect(body).toMatch(/Couldn.t show the live view/);
    expect(body).toMatch(/The task itself may still have run/);
    // \s+ — prettier wraps this JSX text node at a depth-dependent column (the
    // ww5k0xkmx first-frame hold deepened the conditional), so tolerate any wrap.
    expect(body).toMatch(/screen capture may need\s+attention/);
    expect(body).not.toMatch(/the proxy or connection may be down/);
    expect(body).toMatch(/data-action="retry-launch"/);
  });

  it("#1 publisher-lost debounce pinned: a track drop (TrackUnsubscribed / ParticipantDisconnected) does NOT flip publisher→'none' instantly — A3's idle frame-pump down-clock + brief SFU re-negotiations drop+re-add the track within ~1-2s, and an instant flip slammed the scary launch-failed alarm over the last good frame ('reconnecting, happens too often'). Within PUBLISHER_LOST_GRACE_MS a CALM 'reconnecting…' pill shows over the last frame (data-overlay=publisher-reconnecting); only if no TrackSubscribed re-arrives does it escalate to 'none'. Regression-guard: do NOT re-introduce the instant `setPublisher((p) => (p === 'publishing' ? 'none' : p))` flip.", () => {
    expect(body).toMatch(/export const PUBLISHER_LOST_GRACE_MS = 2_000;/);
    // The calm pill renders during the grace (not the full-screen alarm).
    expect(body).toMatch(/data-overlay="publisher-reconnecting"/);
    expect(body).toMatch(
      /const \[publisherReconnecting, setPublisherReconnecting\] = useState\(false\);/,
    );
    // TrackSubscribed cancels the grace + clears the pill.
    expect(body).toMatch(/clearPublisherLostTimer\(\);/);
    expect(body).toMatch(/setPublisherReconnecting\(false\);/);
    // The grace timer escalates to 'none' only after PUBLISHER_LOST_GRACE_MS.
    expect(body).toMatch(/setP\('none'\);/);
    expect(body).toMatch(/PUBLISHER_LOST_GRACE_MS\);/);
    // Guard the regression: NO instant publisher→'none' flip on a track drop.
    expect(body).not.toMatch(/setPublisher\(\(p\) => \(p === 'publishing' \? 'none' : p\)\);/);
  });

  it('#8 bounded auto-reconnect pinned: an UNEXPECTED transport Disconnected (not a deliberate teardown — cleanup sets `cancelled` BEFORE disconnect()) auto-retries with exponential backoff (AUTO_RECONNECT_BACKOFF_MS = [1000,3000,9000], cap 3) via retryNonce before falling back to the manual Reconnect button. A brief network blip recovers itself. Regression-guard: a Disconnected must not jump straight to the manual disconnected overlay while retries remain.', () => {
    expect(body).toMatch(
      /export const AUTO_RECONNECT_BACKOFF_MS = \[1_000, 3_000, 9_000\] as const;/,
    );
    // The Disconnected handler schedules a backoff bump of retryNonce. The
    // attempt counter is a component-level REF (autoReconnectAttemptRef) so it
    // survives the effect re-run each reconnect triggers — a plain effect-local
    // reset every reconnect, defeating the backoff+cap (Fable GUI re-audit).
    expect(body).toMatch(/autoReconnectAttemptRef\.current < AUTO_RECONNECT_BACKOFF_MS\.length/);
    expect(body).toMatch(/const autoReconnectAttemptRef = useRef\(0\);/);
    expect(body).toMatch(/setRetryNonce\(\(n\) => n \+ 1\);/);
    // Both timers are cleared on teardown so a torn-down panel can't fire stale work.
    expect(body).toMatch(/if \(autoReconnectTimer !== null\) clearTimeout\(autoReconnectTimer\);/);
  });

  it("#5/#9 sustained-freeze recovery lever pinned: the panel takes a recoverAction { nonce, mode } prop and reacts to each DISTINCT nonce exactly once — 'resubscribe' toggles the captured remote video publication's subscription off→on (forcing a fresh keyframe via the browser's auto-PLI), 'rebuild' bumps retryNonce (a full Room reconnect). The simulator's frame-progress detector owns WHEN to recover; the panel performs it because it holds the publication + retryNonce in scope. Regression-guard: the publication is captured on TrackSubscribed (the 2nd handler arg) and cleared on TrackUnsubscribed / teardown, and the inert initial nonce 0 must never trigger a recovery.", () => {
    // The prop is on the interface + destructured.
    expect(body).toMatch(/recoverAction\?: \{ nonce: number; mode: 'resubscribe' \| 'rebuild' \};/);
    // The publication is captured (TrackSubscribed's 2nd arg) + cleared.
    expect(body).toMatch(/const videoPublicationRef = useRef</);
    expect(body).toMatch(
      /\(room as any\)\.on\(RoomEvent\.TrackSubscribed, \(track: any, publication: any\) =>/,
    );
    expect(body).toMatch(/videoPublicationRef\.current = \(publication \?\? null\)/);
    // Single-fire per distinct nonce, never the inert initial 0.
    expect(body).toMatch(/const lastRecoverNonceRef = useRef\(0\);/);
    expect(body).toMatch(/if \(action === undefined \|\| action\.nonce === 0\) return;/);
    expect(body).toMatch(/if \(action\.nonce === lastRecoverNonceRef\.current\) return;/);
    // 'rebuild' escalation bumps retryNonce; 'resubscribe' toggles off→on.
    expect(body).toMatch(
      /if \(action\.mode === 'rebuild'\) \{\s*\n?\s*setRetryNonce\(\(n\) => n \+ 1\);/,
    );
    expect(body).toMatch(/pub\.setSubscribed\(false\);/);
    // Re-subscribe via the CLOSURE-captured publication, NOT videoPublicationRef.current:
    // setSubscribed(false) fires TrackUnsubscribed which nulls the ref, so reading the
    // ref 250ms later was a silent no-op (every freeze escalated to a full Room rebuild).
    expect(body).toMatch(/pub\.setSubscribed\?\.\(true\);/);
    // The recovery effect keys on the recoverAction prop.
    expect(body).toMatch(/\}, \[recoverAction, room\]\);/);
  });
});
