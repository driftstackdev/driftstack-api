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
  sessionId,
  captureId,
  src,
  variant = 'inline',
}: {
  baseUrl: string;
  apiKey: string | null;
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
    void fetchAgentCapture(baseUrl, apiKey, sessionId, captureId).then((blob) => {
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
  }, [baseUrl, apiKey, sessionId, captureId, src]);

  if (state.kind === 'error') {
    return (
      <span
        className={
          variant === 'inline'
            ? 'mt-1 block text-2xs text-ink-secondary'
            : 'block p-2 text-2xs text-ink-secondary'
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
