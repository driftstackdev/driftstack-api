// The stage — where the iPhone stands.
//
// Stage 0 of the AI-view rebuild (spec §9 / §3.4) creates the SEAM only: this
// renders exactly what the view rendered before, the memo'd `LiveAutomationPanel`
// and nothing else, so the DOM is byte-identical. It exists now because stage 4
// re-cuts the layout around it (device frame, room light, caption, HUD chips),
// and every stage between wants one import to point at.
//
// ⚠️ It deliberately draws NO element of its own. A wrapper that added a <div>
// here would be a visual change in a stage whose whole proof is that there
// isn't one — and it would sit between the view and the panel's own `<aside>`,
// which the save-recipe test pins by class string.
//
// The memo below still bites: `Stage` re-renders on every composer keystroke
// (the view owns the draft), but it passes `LiveAutomationPanel` the same
// primitive `sessionId`/`open` and the same `onClose` identity, so the panel —
// a LiveKit room, a 5 s poll and a video element — does not reconcile.

import { type ReactNode } from 'react';

import { LiveAutomationPanel } from './LiveAutomationPanel';

export function Stage({
  sessionId,
  open,
  onClose,
  standIn,
}: {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
  /** GALLERY SEAM (spec §8) — forwarded to the panel: an IMAGE mounted in the
   *  screen instead of a live stream, so the harness can render the running /
   *  approval / done states with no device. Undefined in the app; the view
   *  reads it off the chat context, which only a scene ever sets. */
  standIn?: ReactNode;
}): JSX.Element {
  return (
    <LiveAutomationPanel sessionId={sessionId} open={open} onClose={onClose} standIn={standIn} />
  );
}
