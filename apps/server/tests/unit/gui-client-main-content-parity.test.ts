// W486.B — drift guard for apps/gui-client/src/main.tsx.
// React bootstrap entry, hardened into a FAIL-VISIBLE bootstrap (the desktop
// app must NEVER silently fail to open — every startup, render, or async
// error must surface a VISIBLE error panel WITH A CODE instead of a blank or
// flickering window). Drift here would re-introduce the silent-blank failure
// mode, so we pin:
//
//   • StrictMode stays at the top of the render tree (surfaces React
//     double-invoke / state-init purity violations).
//   • The render tree is StrictMode > RootErrorBoundary > ConfirmProvider >
//     App — the error boundary catches render-tree throws (RENDER_ERROR) and
//     the branded ConfirmProvider wraps the app (so useConfirm works
//     everywhere, replacing Tauri-flaky window.confirm).
//   • The root-element null-check throws loudly (BOOT_EXCEPTION) rather than
//     silently rendering nothing.
//   • styles import './styles/index.css' is the canonical Tailwind entry —
//     drift to a different path would silently drop all component styling.
//   • The fail-visible primitives stay present: renderFatalError, the
//     window 'error' / 'unhandledrejection' handlers, the createRoot try/catch,
//     and the four error codes. These are the architectural guarantee — if any
//     is dropped, a failure path goes back to a blank window with no code.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/main.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.B apps/gui-client/src/main.tsx content parity', () => {
  const body = read(LIB);

  it('Bootstrap imports pinned: StrictMode + Component/ReactNode, createRoot, and styles remain eager; App stays lazy in the main-window branch so simulator startup does not download main-app code', () => {
    expect(body).toMatch(/import \{ Component, StrictMode, type ReactNode \} from 'react';/);
    expect(body).toMatch(/import \{ createRoot \} from 'react-dom\/client';/);
    expect(body).toMatch(/import\('\.\/App'\)/);
    expect(body).toMatch(/import '\.\/styles\/index\.css';/);
  });

  it("Root element invariant: const root = document.getElementById('root') + a throwing null-check — pinned so a missing #root div fails loudly with a stack trace (surfaced as BOOT_EXCEPTION) instead of silently rendering nothing", () => {
    expect(body).toMatch(/const root = document\.getElementById\('root'\);/);
    expect(body).toMatch(
      /if \(!root\) throw new Error\('#root element missing from index\.html'\);/,
    );
  });

  it('Render trees pinned: each lazy branch renders StrictMode > RootErrorBoundary; simulator gets RecordingsProvider > SimulatorWindow, while main gets ConfirmProvider > App plus the resilient DevLogPanel', () => {
    expect(body).toMatch(/import\('\.\/components\/ConfirmProvider'\)/);
    expect(body).toMatch(/import\('\.\/views\/SimulatorWindow'\)/);
    expect(body).toMatch(/createRoot\(root\)\.render\(/);
    expect(body).toMatch(/<StrictMode>\s*<RootErrorBoundary>/);
    expect(body).toMatch(/<RecordingsProvider>\s*<SimulatorWindow \/>\s*<\/RecordingsProvider>/);
    expect(body).toMatch(/<ConfirmProvider>\s*<App \/>/);
    // DevLogPanel (GUI W232 d) renders OUTSIDE the error boundary but inside
    // StrictMode (gated off in the bare simulator window), so the dev-log view
    // survives an App-tree throw.
    expect(body).toMatch(/<\/RootErrorBoundary>[\s\S]*?<DevLogPanel \/>\s*<\/StrictMode>/);
  });

  it('Dev-log capture wired (GUI W232 d): installLogCapture stays eager and per-window; DevLogPanel stays lazy with the main app so simulator bootstrap remains small', () => {
    expect(body).toMatch(/import\('\.\/components\/DevLogPanel'\)/);
    expect(body).toMatch(/import \{ installLogCapture \} from '\.\/lib\/log-buffer';/);
    // #137 — the simulator window mirrors to its own dev-log-simulator.txt so a
    // self-close leaves a crash trail the main window can't overwrite. Pin the
    // per-window tag call so this can't silently regress back to a shared file.
    expect(body).toMatch(/installLogCapture\(isSimulatorWindow \? '-simulator' : ''\);/);
  });

  it('Fail-visible architecture pinned: renderFatalError + RootErrorBoundary + global error/unhandledrejection handlers + createRoot try/catch + the four error codes — pinned so no drift can re-introduce a silent blank/flicker on a startup, render, or async failure', () => {
    // The visible-panel renderer + the boundary that feeds it.
    expect(body).toMatch(/function renderFatalError\(code: string, err: unknown\): void \{/);
    expect(body).toMatch(/class RootErrorBoundary extends Component</);
    expect(body).toMatch(/static getDerivedStateFromError\(\)/);
    // Async + global failure surfaces (a failed keychain/API call that nothing
    // awaited would otherwise leave a dead UI).
    expect(body).toMatch(/window\.addEventListener\('error',/);
    expect(body).toMatch(/window\.addEventListener\('unhandledrejection',/);
    // The render itself is guarded so a synchronous boot throw is visible.
    expect(body).toMatch(/\} catch \(err\) \{\s*renderFatalError\('BOOT_EXCEPTION', err\);/);
    // All four codes must remain present and distinct.
    for (const code of ['WINDOW_ERROR', 'UNHANDLED_REJECTION', 'RENDER_ERROR', 'BOOT_EXCEPTION']) {
      expect(body).toContain(`'${code}'`);
    }
  });

  it('rendered crash diagnostics are sanitized while raw post-boot errors stay local-only', () => {
    expect(body).toContain("import { humanizeError } from './lib/humanize-error';");
    expect(body).toContain("import { sanitizeUiDiagnostic } from './lib/sanitize-ui-diagnostic';");
    expect(body).toMatch(/sanitizeUiDiagnostic\(rawMessage, '\(no additional details\)', 1_500\)/);
    expect(body).toMatch(/sanitizeUiDiagnostic\(rawStack, '', 6_000\)/);
    expect(body).toContain(
      "humanizeError(reason, 'Something went wrong. Please try the action again.')",
    );
    expect(body).toContain("document.title = 'Driftstack error ' + code;");
    expect(body).not.toMatch(/document\.title\s*=\s*[^;]+message/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
