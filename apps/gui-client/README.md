# Driftstack GUI client

Self-hosted desktop GUI for running modified-WebKit-fork sessions on your own hardware. Tauri (Rust backend) + React + TypeScript + Tailwind on the frontend.

> **Status:** GUI1 — scaffold only. Window shell, brand identity, and the React skeleton are in place. Session manager / live viewport / manual control / SOCKS5 proxy management / recording all land in GUI2 → GUI8.

## Stack

- **Tauri 2.x** — chosen over Electron for smaller bundle (~5–10 MB vs Electron's 80+ MB), Rust backend, and tighter security posture.
- **React 18 + TypeScript 5 strict** — same conventions as the rest of the monorepo.
- **Tailwind CSS** with the locked Driftstack brand identity (slate base, oxblood accent, Geist Sans body, Berkeley Mono technical accents).
- **macOS first** — primary target. Windows + Linux later.

## Develop

Prerequisites: Node 22+, Rust 1.95+ (`rustup` recommended), Xcode CLT for the macOS WebView shim.

```bash
cd apps/gui-client
npm install                         # JS deps
cargo fetch --manifest-path src-tauri/Cargo.toml   # Rust deps (one-time prefetch)

npm run tauri:dev                   # opens the desktop app with hot-reload
```

Frontend-only iteration (no native window, just a browser tab):

```bash
npm run dev
# → http://localhost:1420
```

Type-check + frontend build:

```bash
npm run typecheck
npm run build
```

Native bundle (.app + .dmg for macOS):

```bash
npm run tauri:build
# → src-tauri/target/release/bundle/{macos/Driftstack.app, dmg/...}
```

## Layout

```
apps/gui-client/
├── index.html                  # vite entry
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts          # brand identity tokens (locked)
├── postcss.config.js
├── src/                        # React frontend
│   ├── main.tsx                # mount
│   ├── App.tsx                 # shell (titlebar / sidebar / footer)
│   └── styles/index.css        # Tailwind layers + brand component classes
└── src-tauri/                  # Rust backend
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    └── src/
        ├── main.rs             # binary entry
        └── lib.rs              # backend; #[tauri::command] handlers land here
```

## Brand identity (locked per file 128)

| Token              | Value                             | Use                                   |
| ------------------ | --------------------------------- | ------------------------------------- |
| `surface-base`     | `#0b0f14` (slate-950-ish)         | Primary background                    |
| `surface-raised`   | `#111722`                         | Panels, sidebars, footers             |
| `surface-elevated` | `#1a2230`                         | Popovers, dropdowns, hover states     |
| `accent` (oxblood) | `#722f37`                         | Primary buttons, live indicators only |
| `ink-primary`      | `#e5e7eb`                         | Body text                             |
| `font-sans`        | Geist Sans → system-ui fallback   | UI / body                             |
| `font-mono`        | Berkeley Mono → JetBrains Mono fb | Session ids, command output, IPs      |

The brand atoms (`btn-primary`, `btn-secondary`, `btn-danger`, `mono`, `status-pip`, `section-label`) live in `src/styles/index.css` under `@layer components`.

## What's NOT in GUI1

- IPC `#[tauri::command]` handlers beyond a `ping` health probe → GUI2.
- Connection to the local Driftstack API server → GUI2.
- Live session viewport → GUI3.
- Manual input forwarding → GUI4.
- SOCKS5 proxy management → GUI5.
- Session recording + playback → GUI6.
- macOS native packaging + signing → GUI7.
- Founder usability pass → GUI8.

## License

MIT.
