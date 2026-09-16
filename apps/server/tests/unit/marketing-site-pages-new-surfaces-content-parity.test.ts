// W599.B — drift guard for the S14 new marketing content surfaces
// (2026-07-03, D8): /use-cases (hub + 3 persona pages), /how-it-works,
// /glossary. Server twin of apps/marketing-site/tests/unit/
// new-surfaces-content-parity.test.ts (two-suite convention: the
// mirror runs in the app workspace, this copy runs with the server
// suite so a server-only test run still catches marketing drift).
//
// What this pins and why:
//   • Route files exist + each page's unique h1 (PageHero title prop).
//   • Plan pointers: multi-account → /pricing#manual, qa-testing +
//     web-scraping → /pricing#api (a person clicking → Manual, code
//     calling → API — drift would send a persona at the wrong ladder).
//   • CtaBand targets per page (primary CTAs land on /pricing#free).
//   • qa-testing cites the EXACT registered archetype slug
//     'iphone17_ios18_7_safari26_4' (registry-enforced by W280.A).
//   • /how-it-works stays ZERO-code; the homepage hero keeps its
//     in-page "#how-it-works" anchor (the new route is the nav entry,
//     NOT a hero retarget).
//   • /glossary anchor ids are a public deep-link contract — all 18
//     pinned; the site-wide metaphors (saved iPhone identity /
//     browser tabs / what a website can measure about a visitor)
//     must read the same here as on /pricing + faq.ts.
//   • Honesty negatives: no fabricated social proof, no overclaim
//     vocabulary, Warm-up stays chip-labelled roadmap, AUP linked as
//     a boundary (capability description, never encouragement).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

const HUB = resolve(PAGES, 'use-cases/index.astro');
const MULTI = resolve(PAGES, 'use-cases/multi-account.astro');
const QA = resolve(PAGES, 'use-cases/qa-testing.astro');
const SCRAPING = resolve(PAGES, 'use-cases/web-scraping.astro');
const HOW = resolve(PAGES, 'how-it-works.astro');
const GLOSSARY = resolve(PAGES, 'glossary.astro');
const INDEX = resolve(PAGES, 'index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function slashlessOwnedLinks(source: string): string[] {
  return [...source.matchAll(/(?:href|primaryHref|secondaryHref)\s*(?::|=)\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1] ?? '')
    .filter((href) => href.startsWith('/'))
    .filter((href) => {
      const pathname = href.split(/[?#]/, 1)[0] ?? '';
      return pathname !== '/' && !pathname.endsWith('/');
    });
}

const ALL_NEW = [HUB, MULTI, QA, SCRAPING, HOW, GLOSSARY];

describe('W599.B S14 new-surface routes exist', () => {
  it('all six route files exist at their canonical paths (immovable once shipped — static output has no redirects, a rename 404s)', () => {
    for (const p of ALL_NEW) {
      expect(existsSync(p), `missing route file: ${p}`).toBe(true);
    }
  });

  it('all six surfaces link directly to canonical owned routes without a 308 hop', () => {
    for (const page of ALL_NEW) {
      expect(slashlessOwnedLinks(read(page)), page).toEqual([]);
    }

    const slashlessMutant = read(HUB).replace(
      '/use-cases/multi-account/',
      '/use-cases/multi-account',
    );
    expect(slashlessMutant).not.toBe(read(HUB));
    expect(slashlessOwnedLinks(slashlessMutant)).toContain('/use-cases/multi-account');
  });
});

describe('W599.B /use-cases hub', () => {
  const body = read(HUB);

  it('h1 pinned: "Built for the work you actually do." (the homepage §4 family phrase, promoted to the hub hero)', () => {
    expect(body).toMatch(/title="Built for the work you actually do\."/);
  });

  it('fans out to all three persona pages, operators first (homepage §4 order)', () => {
    const a = body.indexOf("href: '/use-cases/multi-account/'");
    const b = body.indexOf("href: '/use-cases/qa-testing/'");
    const c = body.indexOf("href: '/use-cases/web-scraping/'");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('cross-links /how-it-works as the zero-jargon on-ramp', () => {
    expect(body).toMatch(/href="\/how-it-works\/"/);
  });

  it('CtaBand: primary /pricing#free "Start free" + secondary /pricing "See pricing"', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/primaryLabel="Start free"/);
    expect(body).toMatch(/secondaryHref="\/pricing\/"/);
  });
});

describe('W599.B /use-cases/multi-account (operators + account teams)', () => {
  const body = read(MULTI);

  it('h1 pinned: "Run many accounts, safely apart." (the approved homepage §4 card phrase — the persona claim ceiling)', () => {
    expect(body).toMatch(/title="Run many accounts, safely apart\."/);
  });

  it('introduces fingerprint once, in the site-wide plain form: "what a website can measure about a visitor"', () => {
    expect(body).toMatch(/what a website can\s*measure about a visitor/);
  });

  it("problem framing in the operator's words: bans cascade through the shared device", () => {
    expect(body).toMatch(/That's why bans cascade\./);
    expect(body).toMatch(/link them by\s*device/);
  });

  it('answer stays inside the approved claim register: own-physical-phone persistent profiles + 10-to-200 browser-tabs desktop app (pricing Manual card claims)', () => {
    expect(body).toMatch(/look like its own physical phone/);
    // S31 2026-07-07 (fable-truth-audit) — 'open at once' conflated stored profiles with
    // concurrent sessions (manual caps 1/3/8).
    expect(body).toMatch(/keep 10 to 200\s*logged-in profiles saved and ready/);
    expect(body).toMatch(/switch between them like browser\s*tabs/);
  });

  it('plan pointer: Manual ladder → /pricing#manual ("A person clicking → Manual." mapping)', () => {
    expect(body).toMatch(/A person clicking → Manual\./);
    expect(body).toMatch(
      /<a href="\/pricing\/#manual" class="btn-secondary">See Manual pricing →<\/a>/,
    );
  });

  it('AUP boundary named, capability-not-encouragement: /legal/aup linked with the read-before-you-sign-up framing', () => {
    expect(body).toMatch(/href="\/legal\/aup\/"/);
    expect(body).toMatch(/staying inside each service's rules stays your call/);
  });

  it("FAQ subset: FaqList over the 'Architecture + sessions' + 'Acceptable use' groups from data/faq.ts (single source — no hand-copied Q&A)", () => {
    expect(body).toMatch(/import FaqList from '\.\.\/\.\.\/components\/FaqList\.astro';/);
    expect(body).toMatch(/import \{ FAQ_GROUPS \} from '\.\.\/\.\.\/data\/faq';/);
    expect(body).toMatch(/\['Architecture \+ sessions', 'Acceptable use'\]\.includes\(g\.title\)/);
  });

  // 2026-09-15 truth pass (product-truth sheets: repo §10.A.5, A1 §2, A3 §3/§4).
  it('fingerprint / locale / motion claims are scoped: checked against real iPhones (not a blanket "match millions"), clock + time zone follow the exit (language is not claimed), motion is a per-profile MODE ("can follow"), and the free-tier device entitlement is data-bound from pricing.ts', () => {
    expect(body).toMatch(/checked against real devices, check by check/);
    expect(body).not.toMatch(/'device photos'/);
    expect(body).not.toMatch(/match millions of real iPhones/);
    expect(body).toMatch(/clock and time zone follow that location/);
    expect(body).not.toMatch(/language and clock settings/);
    expect(body).toMatch(
      /can follow patterns taken from real human movement — available per profile/,
    );
    expect(body).not.toMatch(
      /generated from patterns of real human movement, consistent per profile/,
    );
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing';/);
    expect(body).toMatch(/on the\s*\{freeTier\.archetypeAccess\}, no card required/);
    expect(body).toMatch(/is on Team and\s*Agency/);
  });

  // 2026-09-15 refuter pass: v1 profile snapshots carry metadata only
  // (archetype + name — services/profile-snapshots.ts "Captures land empty
  // {}"), restore mints a NEW empty profile rather than rolling one back, and
  // the feature has no desktop-app surface — so a no-code operator page must
  // not sell "snapshot before a risky change and bring that state back".
  // Members are read-only (guides/team-rbac.md: every write is admin-only),
  // and the audit log records a fixed event list (AccountAuditActionSchema),
  // not "every account action".
  it('under-sold shipped features named on the operator page — recycle bin, export/import, teammates with roles (admins run, members read-only), exportable audit log scoped to its recorded events (all live routes; repo truth sheet §10.B) — never the snapshot-as-rollback claim, never "members … work on your accounts", never "every account action"', () => {
    expect(body).not.toMatch(/take a snapshot of a profile before a risky change/);
    expect(body).not.toMatch(/bring that\s*state back later/);
    expect(body).toMatch(/recover one you deleted from the recycle bin/);
    expect(body).toMatch(/export\s*a profile and import it again/);
    expect(body).not.toMatch(/invite teammates as members or\s*admins/);
    expect(body).toMatch(
      /invite teammates as admins who can\s*run your accounts under your plan, or as read-only members who can\s*view them but not change anything/,
    );
    expect(body).not.toMatch(/Every account action/);
    expect(body).toMatch(
      /Sign-ins, key changes, session\s*starts and stops, profile creates and deletes, and team changes land\s*in an audit log you can export/,
    );
    expect(body).toMatch(/audit log you can export/);
  });

  it('CtaBand: primary /pricing#free + secondary /pricing#manual', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/secondaryHref="\/pricing\/#manual"/);
  });
});

describe('W599.B /use-cases/qa-testing (QA + engineering teams)', () => {
  const body = read(QA);

  it('h1 pinned: "Test on the real thing." (the approved homepage §4 card phrase)', () => {
    expect(body).toMatch(/title="Test on the real thing\."/);
  });

  it("cites the EXACT registered archetype slug 'iphone17_ios18_7_safari26_4' in the CodeWindow snippet (W280.A registry contract)", () => {
    expect(body).toMatch(/archetype: 'iphone17_ios18_7_safari26_4',/);
  });

  it('CodeWindow reuses the homepage SDK snippet shape: create → navigate → capture → getState → destroy in try/finally', () => {
    expect(body).toMatch(/import CodeWindow from '\.\.\/\.\.\/components\/CodeWindow\.astro';/);
    expect(body).toMatch(/copyTargetId="qa-sdk-code"/);
    expect(body).toMatch(/await ds\.sessions\.destroy\(session\.id\);/);
  });

  it('keeps the approved fidelity claim verbatim in spirit: the bug you reproduce is the bug your users hit', () => {
    expect(body).toMatch(/the bug you reproduce is the bug your\s*users hit/);
    expect(body).toMatch(/built from Apple's WebKit source/);
  });

  it('plan pointer: API ladder → /pricing#api', () => {
    expect(body).toMatch(/<a href="\/pricing\/#api" class="btn-secondary">See API pricing →<\/a>/);
  });

  it('free-tier honesty stays explicit: free is manual-only, programmatic access starts on the API ladder (faq.ts claim — never buried)', () => {
    expect(body).toMatch(/The free tier is manual-only/);
  });

  // 2026-09-15 truth pass: engine claim in house style, device breadth data-bound.
  it('engine claim is the house-style one — a build of Apple\'s own WebKit, the engine family behind iPhone Safari, checked against real iPhones — never "the exact engine" / "the same engine your iOS users actually run" / blanket "same rendering, same timing"', () => {
    expect(body).toMatch(/the engine family behind iPhone Safari, checked against real iPhones/);
    expect(body).not.toMatch(/the exact engine/);
    expect(body).not.toMatch(/the same engine your iOS users actually run/);
    expect(body).not.toMatch(/the same one your iOS users run/);
    expect(body).not.toMatch(/Same rendering, same\s*JavaScript timing, same quirks/);
  });

  it('device Stat binds to DEVICE_SUPPORT (19 iPhone models, 13 → 17 Pro Max, selectableCount device profiles, Safari 18.4–26.6) instead of naming three model families by hand — and never "every iPhone", which the 19-model catalog does not support (no SE / 16e / Air)', () => {
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/\.\.\/data\/capabilities';/);
    expect(body).toMatch(
      /19 iPhone models, from the 13 to the 17 Pro Max — \$\{DEVICE_SUPPORT\.selectableCount\} device profiles on iOS 18, Safari \$\{DEVICE_SUPPORT\.safariVersions\}/,
    );
    expect(body).not.toMatch(/every iPhone from the 13 to the 17 Pro Max/i);
    expect(body).not.toMatch(/iPhone 15 Pro, 16 Pro, and the current 17 lineup/);
  });

  it('shipped developer surfaces named: capture kinds (screenshot / DOM / PDF), profile snapshots scoped to what ships (device + name, spins up a NEW profile, API only — never "known-good state to bring back"), session webhooks (completed / failed / challenge), device-code sign-in; AI agent on every API plan; free-tier devices data-bound', () => {
    expect(body).toMatch(/returns a screenshot, the page's DOM, or a PDF/);
    expect(body).not.toMatch(/snapshot that profile at a known-good state/);
    expect(body).not.toMatch(/to bring back later/);
    expect(body).toMatch(
      /Through\s*the API, a profile snapshot saves that profile's device and name so\s*you can spin up a matching fresh profile later/,
    );
    expect(body).toMatch(
      /Webhooks tell your pipeline when a session completes or fails, or\s*when a site throws a challenge/,
    );
    expect(body).toMatch(/browser-approved device code/);
    expect(body).toMatch(/the AI agent is on every API plan/);
    expect(body).toMatch(/The free tier is manual-only \(\{freeTier\.archetypeAccess\}\)/);
  });

  it('CtaBand: primary /pricing#free + secondary docs.driftstack.io', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/secondaryHref="https:\/\/docs\.driftstack\.io"/);
  });
});

describe('W599.B /use-cases/web-scraping (data teams)', () => {
  const body = read(SCRAPING);

  it('h1 pinned: "See what iPhone users see." (the approved homepage §4 card phrase)', () => {
    expect(body).toMatch(/title="See what iPhone users see\."/);
  });

  it('mobile-vs-desktop divergence claim stays in the approved homepage form (different content for mobile Safari; no please-use-our-app redirects)', () => {
    expect(body).toMatch(/serve mobile Safari a different site than desktop Chrome/);
    expect(body).toMatch(/no\s*app-steering redirects/);
  });

  it('population-matched framing reuses homepage §6 phrases: one of millions of real iPhones + stable across sessions vs 100% unique (2026-09-15 plain words: "population-stable" / "stealth Chromium mints" gone, same facts; the stale "iPhone bucket" pin re-pointed at the live lead sentence)', () => {
    expect(body).toMatch(/looks like one of millions of real iPhones/);
    expect(body).toMatch(
      /session after session; disguised desktop browsers produce a brand-new value every session — 100% unique, which is itself a giveaway/,
    );
  });

  // 2026-09-15 truth pass (A1 §2: "population-stable" is false as a blanket; repo §10.A.5).
  it('engine + identity claims scoped: a build of Apple\'s own WebKit (never "the browser Apple ships"), checked against real devices signal by signal (never "the real iPhone value on every one of them"), fixed-vs-deliberately-varied answers, clock + time zone (not language) follow the exit, AI agent + webhooks named for the API plans', () => {
    expect(body).toMatch(
      /Every session runs a build of\s*Apple's own WebKit — the engine family behind iPhone Safari/,
    );
    expect(body).not.toMatch(/browser\s*Apple ships/);
    expect(body).toMatch(/checked against real devices, signal by signal/);
    expect(body).not.toMatch(/real iPhone value on every one of them/);
    expect(body).toMatch(/The fixed answers — screen, hardware, audio settings — stay fixed/);
    expect(body).toMatch(
      /the ones Safari deliberately varies are varied the way a real iPhone varies them/,
    );
    expect(body).not.toMatch(/'device photos'/);
    expect(body).toMatch(/clock and time zone follow that location/);
    expect(body).not.toMatch(/language and clock settings/);
    expect(body).toMatch(
      /The AI agent is on every API plan, and webhooks tell your job when a session completes, fails, or hits a challenge/,
    );
  });

  it('plan pointer: API ladder → /pricing#api + comparison cross-link for the signal detail', () => {
    expect(body).toMatch(/<a href="\/pricing\/#api" class="btn-secondary">See API pricing →<\/a>/);
    expect(body).toMatch(/href="\/comparison\/"/);
  });

  it('AUP boundary named for scraping specifically: auth-bypassing / rate-limit-abusing collection is out (capability description, never encouragement; S20b plain words, prohibition at full strength)', () => {
    expect(body).toMatch(/href="\/legal\/aup\/"/);
    expect(body).toMatch(
      /gets around logins\s*\(authentication\) or past a site's reasonable rate limits is not\s*allowed/,
    );
  });

  it("FAQ subset: 'Migrating from another vendor' + 'Acceptable use' groups from data/faq.ts", () => {
    expect(body).toMatch(/import FaqList from '\.\.\/\.\.\/components\/FaqList\.astro';/);
    expect(body).toMatch(
      /\['Migrating from another vendor', 'Acceptable use'\]\.includes\(g\.title\)/,
    );
  });

  it('CtaBand: primary /pricing#free + secondary /pricing#api; the side-by-side-on-the-free-tier framing (the honest evaluation path)', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/secondaryHref="\/pricing\/#api"/);
    expect(body).toMatch(/next to your current vendor/);
  });
});

describe('W599.B /how-it-works (zero-code explainer)', () => {
  const body = read(HOW);

  it('h1 pinned: "Pick a profile. Start a session. Drive it your way." (the three steps ARE the headline)', () => {
    expect(body).toMatch(/title="Pick a profile\. Start a session\. Drive it your way\."/);
  });

  it('ZERO code on this page: no CodeWindow import, no <pre>/<code> markup (the page exists for non-technical buyers; the dev story lives on /use-cases/qa-testing)', () => {
    expect(body).not.toMatch(/CodeWindow/);
    expect(body).not.toMatch(/<pre\b/);
    expect(body).not.toMatch(/<code\b/);
  });

  it('profile · session · proxy explainer panels use the site-wide metaphors: saved iPhone identity / browser tabs / own internet exit', () => {
    expect(body).toMatch(/saved iPhone identity<\/strong> that\s*keeps its logins and history/);
    expect(body).toMatch(/sessions running at the same time — think browser tabs/);
    expect(body).toMatch(/own internet exit<\/strong>/);
  });

  it('the three step cards keep the homepage step titles: Pick an iPhone profile / Start a session / Drive it your way', () => {
    expect(body).toMatch(/<Card title="Pick an iPhone profile">/);
    expect(body).toMatch(/<Card title="Start a session">/);
    expect(body).toMatch(/<Card title="Drive it your way">/);
  });

  // 2026-09-11 — the cockpit walkthrough shows the REAL Profiles view: a
  // capture of the desktop app (scene `profiles-grid`) through AppScreen,
  // lazy (it is far below the fold — the pin asserts no `priority`), with a
  // real alt naming what the screen shows. The compact hand-drawn fleet
  // strip (walkthroughProfiles + the Live/Idle name bar + exit-flag pill)
  // had drifted from the app and must not return. The page stays
  // zero-code: a capture is not a code block.
  it('cockpit walkthrough shows the REAL Profiles view (profiles-grid capture via AppScreen, lazy, real alt) — the hand-drawn fleet strip is gone', () => {
    expect(body).toMatch(/import AppScreen from '\.\.\/components\/AppScreen\.astro'/);
    expect(body).toMatch(
      /import profilesGridScreen from '\.\.\/assets\/screens\/profiles-grid\.png'/,
    );
    expect(body).toMatch(
      /<AppScreen\s+src=\{profilesGridScreen\}\s+alt=\{COCKPIT_ALT\}\s+sizes="\(min-width: 768px\) 552px, calc\(100vw - 48px\)"\s*\/>/,
    );
    expect(body).toMatch(
      /const COCKPIT_ALT =\s*\n\s*'The Driftstack desktop app, Profiles view: eight iPhone profile cards/,
    );
    expect(body).not.toMatch(/\bpriority\b/);
    // the hand-drawn strip must not return
    expect(body).not.toMatch(/walkthroughProfiles/);
    expect(body).not.toMatch(/name: 'amsterdam-shopper'/);
    expect(body).not.toMatch(/\{p\.live \? 'Live' : 'Idle'\}/);
    expect(body).not.toMatch(/\{p\.flag\} \{p\.cc\}/);
  });

  it('links the glossary as the where-the-rest-of-the-words-live page', () => {
    expect(body).toMatch(/href="\/glossary\/"/);
  });

  it('2026-09-15 truth pass: the AI agent carries its tier qualifier, the device breadth + default are BOUND to the registry / DEVICE_SUPPORT (not typed), and the retired install / wizard / blanket-takeover claims stay gone', () => {
    // AI agent is OFF on Free and Personal (TIER_FEATURES.aiAgent) — every
    // mention on this page names the plans that have it.
    const qualifiers = body.match(/Team plans and up, and\s+(?:on\s+)?every API plan/g) ?? [];
    expect(
      qualifiers.length,
      'every AI-agent mention carries the plan qualifier',
    ).toBeGreaterThanOrEqual(4);
    expect(body).toMatch(
      /import \{ ARCHETYPE_REGISTRY, LOCKED_ARCHETYPE_ID \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/data\/capabilities';/);
    expect(body).toMatch(/\{DEFAULT_DEVICE\}/);
    expect(body).toMatch(/\{DEVICE_SUPPORT\.selectableCount\}/);
    expect(body).toMatch(/\{DEVICE_SUPPORT\.safariVersions\}/);
    // A missing registry entry fails the build rather than falling back.
    // 2026-09-15 refuter fix: the catalog names 19 specific models between its
    // endpoints (ARCHETYPE_REGISTRY carries no iPhone SE, 16e or Air row), so both
    // breadth sentences say "N iPhone models, iPhone 13 → 17 Pro Max" with N DERIVED
    // from the selectable registry rows — never "every iPhone" in that span, which
    // would promise models the registry does not carry.
    expect(body).toMatch(
      /const DEVICE_MODEL_COUNT = new Set\(\s*ARCHETYPE_REGISTRY\.filter\(\(a\) => a\.status === 'launch' \|\| a\.status === 'available'\)\.map\(\s*\(a\) => a\.device,\s*\),\s*\)\.size;/,
    );
    expect(
      (
        body.match(/\{DEVICE_MODEL_COUNT\} iPhone models,\s+\{DEVICE_SUPPORT\.deviceFamilies\}/g) ??
        []
      ).length,
      'both breadth sentences bind the derived model count to the DEVICE_SUPPORT span',
    ).toBe(2);
    expect(body).not.toMatch(/every iPhone from the\s+13/);
    // Cross-source: the derivation the page runs yields the 19 the catalog documents.
    const selectableModels = new Set(
      ARCHETYPE_REGISTRY.filter((a) => a.status === 'launch' || a.status === 'available').map(
        (a) => a.device,
      ),
    );
    expect(selectableModels.size).toBe(19);
    expect(body).toMatch(/if \(!lockedDevice\) \{\s*throw new Error/);
    expect(body).not.toMatch(/iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4/);
    // The desktop app IS installed and HAS a first-run wizard (FirstRunWizard.tsx).
    expect(body).not.toMatch(/nothing to install/);
    expect(body).not.toMatch(/no\s+setup wizard/);
    // Take-over is a pair-mode action, not a blanket promise.
    expect(body).toMatch(/Run it in pair mode and you can take over any time/);
    // Consequential-action gate + free-tier device entitlement named.
    expect(body).toMatch(/looks like a purchase, a\s+payment, or an account deletion/);
    expect(body).toMatch(/free tier starts you on an iPhone 13 or 13\s+mini/);
    expect(body).toMatch(
      /one profile on an iPhone 13 or 13 mini, 20-minute sessions, no card required/,
    );
    // Proxy Test readouts + the HTTP/3 fail-closed form (homepage wording).
    expect(body).toMatch(/whether WebRTC and HTTP\/3 can travel through it/);
    expect(body).toMatch(/switches HTTP\/3 off rather than letting it leak/);
  });

  it('CtaBand: primary /pricing#free "Start free" + secondary /pricing "See pricing"', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/secondaryHref="\/pricing\/"/);
    expect(body).toMatch(/secondaryLabel="See pricing"/);
  });

  it('homepage hero CTA still anchors in-page at #how-it-works (pinned: the new route is the NAV entry; the hero anchor is NOT retargeted)', () => {
    expect(read(INDEX)).toMatch(
      /<a href="#how-it-works" class="btn-secondary">See how it works<\/a>/,
    );
  });
});

describe('W599.B /glossary (quiet reference page)', () => {
  const body = read(GLOSSARY);

  it('h1 pinned: "The words, in plain words."', () => {
    expect(body).toMatch(/title="The words, in plain words\."/);
  });

  it('all 18 anchor ids present — a public deep-link contract (Band-B small-print jargon links target these; renaming one strands every link to it)', () => {
    const ids = [
      'profile',
      'session',
      'concurrent',
      'proxy',
      'vpn',
      'egress',
      'fingerprint',
      'canvas-hash',
      'user-agent',
      'webkit',
      'archetype',
      'anti-detect',
      'headless-browser',
      'emulator',
      'sdk',
      'byok',
      'self-hosted',
      'warm-up',
    ];
    for (const id of ids) {
      expect(body, `glossary anchor id missing: ${id}`).toMatch(new RegExp(`id: '${id}',`));
    }
  });

  it('the three site-wide metaphors read the same here as on /pricing + faq.ts: profile = saved iPhone identity / concurrent = browser tabs / fingerprint = what a website can measure about a visitor', () => {
    expect(body).toMatch(/A saved iPhone identity\./);
    expect(body).toMatch(/Sessions running at the same time — think browser tabs/);
    expect(body).toMatch(/What a website can measure about a visitor/);
  });

  it('warm-up is defined as current ordinary session activity without a future-feature promise', () => {
    expect(body).toMatch(
      // 2026-09-15 customer-copy pass: "GUI" became "the desktop app", the
      // site's own name for it.
      /id: 'warm-up',[\s\S]{0,500}?regular session activity, whether you drive it from the desktop app, the API, or an SDK/,
    );
    expect(body).not.toMatch(/chip: 'roadmap'|HonestyChip/);
  });

  it('egress entry cross-links /trust/security-overview (the canonical impl-state disclosure surface for egress claims, per W247.A)', () => {
    expect(body).toMatch(/href="\/trust\/security-overview\/"/);
  });

  it('quiet reference page: no CtaBand (deliberate — the page is a dictionary, not a funnel step)', () => {
    expect(body).not.toMatch(/import CtaBand/);
    expect(body).not.toMatch(/<CtaBand/);
  });

  it('2026-09-15 truth pass: archetype breadth is BOUND to DEVICE_SUPPORT, egress drops the unverified locale claim and carries the HTTP/3 fail-closed form, identity claims are scoped, VPN is paid-plan, and the shipped AI agent / recording / recycle-bin terms exist', () => {
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/data\/capabilities';/);
    expect(body).toMatch(/id: 'archetype',[\s\S]{0,400}?\$\{DEVICE_SUPPORT\.selectableCount\}/);
    expect(body).toMatch(/id: 'archetype',[\s\S]{0,600}?\$\{DEVICE_SUPPORT\.safariVersions\}/);
    // 2026-09-15 refuter fix: 19 specific models, not every iPhone in the span (no
    // iPhone SE, 16e or Air row). The glossary imports only DEVICE_SUPPORT, so the 19
    // is typed there and held to the selectable registry rows here.
    expect(body).toMatch(
      /id: 'archetype',[\s\S]{0,600}?to choose from — 19 iPhone models, \$\{DEVICE_SUPPORT\.deviceFamilies\}, on iOS 18, with Safari \$\{DEVICE_SUPPORT\.safariVersions\}/,
    );
    expect(body).not.toMatch(/every iPhone from the\s+13/);
    const selectableModels = new Set(
      ARCHETYPE_REGISTRY.filter((a) => a.status === 'launch' || a.status === 'available').map(
        (a) => a.device,
      ),
    );
    expect(selectableModels.size, 'the typed 19 must track the selectable registry rows').toBe(19);
    expect(
      [...selectableModels].some((d) => /^iPhone (SE|16e|Air)\b/.test(d)),
      'an iPhone SE / 16e / Air row landed — retype the glossary count and drop the gap wording',
    ).toBe(false);
    // Language/locale following the exit is unverified (A3 sheet); clock + time zone is the homepage claim.
    expect(body).not.toMatch(/language and clock|locale and timezone/);
    expect(body).toMatch(/clock and time zone follow the exit/);
    expect(body).toMatch(
      /on a proxy that can\\'t carry HTTP\/3, it is switched off rather than leaked/,
    );
    // Blanket identity claims are gone; the scoped form is present.
    expect(body).not.toMatch(
      /return the value a real iPhone returns, because the same engine draws/,
    );
    expect(body).not.toMatch(/the real iPhone engine|Apple's real browser engine/);
    expect(body).toMatch(
      /where Safari deliberately varies the value a little, Driftstack varies it the same way/,
    );
    // VPN files are a paid-plan feature (TIER_FEATURES.vpnEgress false on free).
    expect(body).toMatch(
      /On paid plans, Driftstack profiles accept your own OpenVPN \(\.ovpn\) or WireGuard \(\.conf\)/,
    );
    for (const id of ['ai-agent', 'recording', 'recycle-bin']) {
      expect(body, `glossary anchor id missing: ${id}`).toMatch(new RegExp(`id: '${id}',`));
    }
    expect(body).toMatch(
      /id: 'ai-agent',[\s\S]{0,200}?included on Team plans and up and on every API plan/,
    );
    expect(body).toMatch(/id: 'byok',[\s\S]{0,120}?\(Team plans and up, and every API plan\)/);
    expect(body).toMatch(/id: 'recording',[\s\S]{0,200}?saved on your own computer/);
    expect(body).toMatch(/id: 'recycle-bin',[\s\S]{0,120}?keeps it for 30 days/);
  });
});

describe('W599.B honesty negatives across all six new surfaces', () => {
  it('no fabricated social proof: no testimonials, no "Trusted by", no invented user/customer counts', () => {
    for (const p of ALL_NEW) {
      const body = read(p);
      expect(body, p).not.toMatch(/testimonial/i);
      expect(body, p).not.toMatch(/trusted by/i);
      expect(body, p).not.toMatch(
        /\b\d[\d,]*\+?\s+(?:happy\s+)?(customers|users|teams|companies)\b/i,
      );
    }
  });

  it('no overclaim vocabulary: undetectable / guaranteed / battle-tested / industry-leading / generally available', () => {
    for (const p of ALL_NEW) {
      const body = read(p);
      expect(body, p).not.toMatch(/\bundetectable\b/i);
      expect(body, p).not.toMatch(/\bguaranteed?\b/i);
      expect(body, p).not.toMatch(/\bbattle-?tested\b/i);
      expect(body, p).not.toMatch(/\bindustry-leading\b/i);
      expect(body, p).not.toMatch(/\bgenerally available\b/i);
    }
  });

  it('no hand-typed dollar amounts on the new surfaces (pricing figures live in data/pricing.ts and on /pricing — the new pages only point there)', () => {
    for (const p of ALL_NEW) {
      expect(read(p), p).not.toMatch(/\$\d/);
    }
  });
});
