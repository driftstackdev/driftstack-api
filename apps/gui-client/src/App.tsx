// App shell — the GUI's outer chrome. The first commit (GUI1) only
// puts the shell in place + applies the brand identity. Real
// functionality (session manager, viewport, proxy management, etc.)
// lands in GUI2 onwards.

export function App(): JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col bg-surface-base">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-surface-base">
          <PlaceholderPanel />
        </main>
      </div>
      <StatusFooter />
    </div>
  );
}

// ─── chrome ───────────────────────────────────────────────────────

function TitleBar(): JSX.Element {
  return (
    <div
      // Tauri custom-titlebar drag region. The user can drag the
      // window from this surface; child elements with `data-tauri-no-drag`
      // (e.g. real interactive controls) opt out.
      data-tauri-drag-region="true"
      className="flex h-9 select-none items-center justify-between
                 border-b border-surface-divider bg-surface-raised px-3"
    >
      <div className="flex items-center gap-2">
        {/* Brand mark — placeholder square; the real glyph swaps in
            once the brand assets ship. */}
        <div className="h-3.5 w-3.5 rounded-sm bg-accent" />
        <span className="text-sm font-medium text-ink-primary">Driftstack</span>
        <span className="mono text-ink-muted">·</span>
        <span className="mono text-ink-secondary">self-hosted</span>
      </div>
      <div className="flex items-center gap-2 text-ink-muted">
        <span className="section-label">v0.0.1</span>
      </div>
    </div>
  );
}

function Sidebar(): JSX.Element {
  return (
    <aside
      className="flex w-56 flex-col border-r border-surface-divider
                 bg-surface-raised"
    >
      <SidebarSection label="Sessions">
        <SidebarItem active>Active</SidebarItem>
        <SidebarItem>History</SidebarItem>
        <SidebarItem>Recordings</SidebarItem>
      </SidebarSection>
      <SidebarSection label="Network">
        <SidebarItem>Proxies</SidebarItem>
        <SidebarItem>Connectivity test</SidebarItem>
      </SidebarSection>
      <SidebarSection label="Cluster">
        <SidebarItem>Mac mini fleet</SidebarItem>
        <SidebarItem>Settings</SidebarItem>
      </SidebarSection>
    </aside>
  );
}

function SidebarSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-px py-2">
      <div className="px-3 py-1">
        <span className="section-label">{label}</span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SidebarItem({
  children,
  active,
}: {
  children: React.ReactNode;
  active?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      data-tauri-no-drag
      className={
        'flex items-center gap-2 px-3 py-1 text-sm transition-colors ' +
        (active === true
          ? 'bg-accent-subtle text-ink-primary'
          : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary')
      }
    >
      {children}
    </button>
  );
}

function PlaceholderPanel(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8">
      <div className="section-label">GUI1 — scaffold</div>
      <p className="max-w-md text-center text-sm text-ink-secondary">
        Tauri shell, Tailwind brand identity, and the React skeleton are in place. Session manager,
        live viewport, manual control, SOCKS5 proxy management, and recording all land in GUI2 →
        GUI8.
      </p>
      <div className="flex gap-2 pt-2">
        <button type="button" className="btn-primary" disabled>
          New session
        </button>
        <button type="button" className="btn-secondary" disabled>
          Connect to fleet
        </button>
      </div>
    </div>
  );
}

function StatusFooter(): JSX.Element {
  return (
    <footer
      className="flex h-6 items-center justify-between border-t
                 border-surface-divider bg-surface-raised px-3
                 text-2xs text-ink-muted"
    >
      <div className="flex items-center gap-2">
        <span className="status-pip bg-status-idle" />
        <span>not connected</span>
      </div>
      <div className="mono">localhost:7780 · 0 sessions</div>
    </footer>
  );
}
