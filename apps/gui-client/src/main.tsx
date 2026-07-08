import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SimulatorWindow } from './views/SimulatorWindow';
import { RecordingsProvider } from './lib/recordings';
import { ConfirmProvider } from './components/ConfirmProvider';
import { DevLogPanel } from './components/DevLogPanel';
import { installLogCapture } from './lib/log-buffer';
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
    box.innerHTML =
      '<div style="max-width:720px;margin:0 auto">' +
      '<h1 style="font-size:16px;color:#ff6b6b;margin:0 0 4px">Driftstack couldn’t start</h1>' +
      '<div style="color:#888;margin:0 0 18px">Error code: <b style="color:#ffb86b">' +
      escapeHtml(code) +
      '</b></div>' +
      '<div style="background:#161616;border:1px solid #333;border-radius:8px;padding:12px 14px;margin:0 0 12px"><b>' +
      escapeHtml(message || '(no message)') +
      '</b></div>' +
      (stack
        ? '<pre style="white-space:pre-wrap;word-break:break-word;color:#9aa;background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:11px;max-height:45vh;overflow:auto">' +
          escapeHtml(stack) +
          '</pre>'
        : '') +
      '<button id="ds-fatal-reload" data-tauri-drag-region="false" style="margin-top:16px;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:6px;padding:8px 16px;cursor:pointer">Reload</button>' +
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

// Catch async errors + unhandled promise rejections (e.g. a failed API/keychain
// call that nothing awaited) so they surface instead of leaving a dead UI.
window.addEventListener('error', (e) => renderFatalError('WINDOW_ERROR', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => {
  // Benign LiveKit/WebRTC teardown races — a publish or connect that resolves
  // AFTER the Room's RTCEngine closed rejects with "PC manager is closed" (and
  // similar). These are harmless and must NOT blank the app: founder-hit
  // 2026-06-18, an un-caught latency-ping publish in the borderless simulator
  // window painted the fatal overlay over the iPhone → an undraggable black box
  // → force-quit. Swallow them; everything else stays fatal.
  const reasonMessage = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
  if (/PC manager is closed|client initiated disconnect|engine (is )?closed/i.test(reasonMessage)) {
    e.preventDefault();
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
  override render(): ReactNode {
    // The fixed overlay owns the screen on failure; render nothing here.
    return this.state.failed ? null : this.props.children;
  }
}

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root element missing from index.html');
  // The floating-iPhone simulator opens as a separate Tauri window pointed at
  // `?window=simulator` — that window renders ONLY the device (no app chrome).
  // Reuses the value computed up front for the per-window log mirror (#137).
  const isSimulator = isSimulatorWindow;
  if (isSimulator) {
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
  createRoot(root).render(
    <StrictMode>
      <RootErrorBoundary>
        {isSimulator ? (
          // RecordingsProvider here too: the simulator's Record pill writes
          // through the same Rust-side shared store as the main window.
          <RecordingsProvider>
            <SimulatorWindow />
          </RecordingsProvider>
        ) : (
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        )}
      </RootErrorBoundary>
      {/* Outside the error boundary: the dev-log panel stays available even if
          the App tree throws (so you can read what failed). Not in the bare
          simulator window. */}
      {!isSimulator && <DevLogPanel />}
    </StrictMode>,
  );
} catch (err) {
  renderFatalError('BOOT_EXCEPTION', err);
}
