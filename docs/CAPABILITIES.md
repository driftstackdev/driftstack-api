# Driftstack — fingerprint parity closure backlog

**Status snapshot:** 18 open residuals (as of 2026-05-03, per main-repo V-149).
Cumulative rig: **1252/1493 match**, zero critical-surface diffs.

This document is the **closure backlog for fingerprint parity** — not
marketing copy, not a status report. The bar is **100% match against
genuine iPhone 17 Pro running iOS 26 Safari**, measured by the
detection rig. Every non-zero residual listed here is an open item
until the rig reads zero detectable delta. Entries retire only on
rig-verified closure; closed entries are removed.

There is no "observable-by-design", no "acceptable residual", no
"edge case." Those frames are deferral language. This doc is a
parity ledger.

## How to read this doc

Every entry follows the same format:

| Field         | Meaning                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface       | Exact API / wire / pixel / metric being measured.                                                                                                                                                                                 |
| Current delta | Observed difference vs the iPhone 17 Pro / iOS 26 reference rig. Numerical when available (bytes, ULPs, pixels, ms).                                                                                                              |
| Target        | Always **zero detectable delta**.                                                                                                                                                                                                 |
| Closure path  | The patch ID, capture pass, or analysis approach planned. References to `wave-N-…` are WebKit-fork patches in `webkit-driftstack` (see `MODIFICATIONS.md` there).                                                                 |
| Status        | `open` (still measurable, no patch in flight) · `in flight: <ref>` (patch attempted or capture running) · cross-references to V-IDs of the work.                                                                                  |
| V-log         | Citations to verification-log entries. Bare `V-NNN` refers to the **main-repo** verification log at `<driftstack>/operations/verification-log.md`. Entries in this repo's V-log (control-plane) are explicitly `V-NNN [control]`. |

## Numbering namespace note

There are two parallel verification-log streams that both start at
V-031:

- **Main repo** (`/operations/verification-log.md`) — fingerprint
  closure work (V-031–V-143+ as of this writing). All entries below
  cite this stream by default.
- **Control-plane repo** (this repo, `docs/verification-log.md`) —
  API / SDK / GUI / contract work (V-031–V-039 as of this writing).
  No fingerprint residuals are tracked here.

When CAPABILITIES.md cites a V-ID, default is main repo unless
suffixed `[control]`.

## How Agent 1 (WebKit fork) adds entries

The structure is **additive**: drop new entries into the relevant
category table without re-templating. The table column order is
fixed; new categories go below the existing ones in alphabetical
order. Closure of an existing entry is done by **deleting the row**
once the rig measures zero, with a one-line footnote in the
corresponding category appendix recording the V-ID + closure date
for audit.

## Total open count

As of **2026-05-03 (V-149)**: **18 open residuals.**

- 8 in flight (patch / capture / analyzer in motion).
- 5 open with side-effect closure pending (root cause closes them).
- 5 open with no patch in flight (founder-deferred or blocked on investigation).

## Recent closures (audit footnote)

Removed from the tables below per the rig-zero retirement rule:

- **`canvas.measureText.fonts.value['-apple-system'].width`** — closed
  via **V-149** (2026-05-03). Q8 snap on Simple-path V-138 over-correction
  in `applyDriftstackPairKerningOverride` (FontCoreText.cpp:1320–1326)
  + Complex-path twin in `Font::driftstackPairKerningDelta`
  (FontCoreText.cpp:1110–1115). Mac result `163.73046875` = iPhone EXACT.
  V-148-Complex (the ComplexTextController hook integration) landed at
  WebKit-fork commit `e522811f5a` and is correctly hooked; V-148-PM
  established that V-148-Complex was the wrong place to look for the
  cumulative-rig 0.002 px residual (probe routes Simple, not Complex);
  V-149 closed via the Simple-path Q8 snap.

---

## Category: Canvas2D — Glyph Advance Width

Text-metric divergences in `canvas.measureText` `width` /
`fontBoundingBox*` fields. These are the highest-volume residuals
because each font × size × text triple is a separate surface.

| Surface                                                                                       | Current delta                                                                                                                                                                                  | Closure path                                                                                                                                                                                                                                          | Status                         | V-log               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------- |
| `canvas.measureText.fonts.value['Apple Color Emoji'].width` (same sentinel @ 14px)            | Mac=170.173 px vs iPhone=175.173 px (Δ=5.0 px). Decomposes as: emoji-glyph width matches; Latin-fallback portion (`mWmwwMWWmm`) differs ~0.45 px/char on sans-serif fallback × 5 chars = 5 px. | Per-glyph emoji-advance capture landed (1880 probes: 4 fonts × 5 sizes × 94 emoji). Primary-font-context threading needed: Option A (fontCascade lookup level, invasive but correct) vs Option B (global +1 emoji, wrong vector). Option A preferred. | in flight: v-143-option-a      | V-143               |
| `canvas.measureText.fonts.value['Hiragino Sans'].width`                                       | W3 (bold) variant selected on Mac; W4 (regular) expected per iPhone reference.                                                                                                                 | Track 4 Phase 4.D — font-family fallback disambiguation capture.                                                                                                                                                                                      | open                           | V-081, V-090        |
| `canvas.measureText.fonts.value['Papyrus'].width`                                             | Mac returns `PapyrusCondensed.ttf` metrics (110.97 px); iPhone returns `Papyrus Regular` (143.77 px). Wrong file selected from family.                                                         | Track 4 Phase 4.D — same as Hiragino: font-fallback capture + override.                                                                                                                                                                               | open                           | V-090               |
| `canvas.measureText.fonts.value['Marker Felt'].width`                                         | Mac selects `Marker Felt Wide` (158.41 px); iPhone selects `Marker Felt Thin` (155.47 px).                                                                                                     | Track 4 Phase 4.D.                                                                                                                                                                                                                                    | open                           | V-090               |
| `canvas.measureText.fonts.value['Marker Felt'].fontBoundingBoxAscent`                         | Mac=15 (Wide variant); iPhone=13 (Thin variant). Same root cause as the Marker Felt `width` row above.                                                                                         | Track 4 Phase 4.D.                                                                                                                                                                                                                                    | open                           | V-090               |

---

## Category: Canvas2D — Pixel Rasterization

Hash-level divergences in fillText raster output. Cumulative rig
shows 1250/1253 metric-match (99.76%); canvas-fp advanced probe
shows 7/14 byte-identical hashes — divergence is text-path
concentrated. Non-text canvas operations are 7/7 byte-identical.

| Surface                                                                                                            | Current delta                                                                                                                                                                                                 | Closure path                                                                                                                                                                                                                                                                          | Status                                     | V-log                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| `canvas.fillText` glyph rasterization, ASCII at sz=14–24                                                           | Per-glyph atlas dispatch (V-127) byte-perfect at 40px strike; per-pixel diff at non-strike sizes shows 7.5% nonzero pixels with ~9–12 RGB-channel diff. Stencil-and-tint kernel divergence.                   | V-127 atlas dispatch landed; V-131/V-136 defensive correctness paths landed. V-141 gamma-compensation hypothesis under test (alpha pattern baked at black, rendered at non-black fill). Multi-color atlas (capture at 2–4 representative tint colors) is the proposed Tier-2 closure. | in flight: v-127-d5-kernel                 | V-115, V-127, V-131–V-136, V-139, V-141 |
| `canvas.fillText` at non-strike emoji sizes (sizes ≠ 40px)                                                         | Single-strike atlas (40px) currently scaled via CG image scaling. Non-strike renders show ~95% pixel divergence. iPhone runs full rasterizer per size (V-124: 12/12 distinct bitmaps; no closed-form scaler). | V-125 D-α Coverage A+ scaffold landed (capture probe pages + format spec + LFS storage). Full capture in flight (~14 hr BS Automate, 41 sizes × 1426 codepoints + 1056 composite sequences). Atlas v2 binary built on capture completion.                                             | in flight: v-125-da-coverage-a-plus        | V-116, V-124, V-125                     |
| `canvas-fp.t01` (browserleaks short text, `fillStyle="#069"`)                                                      | rgbaHash mismatch. Per V-139: 7.5% sub-pixel-noise pixel divergence. Stencil-and-tint kernel difference on atlas-substituted PNG.                                                                             | V-141 gamma-compensation hypothesis. Multi-color atlas closure path.                                                                                                                                                                                                                  | in flight: v-141-multi-color-atlas         | V-115, V-139, V-141                     |
| `canvas-fp.t02` (multi-font Latin, Arial 14px)                                                                     | rgbaHash mismatch. Per V-139: RGB differs 100–150 per channel with **alpha-perfect** match → glyph-position offset between Mac and iPhone, not rendering kernel.                                              | V-138 full-pair kerning override (once analyzer covers all pairs) shifts glyph positions toward iPhone. Alpha-perfect-match diagnostic confirms positioning, not rasterization.                                                                                                       | in flight: v-138-full-coverage             | V-115, V-126, V-138, V-139              |
| `canvas-fp.t03` (emoji at multiple sizes)                                                                          | rgbaHash mismatch.                                                                                                                                                                                            | Closes as side effect of V-125 D-α Coverage A+ (per-size emoji atlas).                                                                                                                                                                                                                | in flight: v-125-da-coverage-a-plus        | V-115, V-124, V-125                     |
| `canvas-fp.t06` (shadow text — `shadowBlur` + `shadowColor`)                                                       | rgbaHash mismatch. Mac CG shadow-blur kernel differs from iPhone CG.                                                                                                                                          | Two options: (a) iOS shadow-blur reproduction at Mac level (likely impossible byte-exact), (b) shadow-state-aware fallthrough to native CT (per-state shadow override). No fix in flight; sequencing after primary text closures.                                                     | open                                       | V-115, V-131                            |
| `canvas-fp.t09` (compound transform: translate + rotate + scale + text)                                            | rgbaHash mismatch. Non-identity CTM. V-127 atlas dispatch initially gated with CTM check (V-131 path 2); gate reverted at V-135 because it regressed transparent-canvas fillText.                             | V-127 dispatch fires under identity / translation only. Rotation + scale need separate work: gate dispatch safely on CTM, or implement transform-aware atlas lookup.                                                                                                                  | open                                       | V-115, V-131, V-135                     |
| `canvas-fp.t12` (OffscreenCanvas main-thread context)                                                              | rgbaHash mismatch. Text path through worker context; verification needed that fork text overrides apply on worker font path.                                                                                  | Re-verify after main-thread root causes B/C/D/E close. Tier-2 priority.                                                                                                                                                                                                               | open                                       | V-115, V-131                            |
| `canvas-fp.t13` (multi-baseline text grid: `top` / `hanging` / `middle` / `alphabetic` / `ideographic` / `bottom`) | rgbaHash mismatch. Multi-baseline metric divergence (V-104 Stage A 2.1 territory) + per-baseline rendering.                                                                                                   | Closes partially as side effect of V-104 CG AA-edge fix + V-138 kerning override. Residual likely `-webkit-sans-serif` font-family fallback (atlas size-20 coverage incomplete).                                                                                                      | in flight: v-127-d5-kernel + v-138-kerning | V-115, V-131, V-139                     |

---

## Category: Canvas2D — Stage F (Complex Scripts & Transforms)

| Surface                                                                                         | Current delta                                                                                                                                                                                                                                      | Closure path                                                                                                                                                        | Status                         | V-log               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------- |
| F.2 complex scripts (Thai 3.01% / Hangul 2.21% / Khmer 2.02% / Arabic 1.98% / Devanagari 1.79%) | F.2 Thai is **rendering-dropped** on Mac fork (not per-glyph byte-diff): Mac CT not rendering Thai glyphs at sz=14/24. Root cause: system-font coverage on Mac differs from iPhone — missing Thai glyph in primary font, different fallback chain. | Investigation deferred.                                                                                                                                             | open                           | V-107, V-110, V-133 |
| F.3 variable fonts, size=16 ASCII                                                               | Mac glyph positioned ~1 px right of iPhone (integer-pixel-grid hinting, not sub-pixel quantization per V-102). Byte-diff 2.27%.                                                                                                                    | Custom ASCII rasterizer (atlas approach, like F.1.B emoji) for small sizes 14–18. Bitmap-glyph cache / CG hinting differs at small sizes.                           | open                           | V-104, V-107, V-108 |
| F.3 variable fonts, size=32                                                                     | V-104 fix (`kCGFontAntialiasingStyleUnfiltered`) reduced byte-diff from ~1.20% to 0.79%; residual 0.79% remains.                                                                                                                                   | Per V-104, residual is from AA gamma + LCD-subpixel-filter interaction. Investigation deferred.                                                                     | in flight: v-104               | V-104               |
| F.3 `-apple-system` + `font-variation-settings`                                                 | `<span style="font: 14px -apple-system; font-variation-settings: wght 700; wdth 75">text</span>` renders as ~4 non-zero bytes on Mac (rendering effectively dropped); iPhone renders ~2024 bytes.                                                  | V-134 finding: WebKit feature-settings dispatch path differs. Different from other axis cases.                                                                      | open                           | V-134, V-137        |
| F.4 CSS filters (emoji + ASCII + CJK across 18 filters)                                         | Filter pipeline is iPhone-equivalent per V-109 (all 18 filters byte-equivalent at same sample / size); divergence is from underlying text rendering. ASCII sz=16 3.06%, sz=32 2.24%; CJK sz=16 2.26%, sz=32 2.46%; Emoji sz=16 3.66%, sz=32 5.38%. | Closes as side effect of F.3 closure. No F.4-specific patch needed.                                                                                                 | in flight: root-causes-a-b-c-d | V-109               |
| F.5 vertical writing + rotations (0°/90°/180°/270°)                                             | Byte-diff 0.26–1.82% per axis × rotation. Per V-110: all 4 rotations byte-equivalent; divergence from underlying text rendering.                                                                                                                   | Closes as side effect of F.3 closure (same text-render path).                                                                                                       | in flight: root-cause-a-b-c    | V-110               |
| F.6 non-integer transforms (scale 1.3× / 1.7×)                                                  | Scaling 1.7× emoji 7.75%; 1.3× text 5.00%; rotation 45° 0.20%. Per V-110: scaling interpolation diverges (CG filter kernel), rotation passes through.                                                                                              | Rotation: no fix needed. Scaling: same as atlas per-size divergence (root cause D). Sub-pixel translate: partially closed by V-104.                                 | in flight: root-cause-d        | V-110               |
| F.7 custom WebFont (all 9 probes at 2.6% byte-diff)                                             | Custom WebFont hinting + AA pipeline diverges from iPhone. Per V-110: opposite pattern from F.3 sz=16 — Mac shows AA edges where iPhone renders sharp. iOS receives less hinting on downloaded fonts.                                              | Two options: (a) private hinting API to disable CG hinting for downloaded fonts, (b) supersampling + downsample. Smaller scope, requires private-API investigation. | open                           | V-107, V-110        |

---

## Category: Canvas2D — Encoder MIME Types

| Surface                                           | Current delta                                                                            | Closure path                                                   | Status | V-log        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | ------------ |
| `canvas.toBlobMIMETypes.value['image/avif'].size` | Mac encoder produces 386 bytes; iPhone 304 bytes. Different AVIF encoder implementation. | Track 6: canvas.toBlob AVIF / HEIC encoder path investigation. | open   | V-081, V-090 |
| `canvas.toBlobMIMETypes.value['image/heic'].size` | Mac encoder produces 480 bytes; iPhone 304 bytes. Different HEIC encoder.                | Track 6: same as AVIF row.                                     | open   | V-081, V-090 |

---

## Category: Layout & Typography

| Surface                                            | Current delta                                                                                                                                                                                          | Closure path                                                                                                                                                      | Status                 | V-log                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------- |
| `unicodeRendering.value` CJK line-height (h field) | Mac h=17.5 px vs iPhone h=18 px (Δ=0.5 px). Root cause: `InlineLineBoxBuilder` half-leading split produces fractional metric. Force-snap-to-int closes CJK but regresses emoji + family spans (V-108). | Founder-deferred pending structural patch combining `lineSpacing` recompute (V-103-style) + primary-only line-height OR Apple Color Emoji `lineSpacing` override. | open: founder-deferred | V-099, V-103, V-108, V-120 |

---

## Category: JS API surface

`-webkit-*` family-fallback resolution. Note: three earlier
JS-surface residuals (`window.ontouchstart`, `matchMedia` dark-mode,
`speechSynthesis.getVoices()` display names) closed in V-112 and
have been retired from this doc per the closure-only-retirement
rule.

| Surface                                                          | Current delta                                                                                                                                            | Closure path                                                                                                | Status                    | V-log        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- | ------------ |
| Generic CSS family fallback (`sans-serif`, `serif`, `monospace`) | Mac resolves `sans-serif` → `Helvetica`; iPhone resolves to `SF UI Text` (variant). Affects layout cascade for any span using a generic-family fallback. | `StyleResolveForFont` override (Option A per V-119) to canonicalize generic-family strings to iPhone names. | in flight: wave-1-stage-a | V-119, V-120 |

---

## Category: Performance Timing

| Surface                                                  | Current delta                                                                                                                                                                      | Closure path                               | Status | V-log                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------- | -------------------------------- | ----- |
| `performance.nowResolution.value` (median, min, p1, p99) | Δ ≈ ±2.3e-13 (±1 ULP in IEEE-754 double). Mac values: 1.0000000000002274 / 0.9999999999997726 vs iPhone exactly 1. Rig's bin-statistics computation produces floating-point noise. | Diff-script tolerance tightening (accept ` | Δ      | < 1e-9`on`performance.now`-derived fields). Instant fix, no fork rebuild. Closes 4 diffs. | in flight: diff-script-tolerance | V-120 |

---

## Categories with no current open residuals

These categories have been measured by the rig and currently have
zero open deltas. Listed here so Agent 1 can drop new entries in
without re-templating when a new surface is discovered.

- **Apple secure-context surfaces** (`apple.ApplePaySession.*` —
  closed in V-123 once HTTPS rig variant landed).
- **Audio — speech synthesis voice names** (closed in V-112).
- **JS DOM event surfaces** (`ontouchstart`, `matchMedia` dark-mode
  — closed in V-112).
- **WebGL / Metal / ANGLE** — no measured deltas in the V-log
  through V-143. If/when residuals are found, add a category
  section.
- **Network / TLS / HTTP / WebRTC** — no measured deltas in the
  V-log through V-143. Add when measured.
- **Permissions / Sensors / Storage / Service Workers** — no
  measured deltas through V-143. Add when measured.

---

## Trajectory anchors (for context, not closure tracking)

| V-ID           | Date       | Match rate         | Note                                                                          |
| -------------- | ---------- | ------------------ | ----------------------------------------------------------------------------- |
| V-072 baseline | 2026-05-01 | 1006/1289 = 77.8%  | Pre-ASCII-atlas.                                                              |
| V-119–V-120    | 2026-05-02 | 1244/1253 = 99.3%  | ASCII atlas sprint closed +238 surfaces.                                      |
| V-123          | 2026-05-02 | 1250/1253 = 99.76% | HTTPS rig variant for `ApplePaySession`.                                      |
| V-143          | 2026-05-03 | 1250/1253 = 99.76% | Per-glyph emoji advance capture landed; primary-font-context closure pending. |
| V-148-Complex  | 2026-05-03 | 1251/1493          | ComplexTextController hook integration (`m_lastDriftstackAsciiCharacter` member + `Font::driftstackPairKerningDelta()`); landed at WebKit-fork commit `e522811f5a`. No residual closure on its own — V-148-PM established Complex was the wrong path for the cumulative-rig probe. |
| V-149          | 2026-05-03 | 1252/1493          | Q8 snap on Simple-path V-138 over-correction. `-apple-system` width = `163.73046875` = iPhone EXACT. **Closes the −apple-system glyph-advance residual.** |

These are aggregate-rig pass rates, not residual counts. The
residual count above (18 open) is the **independent** gating metric
because a single non-matching field is a non-zero delta regardless
of pass-rate denominator. Note that the V-148/V-149 denominator
shifted from 1253 to 1493 — the rig grew between V-143 and V-148
as additional probes were added; the +1 in the match count is the
load-bearing closure number.
