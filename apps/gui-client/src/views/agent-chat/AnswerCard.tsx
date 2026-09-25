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

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CaptureThumbnail } from '../../components/CaptureThumbnail';
import { useFocusTrap } from '../../lib/use-focus-trap';
import { IconCopy, IconExpand } from './icons';

/** How long "Copied" stays on the button before it says "Copy" again. */
const COPIED_MS = 1600;

/** The dialog's accessible name. It says WHICH screenshot is on screen, because
 *  "Screenshot" alone is the same name every turn in the log would give, and the
 *  turn has several steps a customer could have been looking at. */
function shotLabel(step: number | undefined): string {
  return step === undefined ? 'Screenshot' : `Screenshot from step ${String(step)}`;
}

/** The settled turn's answer, as the card. */
export function AnswerCard({
  answer,
  host,
  captureId,
  captureStep,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
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
  /** Which step of this turn that screenshot came from, 1-based — the answer
   *  card hoists it out of a step, so the full-size view can say which one.
   *  Undefined ⇒ the dialog falls back to the plain "Screenshot". */
  captureStep?: number;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  captureSrc?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The control the keyboard goes back to when the dialog closes. Held as a
   *  ref rather than read off `document.activeElement`, because the thing that
   *  opened the dialog is a FACT about this card, not about whatever happened
   *  to be focused. */
  const thumb = useRef<HTMLButtonElement>(null);

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
            ref={thumb}
            type="button"
            onClick={() => setZoomed(true)}
            aria-label="Open the screenshot the agent captured on this step"
            className="ai-shot"
          >
            <span className="ai-shot-frame ai-shot-hover">
              <CaptureThumbnail
                baseUrl={baseUrl}
                apiKey={apiKey}
                controlKey={controlKey}
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
            <Lightbox
              label={shotLabel(captureStep)}
              opener={thumb}
              onClose={() => setZoomed(false)}
            >
              <CaptureThumbnail
                baseUrl={baseUrl}
                apiKey={apiKey}
                controlKey={controlKey}
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

/**
 * The screenshot at full size — a real dialog, PORTALLED to `document.body`.
 *
 * ⛔ IT USED TO RENDER WHERE IT SITS IN THE REACT TREE, which is inside the
 * log's `<ol aria-live="polite" aria-relevant="additions">`. Three separate
 * defects came out of that one placement, and the portal is what closes all
 * three (rounds B and C left it open across five stages):
 *
 *   1. ANNOUNCED AS TRANSCRIPT. Opening it inserted a `role="dialog"` and its
 *      whole subtree into a polite region as an ADDITION, so a screen reader
 *      read the modal out as if the AI had just said it. A dialog announces
 *      itself; it must not also arrive as chat.
 *   2. LAYERED UNDER THE CHROME. `.ai-deck-body` is `z-index: 0` — a stacking
 *      CONTEXT, deliberately, so the stage's room light and HUD chips cannot
 *      paint over the bar. A `z-50` backdrop inside that context is sealed in
 *      at 0, and the rail (3, and 41 while its narrow-tier overlay is open) and
 *      the bar (3) painted OVER the full-size screenshot. At the end of
 *      `document.body` the 50 is real again, above the rail and after the
 *      save-as-task dialog in paint order.
 *   3. IT BLOCKED THE REAL CONTAINER QUERY. `container-type` makes an element a
 *      containing block for `position: fixed` descendants, so the view root
 *      cannot be the `@container` spec §1 asks for while a `fixed inset-0`
 *      modal lives inside it. This was one of the two; the save-as-task dialog
 *      is the other, and is still inline (see
 *      `the-ai-view-puts-the-stage-in-reading-order`).
 *
 * Everything else is the modal contract the rest of the app already keeps:
 * `role="dialog" aria-modal="true"` with a name that says WHICH screenshot,
 * focus moved in on open and put back on the thumbnail on close, Escape and a
 * backdrop click to close, Tab trapped, and the page behind hidden from
 * assistive tech and made inert while it is open.
 *
 * MOTION: the shared `.animate-modal-*` classes animate `opacity` and
 * `transform` only, and the global `prefers-reduced-motion` clamp at the top of
 * `styles/index.css` ends both on their last frame — the open is a still for a
 * customer who asked for less movement. The close is an unmount with no
 * animation at all, which is the same thing the save-as-task dialog does.
 */
function Lightbox({
  children,
  label,
  opener,
  onClose,
}: {
  children: ReactNode;
  /** The dialog's accessible name — see `shotLabel`. */
  label: string;
  /** The thumbnail that opened it, and the control focus goes back to. */
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}): JSX.Element {
  const shell = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const nameId = useId();

  // ⛔ THE TRAP IS DECLARED FIRST AND THAT ORDER IS LOAD-BEARING. React runs an
  // effect's cleanup in the order the effects were declared, so on close the
  // trap's own focus-restore runs BEFORE the effect below lifts `inert` from
  // the page. A node inside an inert subtree cannot take focus, so that restore
  // is a no-op in a real browser — and the restore that lands is the explicit
  // one below, after the page is interactive again. Declared the other way
  // round the keyboard would be left on `<body>`, ~20 tab stops from the
  // thumbnail, which is the exact defect `use-focus-trap`'s own header records.
  useFocusTrap(true, panel, onClose);

  useEffect(() => {
    const own = shell.current;
    const restore = opener.current;
    const undo = own === null ? [] : hideBehind(own);
    return () => {
      for (const put of undo) put();
      // `isConnected` because the log can legitimately re-render the card away
      // underneath the dialog; focusing a detached node is what puts a keyboard
      // user on `<body>`, and doing nothing leaves focus where it fell.
      if (restore !== null && restore.isConnected) restore.focus();
    };
  }, [opener]);

  return createPortal(
    <div
      ref={shell}
      className="animate-modal-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        // ⛔ LABELLED BY THE CAPTION IT DRAWS, not by an `aria-label` only a
        // screen reader can reach. The eye gets a full-screen picture with no
        // idea which of six steps it came from; the same asymmetry the step
        // rows' visible durations exist to close, pointing the other way.
        aria-labelledby={nameId}
        className="animate-modal-panel-in flex max-h-full flex-col items-center gap-3"
      >
        {children}
        {/* The footer sits on its OWN opaque surface. The scrim is dark in both
            themes (measured: the light theme's page reads rgb(74,74,75) under
            it), so ink on the scrim would be dark-on-dark in the light theme —
            the defect spec D2 fixed on the stage. A real surface behind the
            caption keeps both themes at the same AA ratio. */}
        <div className="flex max-w-full items-center gap-3 rounded-lg bg-surface-raised px-3 py-1.5">
          {/* `title` because it CAN clip: at the 600px-tall minimum the row
              measures 226px and the caption plus Close very nearly fills it.
              The text gate's rule for a clipped run is a `title` or an
              `aria-label` within six ancestors, and a clipped run with neither
              is text a customer cannot read at all. */}
          <span id={nameId} title={label} className="truncate text-xs text-ink-secondary">
            {label}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary shrink-0 px-3 py-1 text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Everything on the page that is NOT the dialog: hidden from assistive tech and
 * made inert while it is open. Returns one undo per element touched, so a
 * page that already had an `aria-hidden` of its own gets that value back rather
 * than losing it.
 *
 * ⛔ `aria-modal="true"` IS NOT ENOUGH ON ITS OWN. It is advisory, several
 * screen readers ignore it, and the region this dialog has to be silent about
 * is a POLITE LIVE REGION that keeps streaming while the dialog is open — a
 * turn can still be landing steps behind it. `aria-hidden` on the app root is
 * what actually stops the transcript talking over the modal.
 *
 * `inert` is set alongside it for pointer and focus: it is ignored by a WebView
 * too old to know the attribute (macOS 12), where the focus trap is still the
 * guard, and does the right thing everywhere else.
 */
function hideBehind(own: Element): Array<() => void> {
  const undo: Array<() => void> = [];
  for (const el of Array.from(document.body.children)) {
    // The portal's own node, and never a `<script>` / `<style>` / `<link>`:
    // marking those is noise in the DOM a reviewer reads.
    if (el === own || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') {
      continue;
    }
    const hidden = el.getAttribute('aria-hidden');
    const inert = el.getAttribute('inert');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('inert', '');
    undo.push(() => {
      if (hidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', hidden);
      if (inert === null) el.removeAttribute('inert');
      else el.setAttribute('inert', inert);
    });
  }
  return undo;
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
