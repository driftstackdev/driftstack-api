import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { installLogCapture } from './lib/log-buffer';
import { isBenignTeardownError } from './lib/livekit-errors';
import './styles/index.css';

// The floating-iPhone simulator opens as a separate Tauri window pointed at
// `?window=simulator` (bare device, no app chrome). Computed up front so the log
// mirror is per-window from the very first line (#137).
const isSimulatorWindow =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('window') === 'simulator';

// GUI W232 item (d) — capture console.* + uncaught errors into the in-app dev
// log buffer from the very first line, so startup logs are retained. Idempotent.
// #137 — the simulator mirrors to its OWN dev-log-simulator.txt so a simulator
// self-close leaves a crash trail the main window can't overwrite.
installLogCapture(isSimulatorWindow ? '-simulator' : '');

// ── Fail-visible bootstrap (architectural: the app must NEVER silently
// fail to open). Any startup, render, or async error renders a VISIBLE,
// copyable error panel WITH A CODE instead of a blank/flickering window.
// Uses inline styles + direct DOM so it works even when the CSS bundle or
// React itself failed to load. The panel is a fixed overlay appended to
// <body> (it does NOT clobber #root), so it can't fight React's tree.

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

declare global {
  interface Window {
    __dsFatalShown?: boolean;
    /** Set once the React tree has successfully committed (RootErrorBoundary
     *  componentDidMount). After this, the global error handlers treat late async
     *  errors as non-fatal notices instead of the latched full-screen overlay. */
    __dsBooted?: boolean;
  }
}

function renderFatalError(code: string, err: unknown): void {
  // First error wins — shared flag dedupes with the index.html early guard.
  if (window.__dsFatalShown) return;
  window.__dsFatalShown = true;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
  try {
    const box = document.createElement('div');
    box.setAttribute('data-fatal-error', code);
    // Drag-region so that if a fatal overlay ever paints in the BORDERLESS
    // simulator window (no title bar), the user can still move it instead of
    // being stuck with an unmovable box (founder-hit 2026-06-18). The Reload
    // button opts out below so it stays clickable.
    box.setAttribute('data-tauri-drag-region', '');
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#0b0b0b;color:#eee;' +
      'font:13px/1.55 -apple-system,system-ui,sans-serif;padding:28px;overflow:auto;';
    // Friendly-first: lead with plain human copy + a Reload action, and tuck the
    // code/message/stack behind a collapsed "Show technical details" disclosure so
    // an end user never faces a raw stack trace (founder: no dev output in the
    // operator's face). The details survive for support — native <details>, no JS.
    box.innerHTML =
      '<div style="max-width:640px;margin:12vh auto 0">' +
      '<h1 style="font-size:17px;color:#eee;margin:0 0 8px">Driftstack hit a snag</h1>' +
      '<div style="color:#9a9a9a;margin:0 0 20px">The app needs to reload to recover. ' +
      'Your saved profiles and sessions are safe.</div>' +
      '<button id="ds-fatal-reload" data-tauri-drag-region="false" ' +
      'style="background:#c0392b;color:#fff;border:none;border-radius:7px;padding:9px 18px;' +
      'cursor:pointer;font-size:13px;font-weight:600">Reload Driftstack</button>' +
      '<details data-tauri-drag-region="false" style="margin-top:22px">' +
      '<summary data-tauri-drag-region="false" style="cursor:pointer;font-size:12px;' +
      'color:#888;user-select:none;outline:none">Show technical details</summary>' +
      '<div style="color:#888;margin:10px 0 0">Error code: <b style="color:#ffb86b">' +
      escapeHtml(code) +
      '</b></div>' +
      '<div style="background:#161616;border:1px solid #333;border-radius:8px;padding:10px 12px;' +
      'margin:8px 0 0;color:#bbb;font-size:12px">' +
      escapeHtml(message || '(no message)') +
      '</div>' +
      (stack
        ? '<pre style="white-space:pre-wrap;word-break:break-word;color:#8a8a8a;background:#111;' +
          'border:1px solid #2a2a2a;border-radius:8px;padding:10px;font-size:11px;max-height:38vh;' +
          'overflow:auto;margin:8px 0 0">' +
          escapeHtml(stack) +
          '</pre>'
        : '') +
      '</details>' +
      '</div>';
    document.body.appendChild(box);
    document
      .getElementById('ds-fatal-reload')
      ?.addEventListener('click', () => window.location.reload());
  } catch {
    // Absolute last resort if even DOM injection fails.
    document.title = 'Driftstack error ' + code + ': ' + message;
  }
}

// A transient, NON-latching notice (auto-dismisses; direct-DOM so it works in the
// bare simulator window with no app chrome). Surfaces a post-boot hiccup WITHOUT
// the latched full-screen fatal overlay that would brick a live session.
function showTransientNotice(message: string): void {
  try {
    // Keep only the latest so repeated rejections can't stack a wall of toasts.
    document.querySelectorAll('[data-transient-notice]').forEach((n) => n.remove());
    const note = document.createElement('div');
    note.setAttribute('data-transient-notice', '');
    note.style.cssText =
      'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483646;' +
      'max-width:80vw;background:#161616;color:#eee;border:1px solid #3a3a3a;border-radius:8px;' +
      'padding:9px 14px;font:12px/1.45 -apple-system,system-ui,sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease';
    note.textContent =
      'Something hiccuped, but your session is still running' + (message ? ` — ${message}` : '');
    document.body.appendChild(note);
    requestAnimationFrame(() => {
      note.style.opacity = '1';
    });
    window.setTimeout(() => {
      note.style.opacity = '0';
      window.setTimeout(() => note.remove(), 250);
    }, 5000);
  } catch {
    // A notice must never itself throw back into the error handler.
  }
}

// Post-boot degradation: log to the captured dev-log (the crash trail) + a
// transient notice, but NEVER the latched fatal overlay.
function reportNonFatal(code: string, reason: unknown): void {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  console.error(`[${code}] non-fatal after boot:`, reason);
  showTransientNotice(message);
}

// Catch async errors + unhandled promise rejections (e.g. a failed API/keychain
// call that nothing awaited) so they surface instead of leaving a dead UI.
//
// TWO-PHASE policy (founder "GUI keeps getting stuck, nobody can work on it"; A3
// sweep 2026-07-10). The fatal overlay exists to make a BOOT failure visible — but
// once the app has successfully mounted (__dsBooted), a stray async rejection is
// almost never a "can't start" condition, and painting the LATCHED full-screen
// overlay over a live session bricks a working app until Reload. So:
//   • benign LiveKit/WebRTC teardown races → swallowed outright (shared
//     isBenignTeardownError — one source of truth, can't drift from the sender);
//   • any other async error PRE-boot → the coded fatal panel (real startup failure);
//   • any other async error POST-boot → downgraded to a non-fatal notice + log.
// A genuine render-tree failure still routes through RootErrorBoundary →
// renderFatalError (the app really is blank then), so this only relaxes the
// async/uncaught paths that don't break the running tree.
window.addEventListener('error', (e) => {
  const reason: unknown = e.error ?? e.message;
  if (isBenignTeardownError(reason)) return;
  if (window.__dsBooted) {
    reportNonFatal('WINDOW_ERROR', reason);
    return;
  }
  renderFatalError('WINDOW_ERROR', reason);
});
window.addEventListener('unhandledrejection', (e) => {
  if (isBenignTeardownError(e.reason)) {
    e.preventDefault();
    return;
  }
  if (window.__dsBooted) {
    e.preventDefault();
    reportNonFatal('UNHANDLED_REJECTION', e.reason);
    return;
  }
  renderFatalError('UNHANDLED_REJECTION', e.reason);
});

// Catch render-tree errors so a broken component shows the error, not a blank.
class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    renderFatalError('RENDER_ERROR', error);
  }
  override componentDidMount(): void {
    // Mark the app booted once the tree has committed successfully, so the global
    // handlers downgrade later async errors to a non-fatal notice instead of the
    // latched overlay. Gated on NOT being failed: a child that throws during
    // initial mount sets `failed` (getDerivedStateFromError) BEFORE this fires, so
    // a boot failure is never mis-marked as booted.
    if (!this.state.failed) window.__dsBooted = true;
  }
  override render(): ReactNode {
    // The fixed overlay owns the screen on failure; render nothing here.
    return this.state.failed ? null : this.props.children;
  }
}

async function mountApplication(root: HTMLElement): Promise<void> {
  if (isSimulatorWindow) {
    const [{ SimulatorWindow }, { RecordingsProvider }] = await Promise.all([
      import('./views/SimulatorWindow'),
      import('./lib/recordings'),
    ]);
    createRoot(root).render(
      <StrictMode>
        <RootErrorBoundary>
          {/* RecordingsProvider here too: the simulator's Record pill writes
              through the same Rust-side shared store as the main window. */}
          <RecordingsProvider>
            <SimulatorWindow />
          </RecordingsProvider>
        </RootErrorBoundary>
      </StrictMode>,
    );
    return;
  }

  const [{ App }, { ConfirmProvider }, { DevLogPanel }] = await Promise.all([
    import('./App'),
    import('./components/ConfirmProvider'),
    import('./components/DevLogPanel'),
  ]);
  createRoot(root).render(
    <StrictMode>
      <RootErrorBoundary>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </RootErrorBoundary>
      {/* Outside the error boundary: the dev-log panel stays available even if
          the App tree throws (so you can read what failed). */}
      <DevLogPanel />
    </StrictMode>,
  );
}

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root element missing from index.html');
  // The floating-iPhone simulator opens as a separate Tauri window pointed at
  // `?window=simulator` — that window renders ONLY the device (no app chrome).
  // Reuses the value computed up front for the per-window log mirror (#137).
  if (isSimulatorWindow) {
    // The window is `transparent: true` — make the webview see-through so only
    // the device frame paints (the body otherwise fills it with bg-surface-base).
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    root.style.background = 'transparent';
    // SettingsContext (the only other place that sets these theme tokens) never
    // mounts in this bare window, so without this the dark/accent tokens fall
    // back to a light/empty default. Pin the dark + oxblood theme up front so the
    // device chrome reads correctly.
    document.documentElement.dataset.mode = 'dark';
    document.documentElement.dataset.accent = 'oxblood';
  }
  void mountApplication(root).catch((err: unknown) => renderFatalError('BOOT_EXCEPTION', err));
} catch (err) {
  renderFatalError('BOOT_EXCEPTION', err);
}
