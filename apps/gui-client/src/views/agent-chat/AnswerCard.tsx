// The answer — the thing the customer actually asked for.
//
// Stage 0 of the AI-view rebuild (spec §9) creates the seam and NOTHING else:
// today the answer is a single paragraph, and both of these render exactly the
// paragraph that shipped (same classes, same `data-testid="live-answer"`, same
// `whitespace-pre-wrap`). Stage 2 turns it into the designed card — accent
// hairline, provenance, Copy, the screenshot as a figure — in this file, at
// this position in the turn, so the live → settled hand-off still moves nothing.

/** The settled turn's answer. */
export function AnswerCard({ answer }: { answer: string }): JSX.Element {
  return <p className="whitespace-pre-wrap text-sm text-ink-primary">{answer}</p>;
}

/** The same answer while the turn is still running — published by the server
 *  ahead of the terminal body, which is the only reason it is streamed.
 *
 *  ⛔ PINNED: `[data-testid="live-answer"]` contains ONLY the answer text. */
export function LiveAnswer({ answer }: { answer: string }): JSX.Element {
  return (
    <p className="whitespace-pre-wrap text-sm text-ink-primary" data-testid="live-answer">
      {answer}
    </p>
  );
}
