// W267 — manual-control overlay coordinate projection.
//
// The dashboard manual-control overlay sits on top of the LiveKit <video>,
// which renders with `object-contain` (preserves the iPhone aspect ratio →
// letterboxed within the overlay box). A pointer event lands at browser CSS
// coords; the harness wants DEVICE-CSS coords (the iPhone viewport, =
// video.videoWidth × video.videoHeight intrinsic). This maps one to the other,
// undoing the object-contain scale + letterbox offset.
//
// Returns null when the point is in the letterbox (outside the actual video
// frame) — callers drop the event (a tap on the black bars isn't a tap on the
// phone). Pure + framework-free so it's unit-tested; the is:inline overlay
// script in agent-sessions/[id].astro inlines an identical transcription
// (it can't import, being is:inline) — keep the two in lockstep.

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ProjectArgs {
  /** Pointer position in browser CSS px (e.g. MouseEvent.clientX/Y). */
  clientX: number;
  clientY: number;
  /** The <video> element's getBoundingClientRect(). */
  videoRect: RectLike;
  /** Intrinsic stream dimensions (video.videoWidth / videoHeight) = device-CSS. */
  videoWidth: number;
  videoHeight: number;
}

/**
 * Project a browser-CSS pointer position to device-CSS coords inside the
 * object-contain'd video. Returns integer {x, y} in [0..videoWidth] ×
 * [0..videoHeight], or null if the point falls in the letterbox / there's no
 * stream yet (videoWidth/Height 0).
 */
export function projectToDeviceCoords(args: ProjectArgs): { x: number; y: number } | null {
  const { clientX, clientY, videoRect, videoWidth, videoHeight } = args;
  if (videoWidth <= 0 || videoHeight <= 0) return null;
  // object-contain: scale to fit the smaller axis, center the result.
  const scale = Math.min(videoRect.width / videoWidth, videoRect.height / videoHeight);
  if (scale <= 0) return null;
  const displayedW = videoWidth * scale;
  const displayedH = videoHeight * scale;
  const offsetX = videoRect.left + (videoRect.width - displayedW) / 2;
  const offsetY = videoRect.top + (videoRect.height - displayedH) / 2;
  const deviceX = (clientX - offsetX) / scale;
  const deviceY = (clientY - offsetY) / scale;
  if (deviceX < 0 || deviceY < 0 || deviceX > videoWidth || deviceY > videoHeight) {
    return null; // in the letterbox — not on the phone screen.
  }
  return { x: Math.round(deviceX), y: Math.round(deviceY) };
}
