# GUI icons

Regenerated 2026-05-20 from the brand mark at
`apps/marketing-site/public/driftstack-mark.svg` via
`scripts/render-gui-icon.mjs` + `npx tauri icon` from
`apps/gui-client/`. The mark uses an oxblood→glow-red vertical
gradient with the iPhone-silhouette counter cutout.

To regenerate:

```
node scripts/render-gui-icon.mjs            # SVG → /tmp/icon-source.png (1024×1024)
cd apps/gui-client && npx tauri icon /tmp/icon-source.png
```

Covers macOS .icns + Windows .ico + 32/64/128/128@2x PNGs + Android
mipmap densities + iOS Square\*Logo PNGs + StoreLogo.
