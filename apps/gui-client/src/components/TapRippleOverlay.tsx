import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

interface TapRipple {
  id: number;
  x: number;
  y: number;
}

export interface TapRippleOverlayHandle {
  show: (x: number, y: number) => void;
}

/** Owns the short-lived tap animation state so a tap never repaints the live
 * simulator host. The imperative surface is intentionally tiny: input mapping
 * remains in SimulatorWindow and this child only paints confirmed feedback. */
export const TapRippleOverlay = forwardRef<TapRippleOverlayHandle>(
  function TapRippleOverlay(_props, ref) {
    const nextIdRef = useRef(0);
    const timersRef = useRef(new Map<number, number>());
    const [ripples, setRipples] = useState<TapRipple[]>([]);

    useImperativeHandle(
      ref,
      () => ({
        show: (x, y) => {
          const id = (nextIdRef.current += 1);
          setRipples((current) => [...current, { id, x, y }]);
          const timer = window.setTimeout(() => {
            timersRef.current.delete(id);
            setRipples((current) => current.filter((ripple) => ripple.id !== id));
          }, 480);
          timersRef.current.set(id, timer);
        },
      }),
      [],
    );

    useEffect(
      () => () => {
        for (const timer of timersRef.current.values()) window.clearTimeout(timer);
        timersRef.current.clear();
      },
      [],
    );

    return (
      <>
        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            data-component="tap-ripple"
            aria-hidden="true"
            className="ds-tap-ring pointer-events-none absolute z-20 h-9 w-9 rounded-full border border-white/55 bg-white/10"
            style={{ left: ripple.x, top: ripple.y }}
          />
        ))}
      </>
    );
  },
);
