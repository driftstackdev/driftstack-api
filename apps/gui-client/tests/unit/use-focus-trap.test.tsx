import { useRef, useState } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useFocusTrap } from '../../src/lib/use-focus-trap';

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
