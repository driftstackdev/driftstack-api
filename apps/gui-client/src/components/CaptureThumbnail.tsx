// #7 — the screenshot the AI captured on a plan step, rendered inline under it.
//
// The capture route (GET /v1/agent-sessions/:id/captures/:captureId) is
// account-authed, and an `<img src>` cannot carry the Bearer key it needs, so
// the bytes are fetched as an authed blob (fetchAgentCapture) and turned into an
// object URL, revoked on unmount / id change. A miss or transport failure
// degrades to a calm one-liner, never a broken image.
//
// Extracted from AgentChatView so the gate (captureIdOf) and the render can be
// unit-tested without pulling AgentChatView's Tauri-adjacent module graph.
import { useEffect, useState } from 'react';

import type { AgentIntentResult } from '@driftstack/sdk';

import { fetchAgentCapture } from '../lib/agent-session-control';

/**
 * The capture id to show for a plan step, or undefined for none. The server
 * mints a captureId ONLY on a successful capture and ONLY when the store is
 * wired, so a failure, a non-capture step, or an older server all yield nothing
 * and no thumbnail renders. An empty string is treated as absent — a blank id
 * can never address a real capture, and rendering it would fetch a guaranteed
 * miss.
 */
export function captureIdOf(result: AgentIntentResult): string | undefined {
  if (result.kind !== 'success') return undefined;
  const id = result.captureId;
  return id !== undefined && id !== '' ? id : undefined;
}

type ThumbState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' };

export function CaptureThumbnail({
  baseUrl,
  apiKey,
  controlKey,
  sessionId,
  captureId,
  src,
  variant = 'inline',
}: {
  baseUrl: string;
  apiKey: string | null;
  /**
   * The session's control key, in a window that holds no account key (the
   * Simulator). When set, the capture is fetched with it and the account key
   * is never sent. Undefined in the main window, which fetches exactly as
   * before.
   */
  controlKey?: string | null;
  sessionId: string | null;
  captureId: string;
  /**
   * GALLERY SEAM (spec §8) — the image to show INSTEAD of fetching the capture.
   * Undefined in the app; a visual-harness scene passes a drawn data URI so the
   * done / trouble scenes reach the state a real capture produces without a
   * server, an API key or a session. Same `<img>`, same alt text, same classes:
   * the gates measure the shipped element, not a stand-in of it.
   */
  src?: string;
  /**
   * Where this thumbnail is being drawn (spec §3.5). `inline` is the shipped
   * one — under its own capture step, as it has always looked. `figure` is the
   * answer card's 72px phone-ratio tile, which fills a frame the card draws;
   * `lightbox` is that same image at full size. The <img> itself is identical
   * in all three — same alt, same source, same fetch — because
   * capture-thumbnail.test.tsx pins the alt text and the fetch argument order,
   * and because a customer must not be shown two different pictures.
   */
  variant?: 'inline' | 'figure' | 'lightbox';
}): JSX.Element {
  const [state, setState] = useState<ThumbState>(
    src === undefined ? { kind: 'loading' } : { kind: 'ready', url: src },
  );

  useEffect(() => {
    // A supplied image is the whole answer: no fetch, no object URL, nothing to
    // revoke. Placed inside the effect rather than around the hook so the hook
    // order is identical with and without it.
    if (src !== undefined) {
      setState({ kind: 'ready', url: src });
      return undefined;
    }
    if (sessionId === null) {
      setState({ kind: 'error' });
      return undefined;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setState({ kind: 'loading' });
    // The main window's call keeps its four arguments exactly; only a window
    // holding a control key passes the fifth.
    const request =
      typeof controlKey === 'string' && controlKey.length > 0
        ? fetchAgentCapture(baseUrl, null, sessionId, captureId, controlKey)
        : fetchAgentCapture(baseUrl, apiKey, sessionId, captureId);
    void request.then((blob) => {
      if (cancelled) return;
      if (blob === null) {
        setState({ kind: 'error' });
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setState({ kind: 'ready', url: objectUrl });
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [baseUrl, apiKey, controlKey, sessionId, captureId, src]);

  // ⛔ THE NOT-READY STATES NEED TO KNOW WHERE THEY ARE DRAWN. `inline` lands in
  // the step row and `figure` inside `.ai-shot-frame`, which is an opaque tile
  // at a definite 72px / 402:874 box — both are fine bare. `lightbox` lands on
  // the full-size dialog's SCRIM (`bg-black/70` over the page), and that is a
  // different surface with different rules:
  //
  //   • it is DARK IN BOTH THEMES — the light theme's page composites to
  //     rgb(71,71,73) under it — so `text-ink-secondary` with nothing behind it
  //     measured 1.30:1 there (13.57:1 in dark, which is how a one-theme defect
  //     survives an eye). It gets the same `surface-raised` pill the dialog's
  //     caption row draws, and with it the caption's measured 6.79 / 9.85.
  //   • it has NO HEIGHT to be a percentage of — the dialog's panel is a flex
  //     column sized by its children — so `h-full` resolved to zero and the
  //     full-size view was a 226x0 hole under a caption for the whole of every
  //     fetch. In the app that is EVERY open: only a gallery scene hands this
  //     component a ready `src`. `.ai-lightbox-wait` carries the picture's own
  //     cap and the device's ratio, so the image lands in the box it held.
  //
  // ⛔ AND `figure` IS NOT A LINE OF TEXT EITHER — the same rule, one variant to
  // the side, found the day `audit-agent-chat-budget` first rendered this
  // branch. `figure` is the WHOLE of the tile the answer card draws, a fixed
  // 72px at 402/874: measured in a real browser, a `block` span with 8px of
  // padding filled 44px of the tile's 156.53 and left 112px of empty inset
  // surface under two words pinned to the top-left corner, with the expand
  // badge floating in the void below them. It fills the tile and centres,
  // which is where the picture it stands in for would have been. `h-full` is
  // right here and wrong in the dialog for one reason: this frame HAS a height
  // to be a percentage of (definite width + aspect-ratio) — measured after the
  // change, 72 x 156.53, the tile exactly. The tile is opaque, so unlike the
  // scrim it needs no pill: 12.92:1 dark / 5.57:1 light, measured.
  if (state.kind === 'error') {
    return (
      <span
        className={
          variant === 'inline'
            ? 'mt-1 block text-2xs text-ink-secondary'
            : variant === 'lightbox'
              ? 'block rounded-lg bg-surface-raised px-3 py-1.5 text-2xs text-ink-secondary'
              : 'flex h-full w-full items-center justify-center p-2 text-center text-2xs text-ink-secondary'
        }
      >
        Screenshot unavailable
      </span>
    );
  }
  if (state.kind === 'loading') {
    return (
      <span
        className={
          variant === 'inline'
            ? 'mt-1 block h-20 w-32 animate-pulse rounded border border-surface-divider bg-surface-raised'
            : variant === 'lightbox'
              ? 'ai-lightbox-wait animate-pulse'
              : 'block h-full w-full animate-pulse bg-surface-elevated'
        }
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      src={state.url}
      alt="Screenshot the agent captured on this step"
      className={
        variant === 'inline'
          ? 'mt-1 block max-h-64 max-w-full rounded border border-surface-divider'
          : variant === 'figure'
            ? 'ai-shot-img'
            : 'ai-lightbox-img'
      }
    />
  );
}
