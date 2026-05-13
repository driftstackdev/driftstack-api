// W545.C — drift guard for /docs/locked-decisions.md.
// Locked-decisions registry — load-bearing for the product moat.
// Drift here either weakens the L-001 intent-only-API stance (would
// erode the behavioral-simulation moat by exposing coordinate
// primitives on the customer SDK surface), drops the V-032 → V-036
// re-cut history (would lose the cautionary tale that justified
// the policy), or changes the gui_control scope name (would
// diverge from the actual server-internal route gate).
//
//   • Locked-decisions framing: flouting these is product
//     regression, not implementation regression.
//   • L-001 — customer-facing API is intent-only.
//   • Concrete examples: tap(selector) ✅ vs tap_at(x,y) ❌, type
//     (selector,text) ✅ vs key_down/key_up ❌, wait_for ✅ vs
//     sleep ❌.
//   • Moat rationale: simulation layer is mandatory when customers
//     can only express intent; coordinate primitive ships → simulation
//     becomes optional → moat erodes.
//   • Mechanics-level primitives allowed only on `gui_control` scope
//     (server-internal, NOT in @driftstack/api-types).
//   • Drift detection 2-question test.
//   • V-032 → V-036 history (2026-05-02 tap_at landed → 2026-05-03
//     reverted + moved behind gui_control).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/locked-decisions.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W545.C /docs/locked-decisions.md content parity', () => {
  const body = read(LIB);

  it("Header + load-bearing-for-moat + drift-not-shape framing pinned: '# Driftstack API — locked decisions' + 'Decisions that are **load-bearing** for the product moat. These are not preferences or stylistic choices — flouting them is a regression of the product itself, not just the implementation.' + 'Any change to public schemas or driver-interface contracts must be checked against this file. If a proposed change violates a locked decision, surface as **drift**, not as a shape question.' — pinned so the load-bearing-for-product-moat + flouting-is-product-regression-not-implementation-regression + surface-as-drift-not-shape-question commitment survives (drift to relaxing this to 'preferences' would invite drift against the moat)", () => {
    expect(body).toMatch(/^# Driftstack API — locked decisions$/m);
    expect(body).toMatch(
      /Decisions that are \*\*load-bearing\*\* for the product moat\. These are/,
    );
    expect(body).toMatch(/not preferences or stylistic choices — flouting them is a regression/);
    expect(body).toMatch(/of the product itself, not just the implementation\./);
    expect(body).toMatch(/Any change to public schemas or driver-interface contracts must be/);
    expect(body).toMatch(/checked against this file\. If a proposed change violates a locked/);
    expect(body).toMatch(/decision, surface as \*\*drift\*\*, not as a shape question\./);
  });

  it("L-001 anchor + intent-vs-mechanics framing pinned: '## L-001 — The customer-facing API is intent-only' + 'The public schemas exposed in `@driftstack/api-types` (and re-exported through every SDK) describe **intent**, not **mechanics**. The customer says _what they want to happen_, not _how to mechanically make it happen_.' — pinned so the L-001 + @driftstack/api-types + every-SDK-re-export + intent-not-mechanics + what-not-how commitment survives", () => {
    expect(body).toMatch(/## L-001 — The customer-facing API is intent-only/);
    expect(body).toMatch(
      /The public schemas exposed in `@driftstack\/api-types` \(and re-exported/,
    );
    expect(body).toMatch(/through every SDK\) describe \*\*intent\*\*, not \*\*mechanics\*\*\./);
    expect(body).toMatch(
      /The\s*\n?customer says _what they want to happen_, not _how to mechanically/,
    );
    expect(body).toMatch(/make it happen_\./);
  });

  it("3 concrete intent-vs-mechanic examples pinned: '✅ `tap(selector)` — intent: \"interact with this element\". The behavioral simulation layer chooses real coordinates, motion curves, dwell, etc.' + '❌ `tap_at(x, y)` — mechanic: \"click pixel (x, y)\". Bypasses the simulation layer entirely.' + '✅ `type(selector, text)` — intent: \"put this text in this field\".' + '❌ `key_down('a'); key_up('a')` — mechanic: \"produce a key event\".' + '✅ `wait_for(selector)` — intent: \"wait until this element exists\".' + '❌ `sleep(ms)` — mechanic: \"block for this long\".' — pinned so the 3-paired-example (tap/tap_at + type/key_down+up + wait_for/sleep) + simulation-layer-chooses-real-coords-motion-curves-dwell + bypasses-simulation-layer-entirely commitment survives", () => {
    expect(body).toMatch(/- ✅ `tap\(selector\)` — intent: "interact with this element"\./);
    expect(body).toMatch(/The behavioral simulation layer chooses real coordinates, motion/);
    expect(body).toMatch(/curves, dwell, etc\./);
    expect(body).toMatch(/- ❌ `tap_at\(x, y\)` — mechanic: "click pixel \(x, y\)"\. Bypasses the/);
    expect(body).toMatch(/simulation layer entirely\./);
    expect(body).toMatch(/- ✅ `type\(selector, text\)` — intent: "put this text in this field"\./);
    expect(body).toMatch(
      /- ❌ `key_down\('a'\); key_up\('a'\)` — mechanic: "produce a key event"\./,
    );
    expect(body).toMatch(
      /- ✅ `wait_for\(selector\)` — intent: "wait until this element exists"\./,
    );
    expect(body).toMatch(/- ❌ `sleep\(ms\)` — mechanic: "block for this long"\./);
  });

  it("Why-this-is-the-moat framing pinned: '### Why this is the moat' + 'The behavioral simulation layer (jitter, motion curves, fixation, human cadence) is _mandatory_ when the customer can only express intent. The simulation layer is the difference between \"headful Safari that looks human\" and \"every other automation tool that gets caught\".' + 'The moment a coordinate primitive ships in the customer SDK, customers will use it — sometimes for legitimate reasons (their own engine-tracking pipeline, A/B harness, etc.), but the simulation layer becomes optional. Optional means most calls bypass it. Bypass at scale means the population we serve is no longer uniformly stealth, and the moat erodes faster than we can patch.' — pinned so the simulation-layer-mandatory + jitter+motion-curves+fixation+human-cadence + headful-Safari-vs-every-other-automation-tool + optional-means-bypass-at-scale + moat-erodes-faster-than-patch commitment survives (drift to claiming simulation is optional would invalidate the entire moat argument)", () => {
    expect(body).toMatch(/### Why this is the moat/);
    expect(body).toMatch(/The behavioral simulation layer \(jitter, motion curves, fixation,/);
    expect(body).toMatch(/human cadence\) is _mandatory_ when the customer can only express/);
    expect(body).toMatch(/intent\. The simulation layer is the difference between "headful Safari/);
    expect(body).toMatch(/that looks human" and "every other automation tool that gets caught"\./);
    expect(body).toMatch(/The moment a coordinate primitive ships in the customer SDK, customers/);
    expect(body).toMatch(/will use it — sometimes for legitimate reasons \(their own/);
    expect(body).toMatch(
      /engine-tracking pipeline, A\/B harness, etc\.\), but the simulation layer/,
    );
    expect(body).toMatch(
      /becomes optional\. Optional means most calls bypass it\. Bypass at scale/,
    );
    expect(body).toMatch(/means the population we serve is no longer uniformly stealth, and the/);
    expect(body).toMatch(/moat erodes faster than we can patch\./);
  });

  it("gui_control-scope + GUI-manual-control-exception framing pinned: '### Where mechanics-level primitives ARE allowed' + 'The GUI's manual-control mode is a different use case: a human is literally clicking pixels in a screenshot, and the human's own cadence _is_ the behavior. There's no automation simulation to bypass because there's no automation. Mechanics-level primitives there are fine — **but** they live on a separate, scoped surface:' + 'Schemas: server-internal only, NOT in `@driftstack/api-types`.' + 'Endpoint: gated behind a separate API-key scope (`gui_control`) that customer keys never carry by default.' + 'SDK exposure: none. The GUI calls the gated endpoint via a thin helper, not via the customer SDK.' + 'This keeps the customer SDK surface clean and the gating explicit.' — pinned so the GUI-manual-control-human-is-the-cadence + server-internal-NOT-in-api-types + gui_control-scope-customer-keys-don't-carry + no-SDK-exposure-thin-helper commitment survives (drift to opening gui_control to customer keys would re-open the bypass-at-scale risk)", () => {
    expect(body).toMatch(/### Where mechanics-level primitives ARE allowed/);
    expect(body).toMatch(/The GUI's manual-control mode is a different use case: a human is/);
    expect(body).toMatch(/literally clicking pixels in a screenshot, and the human's own cadence/);
    expect(body).toMatch(/_is_ the behavior\. There's no automation simulation to bypass because/);
    expect(body).toMatch(/there's no automation\. Mechanics-level primitives there are fine —/);
    expect(body).toMatch(/\*\*but\*\* they live on a separate, scoped surface:/);
    expect(body).toMatch(/- Schemas: server-internal only, NOT in `@driftstack\/api-types`\./);
    expect(body).toMatch(/- Endpoint: gated behind a separate API-key scope \(`gui_control`\)/);
    expect(body).toMatch(/that customer keys never carry by default\./);
    expect(body).toMatch(/- SDK exposure: none\. The GUI calls the gated endpoint via a thin/);
    expect(body).toMatch(/helper, not via the customer SDK\./);
    expect(body).toMatch(/This keeps the customer SDK surface clean and the gating explicit\./);
  });

  it("Drift-detection 2-question + V-032/V-036 history framing pinned: '### Drift detection' + 'When proposing a change to a public schema, ask:' + '1. Is this exposing a coordinate, timing, or input mechanic that the simulation layer would otherwise own?' + '2. Is this enabling the customer to _bypass_ a simulation step?' + 'If yes to either, surface as **drift against L-001** before writing code. The right answer is almost always \"expose a higher-intent primitive on the public surface and put the mechanic on the gui-control plane.\"' + '### History' + 'V-032 (2026-05-02) added `tap_at` + `type_focused` to `InteractActionSchema` for the GUI's manual-control input forwarding. This was drift against L-001. V-036 (2026-05-03) re-cut: reverted the public-surface additions, moved coordinate primitives behind the `gui_control` scope on a separate schema.' — pinned so the 2-question-drift-detection + 'drift against L-001' framing + higher-intent-primitive-on-public-surface + V-032 2026-05-02 tap_at+type_focused drift + V-036 2026-05-03 re-cut commitment survives", () => {
    expect(body).toMatch(/### Drift detection/);
    expect(body).toMatch(/When proposing a change to a public schema, ask:/);
    expect(body).toMatch(/1\. Is this exposing a coordinate, timing, or input mechanic that the/);
    expect(body).toMatch(/simulation layer would otherwise own\?/);
    expect(body).toMatch(/2\. Is this enabling the customer to _bypass_ a simulation step\?/);
    expect(body).toMatch(/If yes to either, surface as \*\*drift against L-001\*\* before writing/);
    expect(body).toMatch(/code\. The right answer is almost always "expose a higher-intent/);
    expect(body).toMatch(/primitive on the public surface and put the mechanic on the/);
    expect(body).toMatch(/gui-control plane\."/);
    expect(body).toMatch(/### History/);
    expect(body).toMatch(/V-032 \(2026-05-02\) added `tap_at` \+ `type_focused` to/);
    expect(body).toMatch(/`InteractActionSchema` for the GUI's manual-control input forwarding\./);
    expect(body).toMatch(
      /This was drift against L-001\. V-036 \(2026-05-03\) re-cut: reverted the/,
    );
    expect(body).toMatch(/public-surface additions, moved coordinate primitives behind the/);
    expect(body).toMatch(/`gui_control` scope on a separate schema\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
