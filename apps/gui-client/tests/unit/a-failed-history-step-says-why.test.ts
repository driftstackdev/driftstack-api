// A back/forward step that does not apply must say why — and one that merely has
// not answered yet must NOT claim it failed.
//
// The call site in SimulatorWindow used to be
// `void navigateAgentSessionHistory(...).catch(...)`: only the TRANSPORT failure
// was handled and the resolved body was dropped. The route returns a
// discriminated 200 for every outcome with a customer-safe sentence in `reason`,
// and `NavigateHistoryResult`'s own doc says those statuses are what "the
// back/forward buttons surface calmly". Nothing read them, so a step that failed
// for a plain reason rendered as a dead button.
//
// ⚠️ The reason this is testable at all: every existing simulator test mocks the
// call as `vi.fn(() => Promise.resolve())`, which resolves `undefined`. Those
// mocks cannot express the shape they stand in for, so none of them could have
// failed when the shape was ignored — which is why the defect survived six test
// files that all reference this function.

import { describe, expect, it } from 'vitest';
import { historyStepNotice } from '../../src/lib/history-step-outcome';

describe('historyStepNotice', () => {
  it('says nothing when the step applied', () => {
    expect(historyStepNotice({ status: 'ok' }, 'back')).toBeNull();
  });

  it('CRITICAL surfaces the server sentence for a definite failure, not a generic one', () => {
    // The server's reason is the half that tells the customer WHY; a generic
    // "could not go back" is what the button already implied by doing nothing.
    expect(
      historyStepNotice({ status: 'unavailable', reason: 'This session is not running.' }, 'back'),
    ).toBe('This session is not running.');
    expect(
      historyStepNotice(
        { status: 'error', reason: 'This session cannot be reached right now.' },
        'forward',
      ),
    ).toBe('This session cannot be reached right now.');
  });

  it('falls back to a direction-specific line when a definite failure carries no reason', () => {
    expect(historyStepNotice({ status: 'unavailable' }, 'back')).toBe('Could not go back');
    expect(historyStepNotice({ status: 'error' }, 'forward')).toBe('Could not go forward');
    // An empty/whitespace reason is not a sentence; it would render as a blank toast.
    expect(historyStepNotice({ status: 'error', reason: '   ' }, 'back')).toBe('Could not go back');
  });

  it('CRITICAL stays silent on timeout — absence of an answer is not a failure', () => {
    // A timeout means the device did not answer inside the request budget. The
    // step may still land, and the page-state frames are the instrument that can
    // observe that. Announcing "could not go back" here would assert an outcome
    // nobody measured — the same mistake as scoring an unprobed target 100%.
    expect(historyStepNotice({ status: 'timeout' }, 'back')).toBeNull();
    expect(historyStepNotice({ status: 'timeout' }, 'forward')).toBeNull();
  });

  it('treats a transport that resolved NOTHING as a failure, not a success', () => {
    // This is the shape every existing simulator mock actually produces. Reading
    // `undefined` as "it worked" would make those mocks certify the happy path
    // for a call that never happened.
    expect(historyStepNotice(undefined, 'back')).toBe('Could not go back');
  });

  it('CONTROL — the two silent statuses are the only silent ones', () => {
    // Without this, an implementation that returned null for everything would
    // satisfy the ok/timeout arms and re-create the original dead button.
    const silent = (['ok', 'timeout', 'unavailable', 'error'] as const).filter(
      (status) => historyStepNotice({ status }, 'back') === null,
    );
    expect(silent).toEqual(['ok', 'timeout']);
  });
});
