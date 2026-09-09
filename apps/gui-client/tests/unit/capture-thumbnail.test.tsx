// #7 guard — the screenshot-capture gate (captureIdOf) and the thumbnail render.
//
// Mutation-proved:
//  • drop the `result.kind !== 'success'` check in captureIdOf → the FAILURE arm
//    below reds (a failed step would try to show a screenshot).
//  • render the <img> regardless of the fetch result → the null-fallback arm reds
//    (a miss would show a broken image instead of "Screenshot unavailable").
//  • fetch even when sessionId is null → the no-session arm reds.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AgentIntent, AgentIntentResult } from '@driftstack/sdk';
import { fetchAgentCapture } from '../../src/lib/agent-session-control';
import { CaptureThumbnail, captureIdOf } from '../../src/components/CaptureThumbnail';

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
