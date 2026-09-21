// #7 guard — the screenshot-capture gate (captureIdOf) and the thumbnail render.
//
// Mutation-proved:
//  • drop the `result.kind !== 'success'` check in captureIdOf → the FAILURE arm
//    below reds (a failed step would try to show a screenshot).
//  • render the <img> regardless of the fetch result → the null-fallback arm reds
//    (a miss would show a broken image instead of "Screenshot unavailable").
//  • fetch even when sessionId is null → the no-session arm reds.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import type { AgentIntent, AgentIntentResult } from '@driftstack/sdk';
import { fetchAgentCapture } from '../../src/lib/agent-session-control';
import { CaptureThumbnail, captureIdOf } from '../../src/components/CaptureThumbnail';

/** The stylesheet with its comments stripped — the CSS sibling of the repo's
 *  `codeOnly` rule. Both rules read below carry long comments that say what the
 *  declaration does, so a scan that kept the prose would pass on the prose. */
const CSS = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** One CSS rule's body, by exact selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS)?.[2] ?? '';
}

vi.mock('../../src/lib/agent-session-control', () => ({
  fetchAgentCapture: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchAgentCapture);
// describeResult reads only `summary` for a success result and never the intent,
// so a placeholder intent is enough to build a well-typed result.
const anIntent = { kind: 'capture' } as unknown as AgentIntent;

function success(captureId?: string): AgentIntentResult {
  return {
    kind: 'success',
    intent: anIntent,
    summary: 'Captured the page',
    ...(captureId !== undefined ? { captureId } : {}),
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  // jsdom leaves these undefined; the component makes + revokes object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

describe('captureIdOf — the gate deciding whether a plan step shows a screenshot', () => {
  it('returns the id for a SUCCESS result that carries one', () => {
    expect(captureIdOf(success('cap_1'))).toBe('cap_1');
  });

  it('returns undefined for a success result with no captureId (non-capture step / older server)', () => {
    expect(captureIdOf(success())).toBeUndefined();
  });

  it('treats an empty captureId as absent — a blank id can only ever fetch a miss', () => {
    expect(captureIdOf(success(''))).toBeUndefined();
  });

  it('returns undefined for a FAILURE result even if a captureId is somehow present', () => {
    const failed = { kind: 'failure', intent: anIntent, reason: 'nope', captureId: 'cap_x' };
    expect(captureIdOf(failed as unknown as AgentIntentResult)).toBeUndefined();
  });
});

describe('CaptureThumbnail — fetches an authed blob and renders it, degrading calmly', () => {
  it('shows the image once the authed blob resolves', async () => {
    mockedFetch.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    render(
      <CaptureThumbnail baseUrl="https://api.x" apiKey="k" sessionId="agt_1" captureId="cap_1" />,
    );
    const img = await screen.findByAltText(/screenshot the agent captured/i);
    expect(img).toBeTruthy();
    // The Bearer key rides the fetch, not the <img src> — proven by the args.
    expect(mockedFetch).toHaveBeenCalledWith('https://api.x', 'k', 'agt_1', 'cap_1');
  });

  it('shows a calm fallback (never a broken image) when the capture is a miss', async () => {
    mockedFetch.mockResolvedValue(null);
    render(
      <CaptureThumbnail baseUrl="https://api.x" apiKey="k" sessionId="agt_1" captureId="cap_x" />,
    );
    await waitFor(() => expect(screen.getByText(/screenshot unavailable/i)).toBeTruthy());
    expect(screen.queryByAltText(/screenshot the agent captured/i)).toBeNull();
  });

  it('does not fetch when there is no live session id', () => {
    render(
      <CaptureThumbnail baseUrl="https://api.x" apiKey="k" sessionId={null} captureId="cap_1" />,
    );
    expect(screen.getByText(/screenshot unavailable/i)).toBeTruthy();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

// ── The two states the FULL-SIZE view spends its first moments in.
//
// ⛔ WHERE THESE ARE DRAWN CHANGES WHAT THEY NEED. `inline` and `figure` both
// land on something opaque — the step row, and `.ai-shot-frame`, which draws a
// `surface-inset` tile at a fixed 402/874 box. `lightbox` lands on the modal's
// own scrim, `bg-black/70` over the page, which composites DARK IN BOTH THEMES
// (measured in a real browser at 1280x800: the light theme's page reads
// rgb(247,248,250) and the scrim turns it into rgb(71,71,73)). Two things
// followed from that and neither is visible in jsdom, so both are pinned here
// against the class the component chooses:
//
//   • "Screenshot unavailable" was `text-ink-secondary` with no surface under
//     it — rgb(82,88,99) on rgb(71,71,73), measured 1.30:1 in the light theme
//     against the 4.5:1 this view is held to. (Dark theme: 13.57:1. A defect
//     that only exists in one theme is exactly the one an eye misses.) The
//     caption row beside it already solved this by drawing its own
//     `surface-raised` pill; this is that fix, one element to the side.
//   • The skeleton was `h-full w-full`. The dialog's panel is a flex COLUMN
//     with no height of its own, so a percentage height resolves against auto
//     and the box measured 226x0 (browser). Opening the full-size view showed
//     a caption pill with nothing above it for the whole of every fetch — and
//     in the app that is every open, because only a gallery scene hands the
//     thumbnail a ready `src`.
describe('CaptureThumbnail — what the FULL-SIZE view shows before the picture is there', () => {
  it('draws the unavailable line on a surface of its own, because the modal scrim is dark in both themes', () => {
    render(
      <CaptureThumbnail
        baseUrl="https://api.x"
        apiKey="k"
        sessionId={null}
        captureId="cap_1"
        variant="lightbox"
      />,
    );
    const line = screen.getByText(/screenshot unavailable/i);
    expect(line.className).toContain('bg-surface-raised');
    // The pill is the caption row's, so the two read as one object and the
    // measured ratio is the caption's measured ratio (6.79 light / 9.85 dark).
    expect(line.className).toContain('rounded-lg');
    expect(line.className).toContain('text-ink-secondary');
  });

  it('leaves the step-row and card fallbacks without a surface — those already sit on something opaque', () => {
    // CONTROL for the arm above: the assertion is about the SCRIM, not about
    // "every fallback needs a background". The figure's does not, and the rule
    // that makes that true is read here rather than assumed.
    //
    // ⛔ PIN MOVED (review of gallery-coverage-and-the-minimum-window): the
    // figure string was `block p-2 text-2xs text-ink-secondary` and is now the
    // filling, centring one — see "fills the card’s tile…" below for the
    // measurement. What this arm CLAIMS is unchanged and is what the arm above
    // needs: neither of these two gets a surface of its own. The `inline`
    // string is untouched.
    const { unmount } = render(
      <CaptureThumbnail
        baseUrl="https://api.x"
        apiKey="k"
        sessionId={null}
        captureId="cap_1"
        variant="figure"
      />,
    );
    expect(screen.getByText(/screenshot unavailable/i).className).toBe(
      'flex h-full w-full items-center justify-center p-2 text-center text-2xs text-ink-secondary',
    );
    unmount();
    render(
      <CaptureThumbnail baseUrl="https://api.x" apiKey="k" sessionId={null} captureId="cap_1" />,
    );
    expect(screen.getByText(/screenshot unavailable/i).className).toBe(
      'mt-1 block text-2xs text-ink-secondary',
    );
    const frame = ruleBody('.ai-shot-frame');
    expect(frame).toContain('background: rgb(var(--surface-inset-rgb))');
    expect(frame).toContain('aspect-ratio: 402 / 874');
  });

  it('fills the card’s tile with the unavailable line instead of stranding it in the corner', () => {
    // ⛔ THE SURFACE A FALLBACK LANDS ON DECIDES WHAT IT NEEDS — the same rule
    // the two arms above apply to the scrim, applied one variant to the side.
    // `figure` is not a line of text in a row: it is the WHOLE of a tile the
    // card draws at a fixed 72 x 402/874 box, and a `block` span with 8px of
    // padding filled 44px of the 156.53px the tile is tall (measured in a real
    // browser on `audit-agent-chat-budget`), leaving 112px of empty inset
    // surface under two words pinned to the top-left corner with the expand
    // badge floating in the void below them.
    //
    // Nothing had ever rendered it: the error branch needs a capture id the
    // seam refuses, which only arrived with `audit-agent-chat-budget`. The
    // previous stage's review asked for exactly this cell and this is what it
    // shows.
    //
    // `h-full` is right HERE and wrong in the dialog — the distinction the
    // skeleton arms below draw — because this frame has a height to be a
    // percentage of (definite width + aspect-ratio); measured after the change,
    // the span is 72 x 156.53, the tile exactly.
    render(
      <CaptureThumbnail
        baseUrl="https://api.x"
        apiKey="k"
        sessionId={null}
        captureId="cap_1"
        variant="figure"
      />,
    );
    const line = screen.getByText(/screenshot unavailable/i);
    expect(line.className).toContain('h-full');
    expect(line.className).toContain('w-full');
    expect(line.className).toContain('items-center');
    expect(line.className).toContain('justify-center');
    // Two words in a 72px column wrap; centred text that is not centre-ALIGNED
    // reads as a ragged block floating in the middle of the tile.
    expect(line.className).toContain('text-center');
    // CONTROL, and the reason this is not the lightbox fix: the tile is already
    // opaque (`surface-inset`), so the line needs no pill of its own. Measured
    // on the repaired element in a real browser: 12.92:1 dark, 5.57:1 light.
    expect(line.className).not.toContain('bg-surface-raised');
    // …and the frame really does give it a height to fill. Without both of
    // these `h-full` resolves against `auto` and this is the dialog's 226x0 bug
    // in a second place.
    const frame = ruleBody('.ai-shot-frame');
    expect(frame).toContain('width: 72px');
    expect(frame).toContain('aspect-ratio: 402 / 874');
  });

  it('gives the full-size skeleton a box of its own, because a percentage height in the dialog is zero', () => {
    // A promise that never settles IS the loading state: the component is left
    // exactly where a customer sees it while the bytes are in flight.
    mockedFetch.mockReturnValue(new Promise<Blob | null>(() => undefined));
    const { container } = render(
      <CaptureThumbnail
        baseUrl="https://api.x"
        apiKey="k"
        sessionId="agt_1"
        captureId="cap_1"
        variant="lightbox"
      />,
    );
    const skeleton = container.firstElementChild;
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.className).toContain('ai-lightbox-wait');
    expect(skeleton?.className).not.toContain('h-full');
    // Still the app's one skeleton gesture, which the global reduced-motion
    // clamp stills with everything else.
    expect(skeleton?.className).toContain('animate-pulse');
  });

  it('keeps `h-full` for the card figure, where the frame it fills HAS a height', () => {
    // CONTROL for the arm above — `h-full` is not wrong, it is wrong in a box
    // with no height. `.ai-shot-frame` gives one (width + aspect-ratio).
    mockedFetch.mockReturnValue(new Promise<Blob | null>(() => undefined));
    const { container } = render(
      <CaptureThumbnail
        baseUrl="https://api.x"
        apiKey="k"
        sessionId="agt_1"
        captureId="cap_1"
        variant="figure"
      />,
    );
    expect(container.firstElementChild?.className).toBe(
      'block h-full w-full animate-pulse bg-surface-elevated',
    );
    expect(ruleBody('.ai-shot-frame')).toContain('width: 72px');
  });

  it('sizes the waiting box like the picture that replaces it, so the dialog does not jump', () => {
    const wait = ruleBody('.ai-lightbox-wait');
    // The picture's own cap, so the skeleton and the image occupy one box.
    expect(wait).toMatch(/height:\s*min\(82vh,\s*calc\(100vh - 120px\)\)/);
    expect(wait).toContain('aspect-ratio: 402 / 874');
    expect(wait).toContain('max-width: 100%');
    // CONTROL: the picture's rule really does carry that cap, so the two
    // cannot silently drift apart.
    expect(ruleBody('.ai-lightbox-img')).toMatch(
      /max-height:\s*min\(82vh,\s*calc\(100vh - 120px\)\)/,
    );
  });
});
