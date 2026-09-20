import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const body = readFileSync(
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro'),
  'utf8',
);

describe('/roadmap legacy URL current-state content', () => {
  it('routes readers to released changes and the supported API contract', () => {
    expect(body).toContain('title="Product updates"');
    expect(body).toContain('href="/changelog/"');
    expect(body).toContain('href="https://docs.driftstack.io/api/"');
  });

  it('contains no forward-looking feature inventory', () => {
    expect(body).not.toMatch(/RoadmapItem|const (?:NOW|NEXT|LATER)|forward-looking|lands next/i);
  });

  it('2026-09-15 what-ships inventory: device counts bind to DEVICE_SUPPORT, the AI agent carries its plan qualifier, and the Free plan states its limits', () => {
    expect(body).toContain("import { DEVICE_SUPPORT } from '../data/capabilities'");
    expect(body).toContain('{DEVICE_SUPPORT.selectableCount} device profiles');
    expect(body).toContain('Safari {DEVICE_SUPPORT.safariVersions}');
    expect(body).toMatch(/On Team plans and up, and on every API\s+plan/);
    expect(body).toMatch(/iPhone\s+13 and iPhone 13 mini, no API access, proxy only \(no VPN\)/);
    expect(body).toMatch(
      /A build of Apple's own WebKit — the engine family behind iPhone\s+Safari/,
    );
    expect(body).not.toMatch(/identical|every interaction|the same browser Apple ships|Chrome/i);
  });

  it('2026-09-15 refuter pins: the model span counts models, the Approve / Deny pause is scoped to the buttons the gate recognises, and OAuth registration is on request', () => {
    // packages/api-types/src/common.ts ARCHETYPE_REGISTRY has 19 iPhone
    // models and no SE / 16e / Air, so "every iPhone from the 13 to the
    // 17 Pro Max" was false; capabilities.ts describes deviceFamilies as
    // "19 iPhone models between the endpoints".
    expect(body).toMatch(
      /device profiles across\s+19 iPhone models, from the iPhone 13 to the 17 Pro Max \(\{DEVICE_SUPPORT\.deviceFamilies\}\)/,
    );
    expect(body).not.toMatch(/every iPhone from/i);
    // ⛔ THE PAUSE IS SCOPED TO WHAT THE GATE RECOGNISES, AND THE SENTENCE MOVED
    // WITH THE GATE. agent-consequential-action.ts is a conservative keyword
    // heuristic on the tap target (buy / order / checkout / pay /
    // delete-account phrases) whose header accepts false negatives; beside it
    // now sit the structural reading of the page's markup
    // (agent-page-commitment.ts) and the planner's own declaration that a step
    // commits. Three readings, none complete — so the page says the pause is
    // before a step it RECOGNISES, and it no longer names the button, because
    // the pause is not scoped to buttons.
    expect(body).toMatch(
      /an Approve \/ Deny pause before a step it\s+recognises as buying, paying, or deleting an account\./,
    );
    expect(body).not.toMatch(/real-world consequences|before any action/i);
    expect(body).not.toMatch(/pause before it taps a\s+button/i);
    // apps/marketing-site/src/pages/docs/oauth-apps.astro: client
    // registration is admin-gated (email request), not self-serve.
    expect(body).toMatch(
      /OAuth 2\.0 for an app that acts on a customer's behalf\s+\(client registration on request\)\./,
    );
  });
});
