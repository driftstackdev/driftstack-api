// Owner item 4 (2026-09-24): "I can right click on the simulator which I think
// should be removed. which shows options such as; show all controls, save video
// frame as.. we either rework whatever is shown here to make it more user
// friendly with whatever is nice to have there, or we remove being able to
// right click it and get these options, your choice, do as recommended"
//
// ROOT CAUSE. The phone's screen is a <video> element, and a right-click on it
// opened the web view's own menu for a video: Show All Controls, Save Video
// Frame As…, Picture in Picture, full screen. Nothing in the window handled
// `contextmenu`. Elsewhere in the window the same menu offered Reload, which
// reloads the Simulator window itself and drops its session.
//
// DECISION: suppress it and add nothing. Every item in that menu is about the
// video element, not the phone — it either breaks the picture of a device
// (video controls over the screen) or duplicates, worse, what the toolbar
// already does properly (Screenshot, Record). A real iPhone has no right-click;
// the phone's own gesture for "more" is a long press, which the phone handles.
// A custom menu would be a third way to do what the toolbar and the phone
// already do, so it earns no place.
//
// The one exception is a text field (the address bar, the chat box): there the
// native menu is Cut / Copy / Paste, which a customer does need.

/** True when the native menu is useful here — inside an editable text field. */
export function nativeContextMenuAllowed(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  const editable = target.closest('input, textarea, [contenteditable]');
  if (editable === null) return false;
  if (editable instanceof HTMLInputElement) {
    // Only the text-like inputs have a Cut / Copy / Paste menu worth keeping.
    return ![
      'button',
      'checkbox',
      'radio',
      'range',
      'color',
      'file',
      'image',
      'reset',
      'submit',
    ].includes(editable.type);
  }
  if (editable instanceof HTMLTextAreaElement) return true;
  // `[contenteditable="false"]` is the one spelling that means "not editable".
  return (editable.getAttribute('contenteditable') ?? '').toLowerCase() !== 'false';
}

/** The window's `contextmenu` handler: suppress everywhere but a text field. */
export function suppressNativeContextMenu(e: {
  target: EventTarget | null;
  preventDefault: () => void;
}): void {
  if (!nativeContextMenuAllowed(e.target)) e.preventDefault();
}
