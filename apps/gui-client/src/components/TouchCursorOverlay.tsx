import { forwardRef, useImperativeHandle, useRef } from 'react';

export interface TouchCursorOverlayHandle {
  show: (x: number, y: number) => void;
  hide: () => void;
  setPressed: (pressed: boolean) => void;
}

/** Keeps pointer visibility, position, and press transitions out of the large
 * SimulatorWindow render path. */
export const TouchCursorOverlay = forwardRef<TouchCursorOverlayHandle>(
  function TouchCursorOverlay(_props, ref) {
    const cursorRef = useRef<HTMLSpanElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        show: (x, y) => {
          const cursor = cursorRef.current;
          if (cursor === null) return;
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            cursor.hidden = true;
            return;
          }
          cursor.style.left = `${x}px`;
          cursor.style.top = `${y}px`;
          cursor.hidden = false;
        },
        hide: () => {
          if (cursorRef.current !== null) cursorRef.current.hidden = true;
        },
        setPressed: (pressed) => {
          cursorRef.current?.classList.toggle('ds-touch-dot--pressed', pressed);
        },
      }),
      [],
    );

    return (
      <span
        ref={cursorRef}
        data-component="touch-cursor"
        aria-hidden="true"
        hidden
        className="ds-touch-dot pointer-events-none absolute z-20"
      />
    );
  },
);
