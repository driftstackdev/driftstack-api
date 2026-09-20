import { useRef, useState } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useFocusTrap } from '../../src/lib/use-focus-trap';

/** A modal whose first control takes focus by itself — the shape the AI view's
 *  save-as-task dialog, the profile editor and the first-run wizard all use.
 *  React applies `autoFocus` while it COMMITS, i.e. BEFORE passive effects, so
 *  this is the harness that tells a restore reading `document.activeElement`
 *  too late apart from one that reads it in time. */
function AutoFocusHarness(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useFocusTrap(open, ref, () => setOpen(false));
  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <div ref={ref} role="dialog">
          <input data-testid="name" autoFocus />
          <button type="button" data-testid="cancel">
            cancel
          </button>
        </div>
      )}
    </div>
  );
}

function Harness({ onEscape }: { onEscape?: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useFocusTrap(open, ref, onEscape);
  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button" data-testid="closer" onClick={() => setOpen(false)}>
        toggle-close
      </button>
      {open && (
        <div ref={ref} role="dialog">
          <button type="button" data-testid="first">
            first
          </button>
          <button type="button" data-testid="last">
            last
          </button>
        </div>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first control on open and restores focus on close', () => {
    const { getByTestId } = render(<Harness />);
    const opener = getByTestId('opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    // first control inside the modal receives focus
    expect(document.activeElement).toBe(getByTestId('first'));
    // closing restores focus to the element that was focused before opening
    fireEvent.click(getByTestId('closer'));
    expect(document.activeElement).toBe(opener);
  });

  it('wraps Tab at the last control and Shift+Tab at the first', () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.click(getByTestId('opener'));
    const first = getByTestId('first');
    const last = getByTestId('last');

    // Tab from the last wraps to the first
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the first wraps to the last
    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('calls onEscape when Escape is pressed while active', () => {
    const onEscape = vi.fn();
    const { getByTestId } = render(<Harness onEscape={onEscape} />);
    fireEvent.click(getByTestId('opener'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('⛔ hands the keyboard back to the TRIGGER even when the modal auto-focuses itself', () => {
    // The defect this arm exists for, found by final QA's keyboard walk of the
    // AI view: `autoFocus` is applied during the commit and passive effects run
    // after it, so a restore that asks `document.activeElement` inside the
    // effect captures the modal's OWN input as "what was focused before". On
    // close it then focuses a node it has just detached, and the keyboard lands
    // on `<body>` — for a keyboard user, back at the top of the window.
    const { getByTestId } = render(<AutoFocusHarness />);
    const opener = getByTestId('opener');
    opener.focus();
    fireEvent.click(opener);
    // the modal really did take the keyboard, so the arm below is not measuring
    // a trap that never engaged
    expect(document.activeElement).toBe(getByTestId('name'));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      document.activeElement,
      'closing an auto-focusing modal dropped the keyboard on the page body',
    ).toBe(opener);
  });

  it('…and leaves the keyboard alone when the trigger is gone by the time it closes', () => {
    // A dialog can legitimately remove the row that opened it. Focusing a
    // detached node is exactly the failure above, so the restore must check
    // rather than fire blind.
    function Vanishing(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      useFocusTrap(open, ref, () => {
        setOpen(false);
        setGone(true);
      });
      return (
        <div>
          {!gone && (
            <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
              open
            </button>
          )}
          {open && (
            <div ref={ref} role="dialog">
              <button type="button" data-testid="only">
                only
              </button>
            </div>
          )}
        </div>
      );
    }
    const { getByTestId, queryByTestId } = render(<Vanishing />);
    getByTestId('opener').focus();
    fireEvent.click(getByTestId('opener'));
    expect(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    }).not.toThrow();
    expect(queryByTestId('opener')).toBeNull();
  });

  it('does nothing while inactive', () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    // modal not open → Escape is ignored
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onEscape).not.toHaveBeenCalled();
  });
});
