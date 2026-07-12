import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TapRippleOverlay,
  type TapRippleOverlayHandle,
} from '../../src/components/TapRippleOverlay';

afterEach(() => vi.useRealTimers());

describe('TapRippleOverlay', () => {
  it('animates inside its own subtree without rerendering the simulator host', () => {
    vi.useFakeTimers();
    const overlayRef = createRef<TapRippleOverlayHandle>();
    let parentRenders = 0;

    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <div>
          <span>stable video host</span>
          <TapRippleOverlay ref={overlayRef} />
        </div>
      );
    }

    const { container } = render(<SimulatorHost />);
    expect(screen.getByText('stable video host')).not.toBeNull();
    expect(parentRenders).toBe(1);

    act(() => overlayRef.current?.show(120, 240));
    const ripple = container.querySelector('[data-component="tap-ripple"]') as HTMLElement;
    expect(ripple).not.toBeNull();
    expect(ripple.style.left).toBe('120px');
    expect(ripple.style.top).toBe('240px');
    expect(parentRenders).toBe(1);

    act(() => {
      vi.advanceTimersByTime(480);
    });
    expect(container.querySelector('[data-component="tap-ripple"]')).toBeNull();
    expect(parentRenders).toBe(1);
  });
});
