// Deep-audit LOW: drilling into the recording player ('recording-player') left
// no sidebar item highlighted — that kind isn't a sidebar entry, so the old
// `view.kind as SidebarViewKind` cast matched nothing. sidebarSectionFor() folds
// the drilled-in sub-view onto its parent section so the nav keeps its "you are
// here" state. (The 'live-session' fold-in was dropped with the in-app session
// viewer — the floating Simulator window is the only live-session UI now.)

import { describe, it, expect, vi } from 'vitest';

// App.tsx pulls in Tauri-bound view modules at import time; stub the plugins so
// the module loads in the node test env (we only exercise a pure helper).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get(): Promise<null> {
      return Promise.resolve(null);
    }
    set(): Promise<void> {
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(() => Promise.resolve()) }));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

const { sidebarSectionFor } = await import('../../src/App');

describe('sidebarSectionFor — drilled-in sub-views keep their parent section lit', () => {
  it('maps recording-player → recordings', () => {
    expect(sidebarSectionFor({ kind: 'recording-player', recordingId: 'rec_1' })).toBe(
      'recordings',
    );
  });

  it('passes top-level views through unchanged', () => {
    expect(sidebarSectionFor({ kind: 'home' })).toBe('home');
    expect(sidebarSectionFor({ kind: 'profiles' })).toBe('profiles');
    expect(sidebarSectionFor({ kind: 'settings' })).toBe('settings');
    expect(sidebarSectionFor({ kind: 'sessions' })).toBe('sessions');
    expect(sidebarSectionFor({ kind: 'recordings' })).toBe('recordings');
  });
});
