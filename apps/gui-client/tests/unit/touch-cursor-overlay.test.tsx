import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import {
  TouchCursorOverlay,
  type TouchCursorOverlayHandle,
} from '../../src/components/TouchCursorOverlay';

describe('TouchCursorOverlay', () => {
  it('moves, presses, and hides without rerendering the simulator host', () => {
    const cursorRef = createRef<TouchCursorOverlayHandle>();
    let parentRenders = 0;

    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <div>
          <span>stable video host</span>
          <TouchCursorOverlay ref={cursorRef} />
        </div>
      );
    }

    const { container } = render(<SimulatorHost />);
    expect(screen.getByText('stable video host')).not.toBeNull();
    const cursor = container.querySelector('[data-component="touch-cursor"]') as HTMLElement;
    expect(cursor.hidden).toBe(true);
    expect(parentRenders).toBe(1);

    act(() => cursorRef.current?.show(120, 240));
    expect(cursor.hidden).toBe(false);
    expect(cursor.style.left).toBe('120px');
    expect(cursor.style.top).toBe('240px');
    expect(parentRenders).toBe(1);

    act(() => cursorRef.current?.setPressed(true));
    expect(cursor.classList.contains('ds-touch-dot--pressed')).toBe(true);
    expect(parentRenders).toBe(1);

    act(() => cursorRef.current?.hide());
    expect(cursor.hidden).toBe(true);
    expect(parentRenders).toBe(1);
  });
});
