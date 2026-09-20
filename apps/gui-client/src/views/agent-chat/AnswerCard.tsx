// The answer — the thing the customer actually asked for.
//
// Stage 2 of the AI-view rebuild (spec §3.5) makes it a designed card: an
// "ANSWER" label in the accent, a hairline that draws across the head once, the
// answer at 17/26 so it reads like prose rather than a log line, a provenance
// footer naming the page it was read from, a Copy button, and the screenshot
// the turn captured as a figure at the phone's own ratio, which opens a
// lightbox.
//
// ⛔ IT SITS AT THE SAME POSITION LIVE AND SETTLED, so the hand-off from the
// streamed answer to the settled one moves nothing on screen. `LiveAnswer`
// keeps `[data-testid="live-answer"]` containing ONLY the answer text; the
// settled card keeps the answer above `[data-testid="turn-notice"]` and above
// the "Plan" heading, which three tests read with compareDocumentPosition.
//
// ⛔ THE THUMBNAIL IS THE SAME COMPONENT. `CaptureThumbnail` keeps its alt text
// (`/screenshot the agent captured/i`), its fallback copy and its fetch
// argument order — capture-thumbnail.test.tsx pins all three. Only the frame
// around it is new.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CaptureThumbnail } from '../../components/CaptureThumbnail';
import { useFocusTrap } from '../../lib/use-focus-trap';
import { IconCopy, IconExpand } from './icons';

/** How long "Copied" stays on the button before it says "Copy" again. */
const COPIED_MS = 1600;

/** The settled turn's answer, as the card. */
export function AnswerCard({
  answer,
  host,
  captureId,
  sessionId,
  baseUrl,
  apiKey,
  captureSrc,
}: {
  answer: string;
  /** The page the answer was read from, or undefined when no navigation in
   *  this turn is known — the whole provenance line is then omitted rather
   *  than guessed at. */
  host?: string;
  /** The screenshot this turn captured, hoisted out of its step and into the
   *  card. Undefined ⇒ no figure, and the card is text only. */
  captureId?: string;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  captureSrc?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function copy(): void {
    // Best-effort, and deliberately routed through a promise chain: a WebView
    // with no clipboard permission throws from `writeText` (or from the
    // `clipboard` getter itself) and must not take the click handler with it.
    // "Copied" appears only when the write actually resolved — a confirmation
    // of something that did not happen is worse than no confirmation.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(answer))
      .then(() => {
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(() => undefined);
  }

  return (
    <div className="ai-result ai-rise">
      <div className="ai-answer">
        <div className="ai-answer-hd">
          <span className="section-label">Answer</span>
          <span className="ai-answer-rule ai-draw" aria-hidden="true" />
        </div>
        <p className="ai-answer-say">{answer}</p>
        <div className="ai-answer-src">
          {host !== undefined && (
            <>
              <span>Read from the page</span>
              <span className="mono">{host}</span>
            </>
          )}
          <button type="button" onClick={copy} className="ai-linkbtn">
            <IconCopy />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {captureId !== undefined && (
        <>
          <button
            type="button"
            onClick={() => setZoomed(true)}
            aria-label="Open the screenshot the agent captured on this step"
            className="ai-shot"
          >
            <span className="ai-shot-frame ai-shot-hover">
              <CaptureThumbnail
                baseUrl={baseUrl}
                apiKey={apiKey}
                sessionId={sessionId}
                captureId={captureId}
                src={captureSrc}
                variant="figure"
              />
              <span className="ai-shot-zoom" aria-hidden="true">
                <IconExpand />
              </span>
            </span>
            <span className="ai-shot-cap mono">Screenshot</span>
          </button>
          {zoomed && (
            <Lightbox onClose={() => setZoomed(false)}>
              <CaptureThumbnail
                baseUrl={baseUrl}
                apiKey={apiKey}
                sessionId={sessionId}
                captureId={captureId}
                src={captureSrc}
                variant="lightbox"
              />
            </Lightbox>
          )}
        </>
      )}
    </div>
  );
}

/** The screenshot at full size. The same modal mechanics the rest of the app
 *  uses: the shared `.animate-modal-*` classes, a focus trap, Escape and a
 *  backdrop click to close. */
function Lightbox({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panel, onClose);
  return (
    <div
      className="animate-modal-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Screenshot"
        className="animate-modal-panel-in flex max-h-full flex-col items-center gap-3"
      >
        {children}
        <button type="button" onClick={onClose} className="btn-secondary px-3 py-1 text-xs">
          Close
        </button>
      </div>
    </div>
  );
}

/** The same answer while the turn is still running — published by the server
 *  ahead of the terminal body, which is the only reason it is streamed. It
 *  wears the card so the settled hand-off changes nothing on screen.
 *
 *  ⛔ PINNED: `[data-testid="live-answer"]` contains ONLY the answer text. */
export function LiveAnswer({ answer }: { answer: string }): JSX.Element {
  return (
    <div className="ai-result ai-rise">
      <div className="ai-answer">
        <div className="ai-answer-hd">
          <span className="section-label">Answer</span>
          <span className="ai-answer-rule ai-draw" aria-hidden="true" />
        </div>
        <p className="ai-answer-say" data-testid="live-answer">
          {answer}
        </p>
      </div>
    </div>
  );
}
