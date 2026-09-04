# Frontend perfection punch-list (2026-06-13)

Founder bar: 100% bit-identical perfection in ALL realms. Sources: the
adversarial-review workflow (wf_476e5c5d, 10 confirmed findings) + founder-named
items + A2 dashboard/docs audit. Work top-down; one focused gated commit each.

## P0 — HIGH bugs in this session's shipped code (fix first)

1. **[data-loss] Workspace switch wipes personal folders/tags/notes.** `profiles-meta.json`
   is a single global store keyed by profile id with NO workspace dimension; the seed-down
   prune (`persistProfilesMeta(map, ownerProfileIds)` from refresh/organize/bulk) deletes
   every entry not in the active workspace's id list → personal org metadata gone (notes
   unrecoverable). Dual-confirmed. FIX: partition the local org store per effective-account
   (namespace the store key by activeWorkspace; 'personal' default) — fixes data-loss AND the
   owner-folders-bleed-into-personal low finding together.
2. **[bug] Simulator Record/Snapshot/Info buttons nested inside the Pin button's `<svg>`** →
   non-functional; the whole 1fps recording + snapshot surface is unreachable. From the
   night-arc python insertion. FIX: move the buttons to be real toolbar siblings.

## P1 — founder-named + honest-claims (founder's hard rule)

3. **[dashboard] "red at top" / old logo.** `tailwind.config.mjs gradient-accent:
linear-gradient(135deg,#722F37,#e23847)` is a HARDCODED oxblood→red gradient (used by the
   D-badge); logo refs are `driftstack-mark.svg?v=2` (marketing/admin are v3 = L2 rebrand).
   FIX: gradient-accent → violet token gradient; bump dashboard logo refs v2→v3 + confirm the
   v3 mark asset is L2. Also re-check the top `bg-glow-radial-accent` (`--glow`) resolves violet.
4. **[honest-claims] Edited proxy keeps stale capability + exit-geo on profile cards** (wrong
   exit IP shown as current). FIX: invalidate/clear the probe-cache entry for a proxy on edit.
5. **[honest-claims] Marketing Identity-Wardrobe mockup invents "coherence 96"** — a fabricated
   numeric score the product refuses to fake. FIX: remove/replace the number with an honest state.
6. **[docs] apps/docs (docs.driftstack.io) still on the OLD dark/oxblood theme** — separate
   Tailwind-v4 app, `<html lang=en>` no token axes, base.css @theme = dark slate + oxblood,
   color-scheme:dark. Semantic token classes in markup (bg-surface-base/text-ink-primary) →
   port = flip @theme token VALUES to light+violet + data axes + BaseLayout html attrs; ~207
   pins stay green (class names unchanged). Build + deploy.

## P2 — remaining confirmed (medium/low)

7. **[correctness] Team-workspace count/cap header shows member's personal numbers** (account/me
   self-scoped) above the owner's profile list → misleading + wrong client cap-gate. FIX: hide/
   replace the personal count+cap + disable atProfileCap gating when activeWorkspace !== null.
8. **[security] req.ip attacker-spoofable via forged CF-Connecting-IP** on the directly-reachable
   origin (infra/nginx/api.driftstack.dev.conf). Affects echo geo + rate-limit keying. NEEDS
   infra review — likely ops/founder-gated (nginx real-ip trust). SURFACE.
9. **[honest-claims-low] Stale exit-geo next to 'Auth failed'** on a re-test flip. FIX: clear exit
   on a non-ok re-test.
10. **[cleanup-low] Removed proxy's exit IP orphaned in probe cache** (no delete cleanup).

## Status — 2026-06-13 end-of-wave (all 10 addressed)

| #   | Item                                         | Status                                                                                                                                           |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Workspace switch data-loss                   | ✅ FIXED `bf9ccc80` (Personal-only prune guard + scopedMeta)                                                                                     |
| 2   | Simulator buttons nested in `<svg>`          | ✅ FIXED `13b6c8de` (real toolbar siblings)                                                                                                      |
| 3   | Dashboard "red at top" / old logo            | ✅ FIXED `6ac78024` — deployed + live (violet gradient + `?v=3`)                                                                                 |
| 4   | Edited proxy keeps stale capability/exit-geo | ✅ FIXED `08a7e7b3` (`invalidateProbe` on connection-field change)                                                                               |
| 5   | Marketing fabricated "coherence 96"          | ✅ FIXED `43a49cd4` (→ `OpenVPN`, matches sibling egress cards)                                                                                  |
| 6   | apps/docs on old dark/oxblood theme          | ✅ FIXED `15bb2037` — deployed + **live** (light+violet, W2, `?v=3`, dark fenced code)                                                           |
| 7   | Team-workspace footer shows personal caps    | ✅ FIXED `7f8e8622` (gated on `activeWorkspace === null` + team indicator)                                                                       |
| 8   | `req.ip` CF-Connecting-IP spoof              | ⚠️ **SURFACED — confirmed exploitable** (SSH-verified). Ops/founder-gated; remediation in `2026-06-13-cf-connecting-ip-spoof-origin-exposure.md` |
| 9   | Stale exit-geo next to "Auth failed"         | ✅ FIXED `67533b85` (render gated on `auth_ok` + evict on non-OK probe)                                                                          |
| 10  | Removed proxy orphaned in probe cache        | ✅ FIXED `08a7e7b3` (`invalidateProbe` on delete)                                                                                                |

**Bonus (beyond the original 10):** status-site was the one surface still
running dark-theme `*-white/X` overlay utilities under the light theme (34
invisible borders/fills across 7 files) → ported to adaptive surface/ink
tokens + brought into `?v=3` brand-mark lockstep + added a cross-app drift
guard so all five apps must share one cache-bust version (`102b593c`).

**Only #8 remains open** — correctly founder/ops-gated (prod firewall + nginx
real-ip; a wrong Cloudflare-range list = full outage). Everything else shipped

- verified; the GUI fixes (#4/#7/#9/#10) ride into `/Applications` at the next
  Tauri rebuild.

## "bunch of stuff to go over" — founder has more; await + sweep
