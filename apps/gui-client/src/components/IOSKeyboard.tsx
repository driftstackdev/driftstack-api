// On-screen iOS keyboard for the floating-iPhone simulator (founder 2026-06-25:
// "behave exactly like a real iPhone"). Pixel-faithful QWERTY with the three iOS
// layers (letters / numbers / symbols), one-shot + caps-lock shift, and the iOS
// key "pop-up" magnifier on press.
//
// WIRING / fingerprint note: this is pure GUI CHROME. Every key produces the
// SAME keyDown/keyUp InputEvents the host-keyboard path emits (lib/
// livekit-input-capture onKeyDown/onKeyUp) — a real keypress is down-then-up —
// so the page sees nothing beyond the keystrokes themselves (identical to host
// typing today). It does NOT touch the page's view: the keyboard-driven
// viewport resize (which WOULD change what the page sees) is intentionally
// deferred to A3's box-side focus/resize signals (W2992). The keyboard mounts
// BELOW the video as chrome, so it never moves the <video> on-screen rect the
// tap/scroll coordinate mapping reads (pointerToViewport maps against the video
// element's own bounding rect).
//
// Shift is GUI-LOCAL: it controls the CASE of the next character's `key` (so
// shift+a sends keyDown key:'A'); no modifier-only event is sent for the shift
// tap itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { sendInputEvent, type Room } from '../lib/livekit';

/** The three iOS keyboard layers. `letters` re-renders upper/lower per the live
 *  shift state; `numbers` (123) and `symbols` (#+=) are fixed-glyph. */
export type KeyboardLayer = 'letters' | 'numbers' | 'symbols';

/** Shift state for the letters layer (founder "exactly like a real iPhone"):
 *   - off    — next letter is lowercase.
 *   - once   — next letter is uppercase, then reverts to off (one-shot, the
 *              single tap).
 *   - locked — caps-lock: every letter uppercase until shift is tapped again
 *              (the double-tap within DOUBLE_TAP_MS). */
export type ShiftState = 'off' | 'once' | 'locked';

/** Double-tap window (ms) for shift → caps-lock, matching iOS's ~300ms. */
export const DOUBLE_TAP_MS = 300;

/**
 * Press-and-hold key-repeat cadence, matching iOS. Real iOS repeats ONLY the
 * delete key on hold (letters show an accent picker, space activates the cursor
 * trackpad), so this is wired to the delete key exclusively via FnKey's
 * `repeatOnHold`. Hold ~0.4s, then repeat starting slow and accelerating to a
 * floor — the same "deletes faster the longer you hold" feel as the device.
 */
export const KEY_REPEAT_INITIAL_MS = 400;
export const KEY_REPEAT_START_MS = 120;
export const KEY_REPEAT_MIN_MS = 40;
export const KEY_REPEAT_ACCEL_MS = 12;

/** The letter rows (lowercase canonical). Re-cased per shift state at render. */
const LETTER_ROWS: readonly (readonly string[])[] = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

/** The 123 (numbers) layer character rows. */
const NUMBER_ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
  ['.', ',', '?', '!', "'"],
];

/** The #+= (symbols) layer character rows. */
const SYMBOL_ROWS: readonly (readonly string[])[] = [
  ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
  ['_', '\\', '|', '~', '<', '>', '$', '€', '£', '•'],
  ['.', ',', '?', '!', "'"],
];

/** Apply the live shift state to a letter (numbers/symbols pass through). */
export function applyShift(ch: string, shift: ShiftState): string {
  if (shift === 'off') return ch;
  // Uppercase only affects letters; iOS numbers/symbols don't shift-case.
  return ch.toUpperCase();
}

/** Resolve the `key` string an on-screen key sends, given the live shift state.
 *  Letters honor shift (a→A); every other character is verbatim. Exported so the
 *  unit tests can pin the cased-key contract without a DOM. */
export function keyForChar(ch: string, shift: ShiftState): string {
  return applyShift(ch, shift);
}

/** Props for the on-screen keyboard. */
export interface IOSKeyboardProps {
  /** The LiveKit room — null until connected. Key events are a no-op without it
   *  (mirrors the host-keyboard path, which sends nothing without a room). */
  room: Room | null;
  /** The archetype's logical CSS-px width (e.g. iphone16pro = 402). The key grid
   *  fills the full width below the video; this drives iPhone-faithful key
   *  proportions for the dispatched device. Defaults to 402. */
  width?: number;
  /** Hide affordance — a "dismiss keyboard" control inside the keyboard (the iOS
   *  keyboard has no close button, but the simulator's toggle owns show/hide; we
   *  expose an optional collapse so the panel can wire its toolbar toggle to it).
   *  Optional — when omitted, no dismiss row is rendered. */
  onDismiss?: () => void;
  /** Captured manual-control epoch; changes cancel any held repeat chain. */
  authorityEpoch?: number;
  /** Exact invocation-time Room/epoch proof. Omission is fail-closed. */
  canSendInput?: (room: Room, authorityEpoch: number) => boolean;
}

/** Fire a real keypress: keyDown then keyUp with the SAME `key` (mirrors the
 *  host path — a keypress is down-then-up). Fire-and-forget. No-op without a room.
 *
 *  MUST .catch every send: sendInputEvent only swallows BENIGN teardown races
 *  (isBenignTeardownError — "PC manager is closed" etc.), but a keypress landing
 *  mid-RECONNECT rejects with "Publisher connection not set" / "could not
 *  establish Publisher connection" which are NOT benign-matched → re-thrown. An
 *  uncaught reject on this `void` call reaches the global unhandledrejection
 *  backstop, which (its regex is narrower still) paints the fatal overlay over
 *  the borderless simulator → undraggable black box → force-quit (the exact
 *  2026-06-18 incident). A dropped keystroke during a reconnect is acceptable
 *  (the founder retypes; the input-capture path owns the dead-channel badge), so
 *  swallow here rather than widening the shared benign-teardown allowlist (which
 *  input-capture relies on re-throwing to surface a genuinely dead channel). */
function pressKey(
  room: Room | null,
  key: string,
  authorityEpoch: number,
  canSendInput?: (room: Room, authorityEpoch: number) => boolean,
): void {
  if (room === null || canSendInput === undefined || !canSendInput(room, authorityEpoch)) return;
  // Promise.resolve wraps the call so .catch is safe even if sendInputEvent is
  // mocked to return a non-Promise (matches livekit-latency-ping's guard).
  void Promise.resolve(sendInputEvent(room, { type: 'keyDown', key })).catch(() => undefined);
  if (!canSendInput(room, authorityEpoch)) return;
  void Promise.resolve(sendInputEvent(room, { type: 'keyUp', key })).catch(() => undefined);
}

/**
 * The on-screen iOS keyboard. Renders the active layer, manages GUI-local shift
 * state, and emits keyDown/keyUp InputEvents over the LiveKit room exactly like
 * the host-keyboard path.
 */
export function IOSKeyboard({
  room,
  width = 402,
  onDismiss,
  authorityEpoch = 0,
  canSendInput,
}: IOSKeyboardProps): JSX.Element {
  const [layer, setLayer] = useState<KeyboardLayer>('letters');
  const [shift, setShift] = useState<ShiftState>('off');
  // The currently-pressed CHARACTER key for the iOS pop-up magnifier: its stable
  // button IDENTITY (`ch`, layer-relative, shift-independent) + the cased GLYPH to
  // show in the balloon, both captured at press. Keyed by identity — NOT the
  // shift-cased `sent` value — because a one-shot-shift press consumes the shift
  // in the same render, so a sent-value match ('Q' set at press vs a recomputed
  // 'q' at render) went false and the balloon never appeared for a shifted
  // letter. The frozen glyph keeps the balloon showing the UPPERCASE letter even
  // after the shift reverts. Function keys get a press highlight, not a pop-up.
  const [poppedKey, setPoppedKey] = useState<{ id: string; glyph: string } | null>(null);
  // Last shift-tap timestamp, for the double-tap → caps-lock detection.
  const lastShiftTap = useRef(0);
  const ownsAuthority = useCallback(
    (): boolean =>
      room !== null && canSendInput !== undefined && canSendInput(room, authorityEpoch),
    [room, canSendInput, authorityEpoch],
  );
  useEffect(() => {
    // Layer/shift/popover state belongs to one exact control epoch. An old local-only
    // Shift/123 handler must not influence the next valid key under a new owner.
    setLayer('letters');
    setShift('off');
    setPoppedKey(null);
    lastShiftTap.current = 0;
  }, [authorityEpoch, room]);

  // Send a character keypress, honoring shift, then consume a one-shot shift.
  const onCharPress = useCallback(
    (ch: string): void => {
      if (!ownsAuthority()) return;
      const key = keyForChar(ch, layer === 'letters' ? shift : 'off');
      pressKey(room, key, authorityEpoch, canSendInput);
      // A non-shift keypress BREAKS the shift double-tap sequence: caps-lock is
      // "two shift taps IN A ROW". Without clearing this, fast-typing an acronym
      // like "AB" (shift → a → shift, all within 300ms) had the second shift see
      // the FIRST shift's timestamp still within the window and falsely engage
      // caps-lock. Reset it so only two CONSECUTIVE shift taps lock. (Fable GUI
      // re-audit 2026-07-02.)
      lastShiftTap.current = 0;
      // One-shot shift reverts after a single letter (iOS); caps-lock persists.
      if (layer === 'letters' && shift === 'once') setShift('off');
    },
    [room, layer, shift, authorityEpoch, canSendInput, ownsAuthority],
  );

  // Shift: single tap toggles one-shot on/off; a second tap within DOUBLE_TAP_MS
  // engages caps-lock; tapping while locked releases it. GUI-local — no event is
  // sent for the shift tap itself.
  const onShiftTap = useCallback((): void => {
    if (!ownsAuthority()) return;
    const now = Date.now();
    const isDouble = now - lastShiftTap.current <= DOUBLE_TAP_MS;
    setShift((prev) => {
      // A tap that RELEASES caps-lock must NOT seed the double-tap window: it is
      // the end of a sequence, not the start of one. Otherwise unlock → quick
      // shift tap (intending one-shot) sees this timestamp within 300ms and
      // isDouble re-engages caps-lock. Mirror onCharPress's reset-to-0. (Fable
      // GUI re-audit fix.)
      lastShiftTap.current = prev === 'locked' ? 0 : now;
      if (prev === 'locked') return 'off';
      if (isDouble) return 'locked';
      return prev === 'once' ? 'off' : 'once';
    });
  }, [ownsAuthority]);

  // Named keys mirror the host path's `e.key` values exactly. Each is a NON-shift
  // keypress, so it must BREAK the shift double-tap sequence (mirror onCharPress's
  // `lastShiftTap.current = 0` at L155): without this reset, a fast
  // shift → space/return/delete → shift within DOUBLE_TAP_MS lets the SECOND shift see
  // the FIRST shift's timestamp still inside the window and falsely engage caps-lock
  // (e.g. shift → space → shift wrongly LOCKS instead of arming a one-shot). Only
  // char presses reset it before; these named keys did not. (Keyboard audit w8cp0yp5d
  // 2026-07-11.)
  const onReturn = useCallback((): void => {
    if (!ownsAuthority()) return;
    lastShiftTap.current = 0;
    pressKey(room, 'Enter', authorityEpoch, canSendInput);
  }, [room, authorityEpoch, canSendInput, ownsAuthority]);
  const onDelete = useCallback((): void => {
    if (!ownsAuthority()) return;
    lastShiftTap.current = 0;
    pressKey(room, 'Backspace', authorityEpoch, canSendInput);
  }, [room, authorityEpoch, canSendInput, ownsAuthority]);
  const onSpace = useCallback((): void => {
    if (!ownsAuthority()) return;
    lastShiftTap.current = 0;
    pressKey(room, ' ', authorityEpoch, canSendInput);
  }, [room, authorityEpoch, canSendInput, ownsAuthority]);
  const selectLayer = useCallback(
    (next: KeyboardLayer): void => {
      if (ownsAuthority()) setLayer(next);
    },
    [ownsAuthority],
  );

  const charRows =
    layer === 'letters' ? LETTER_ROWS : layer === 'numbers' ? NUMBER_ROWS : SYMBOL_ROWS;
  // iPhone keyboards scale with the device CSS width; clamp to a sane min so a
  // narrow archetype still renders legibly.
  const padX = Math.max(2, Math.round(width * 0.008));

  return (
    <div
      data-component="ios-keyboard"
      data-layer={layer}
      data-shift={shift}
      // Light iOS keyboard background. pointer-events stay on (it's the keyboard);
      // it sits BELOW the video as chrome, so it doesn't intercept video taps.
      className="flex w-full select-none flex-col gap-[6px] bg-[#d1d4db] px-[3px] pb-[6px] pt-[8px]"
      style={{ paddingLeft: padX, paddingRight: padX }}
      // Keep window-drag off the keyboard (its keys must receive presses).
      data-tauri-drag-region="false"
    >
      {/* Character rows. Letters row 2 (asdf…) + row 3 (zxc…) are inset like iOS;
          row 3 is flanked by shift (left) + delete (right). */}
      {charRows.map((row, rowIndex) => {
        const isLastCharRow = rowIndex === charRows.length - 1;
        return (
          <div key={rowIndex} className="flex w-full items-stretch justify-center gap-[6px]">
            {/* Row 3 left flank: shift (letters) / #+= (numbers) / 123 (symbols). */}
            {isLastCharRow && layer === 'letters' && (
              <FnKey
                label="⇧"
                ariaLabel={shift === 'locked' ? 'Caps lock on' : 'Shift'}
                wide
                active={shift !== 'off'}
                locked={shift === 'locked'}
                onPress={onShiftTap}
              />
            )}
            {isLastCharRow && layer === 'numbers' && (
              <FnKey label="#+=" ariaLabel="Symbols" wide onPress={() => selectLayer('symbols')} />
            )}
            {isLastCharRow && layer === 'symbols' && (
              <FnKey label="123" ariaLabel="Numbers" wide onPress={() => selectLayer('numbers')} />
            )}

            {row.map((ch) => {
              const shown = layer === 'letters' ? applyShift(ch, shift) : ch;
              return (
                <CharKey
                  key={ch}
                  label={shown}
                  popped={poppedKey?.id === ch}
                  popLabel={poppedKey?.id === ch ? poppedKey.glyph : shown}
                  onDown={() => {
                    if (!ownsAuthority()) return;
                    setPoppedKey({ id: ch, glyph: shown });
                    onCharPress(ch);
                  }}
                  onUp={() => {
                    if (ownsAuthority()) setPoppedKey(null);
                  }}
                />
              );
            })}

            {/* Row 3 right flank: delete on every layer's last char row. */}
            {isLastCharRow && (
              <FnKey
                label="⌫"
                ariaLabel="Delete"
                wide
                onPress={onDelete}
                repeatOnHold
                authorityEpoch={authorityEpoch}
                canRepeat={ownsAuthority}
              />
            )}
          </div>
        );
      })}

      {/* Bottom row: 123/ABC layer switch · 😀 emoji · space (widest) · return. */}
      <div className="flex w-full items-stretch justify-center gap-[6px]">
        {layer === 'letters' ? (
          <FnKey
            label="123"
            ariaLabel="Numbers and symbols"
            flex={1.6}
            onPress={() => selectLayer('numbers')}
          />
        ) : (
          <FnKey
            label="ABC"
            ariaLabel="Letters"
            flex={1.6}
            onPress={() => selectLayer('letters')}
          />
        )}
        {/* iOS bottom-row emoji key, left of the spacebar. The default single-
            keyboard iPhone shows 😀 here (the 🌐 globe appears only with ≥2
            keyboards installed). There is no emoji panel and inserting an emoji
            via a synthetic `key` event isn't how iOS does it (it would be a
            fingerprint divergence), so this stays a no-op. Rendered `disabled`
            so it reads as inactive (dimmed, no press flash) instead of a working
            key that flashes but does nothing — a dead key that invites a tap is
            worse than an obviously-inert one. */}
        <FnKey label="😀" ariaLabel="Emoji" flex={1} onPress={() => {}} disabled />
        {onDismiss !== undefined && (
          <FnKey
            label="⌄"
            ariaLabel="Hide keyboard"
            flex={1.2}
            onPress={() => {
              if (ownsAuthority()) onDismiss();
            }}
          />
        )}
        <button
          type="button"
          aria-label="Space"
          data-key="space"
          onPointerDown={(e) => {
            e.preventDefault();
            onSpace();
          }}
          className="h-[42px] grow rounded-[5px] bg-white text-[13px] text-[#1c1c1e] shadow-[0_1px_0_rgba(0,0,0,0.28)] active:bg-[#e6e7ea]"
          style={{ flexGrow: 5 }}
        >
          space
        </button>
        <FnKey label="return" ariaLabel="Return" flex={2} onPress={onReturn} />
      </div>
    </div>
  );
}

/** A white character key with the iOS press pop-up magnifier. pointerdown drives
 *  the keypress (iOS registers on press, not release) + shows the pop-up; release
 *  dismisses it. */
function CharKey({
  label,
  popped,
  popLabel,
  onDown,
  onUp,
}: {
  label: string;
  popped: boolean;
  /** Glyph shown in the pop-up balloon — frozen at press so a one-shot-shift
   *  letter's balloon stays uppercase after the shift reverts. Defaults to label. */
  popLabel?: string;
  onDown: () => void;
  onUp: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-key={label}
      data-key-kind="char"
      aria-label={label}
      onPointerDown={(e) => {
        // Prevent the press from stealing focus / starting a window drag.
        e.preventDefault();
        onDown();
      }}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      className="relative h-[42px] min-w-0 grow basis-0 rounded-[5px] bg-white text-[17px] leading-none text-[#1c1c1e] shadow-[0_1px_0_rgba(0,0,0,0.28)] transition-colors active:bg-[#e6e7ea]"
    >
      {label}
      {/* iOS key pop-up magnifier — the enlarged glyph balloon above the pressed
          key. Character keys only (no pop-up for function keys), matching iOS. */}
      {popped && (
        <span
          data-component="key-popup"
          aria-hidden="true"
          className="pointer-events-none absolute -top-[44px] left-1/2 z-30 flex h-[48px] w-[44px] -translate-x-1/2 items-center justify-center rounded-[10px] bg-white text-[26px] leading-none text-[#1c1c1e] shadow-[0_3px_8px_rgba(0,0,0,0.35)]"
        >
          {popLabel ?? label}
        </span>
      )}
    </button>
  );
}

/** A grey function key (shift/delete/123/ABC/#+=/space-switch/emoji/return). No
 *  pop-up magnifier (iOS shows it for character keys only). `wide` gives shift/
 *  delete their ~1.5-unit width; `flex` overrides the grow weight for the bottom-
 *  row keys. `accent` paints a key blue — currently unused (return is grey by
 *  default like real iOS on a generic field); reserved for the future
 *  enterkeyhint Go/Search/Send signal that re-enables the blue return. */
function FnKey({
  label,
  ariaLabel,
  onPress,
  wide,
  flex,
  accent,
  active,
  locked,
  disabled,
  repeatOnHold,
  authorityEpoch = 0,
  canRepeat,
}: {
  label: string;
  ariaLabel: string;
  onPress: () => void;
  wide?: boolean;
  flex?: number;
  accent?: boolean;
  active?: boolean;
  locked?: boolean;
  /** Render the key inert: dimmed, no press flash, not interactive. Used for
   *  keys present for iPhone-faithful layout that have no backing action yet
   *  (the bottom-row emoji key) so they don't invite a tap that does nothing. */
  disabled?: boolean;
  /** iPhone-faithful press-and-hold repeat. Only the delete key sets this: hold
   *  fires onPress once immediately, then repeats at an accelerating cadence
   *  until pointer up/leave/cancel (or unmount). Letters/space must NOT set it
   *  (real iOS shows an accent picker / cursor trackpad there instead). */
  repeatOnHold?: boolean;
  /** Cancels a repeat admitted under a replaced manual-control epoch. */
  authorityEpoch?: number;
  /** Exact epoch predicate captured by the pointerdown that owns this repeat. */
  canRepeat?: () => boolean;
}): JSX.Element {
  // Held-repeat timer. Kept in a ref so pointer up/leave/cancel and unmount can
  // all cancel the same in-flight timeout chain.
  const repeatTimerRef = useRef<number | null>(null);
  const stopRepeat = useCallback((): void => {
    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
  }, []);

  const beginRepeat = useCallback((): void => {
    // Cancel any in-flight repeat chain before arming a new one. A second
    // pointerdown without an intervening pointerup (stray second pointer, pen+
    // touch, synthetic replay) would otherwise leave the FIRST tick() chain
    // orphaned: repeatTimerRef only tracks the latest timeout, so the eventual
    // stopRepeat cancels only the second chain and the first keeps firing
    // Backspace forever. Exactly one live chain per key. (Fable GUI re-audit fix.)
    stopRepeat();
    let interval = KEY_REPEAT_START_MS;
    const tick = (): void => {
      if (canRepeat === undefined || !canRepeat()) {
        stopRepeat();
        return;
      }
      // Capture the exact epoch's handler. A newer render must never lend its
      // Room/authority to an older retained pointerdown timer.
      onPress();
      if (!canRepeat()) {
        stopRepeat();
        return;
      }
      interval = Math.max(KEY_REPEAT_MIN_MS, interval - KEY_REPEAT_ACCEL_MS);
      repeatTimerRef.current = window.setTimeout(tick, interval);
    };
    repeatTimerRef.current = window.setTimeout(tick, KEY_REPEAT_INITIAL_MS);
  }, [stopRepeat, onPress, canRepeat]);

  // Cancel any pending repeat if the key unmounts mid-hold (e.g. layout swaps to
  // the symbols page) so it can't keep firing Backspace into a torn-down view.
  useEffect(() => {
    stopRepeat();
    return stopRepeat;
  }, [stopRepeat, authorityEpoch]);
  // Grey function keys (#aeb3bd-ish); accent → blue is reserved (return is grey by
  // default like real iOS). Caps-locked shift gets a white highlight (iOS lights
  // the shift key); one-shot shift a lighter grey.
  const base = accent
    ? 'bg-[#0a84ff] text-white'
    : locked
      ? 'bg-white text-[#1c1c1e]'
      : active
        ? 'bg-[#e9ebef] text-[#1c1c1e]'
        : 'bg-[#aeb3bd] text-[#1c1c1e]';
  return (
    <button
      type="button"
      data-key={label}
      // Keep the return key semantically "return" even though it now renders grey
      // (real iOS shows grey 'return' on a generic field; accent/blue is reserved
      // for a future enterkeyhint Go/Search/Send signal). Color and kind are
      // decoupled: ariaLabel pins the kind, accent only paints.
      data-key-kind={ariaLabel === 'Return' ? 'return' : accent ? 'return' : 'fn'}
      data-active={active ? 'true' : undefined}
      data-locked={locked ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        if (disabled === true) return;
        if (repeatOnHold === true && (canRepeat === undefined || !canRepeat())) return;
        onPress();
        if (repeatOnHold === true) beginRepeat();
      }}
      onPointerUp={repeatOnHold === true ? stopRepeat : undefined}
      onPointerLeave={repeatOnHold === true ? stopRepeat : undefined}
      onPointerCancel={repeatOnHold === true ? stopRepeat : undefined}
      // A disabled key is dimmed and drops the active:brightness-95 press flash
      // so it visibly reads as inert rather than a working key that flashes.
      className={`flex h-[42px] min-w-0 items-center justify-center rounded-[5px] text-[15px] leading-none shadow-[0_1px_0_rgba(0,0,0,0.28)] transition-colors ${
        disabled === true ? 'cursor-default opacity-40' : 'active:brightness-95'
      } ${base}`}
      style={{
        flexGrow: flex ?? (wide ? 1.5 : 1),
        flexBasis: 0,
      }}
    >
      {label}
    </button>
  );
}
