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
    expect(body).toMatch(/what a website can\s*\n?\s*measure about a visitor/);
  });

  it("problem framing in the operator's words: bans cascade through the shared device", () => {
    expect(body).toMatch(/That's why bans cascade\./);
    expect(body).toMatch(/link them by\s*\n?\s*device/);
  });

  it('answer stays inside the approved claim register: own-physical-phone persistent profiles + 10-to-200 browser-tabs desktop app (pricing Manual card claims)', () => {
    expect(body).toMatch(/look like its own physical phone/);
    // S31 2026-07-07 (fable-truth-audit) — 'open at once' conflated stored profiles with
    // concurrent sessions (manual caps 1/3/8).
    expect(body).toMatch(/keep 10 to 200\s*\n?\s*logged-in profiles saved and ready/);
    expect(body).toMatch(/switch between them like browser\s*\n?\s*tabs/);
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
    expect(body).toMatch(/the bug you reproduce is the bug your\s*\n?\s*users hit/);
    expect(body).toMatch(/built from Apple's WebKit source/);
  });

  it('plan pointer: API ladder → /pricing#api', () => {
    expect(body).toMatch(/<a href="\/pricing\/#api" class="btn-secondary">See API pricing →<\/a>/);
  });

  it('free-tier honesty stays explicit: free is manual-only, programmatic access starts on the API ladder (faq.ts claim — never buried)', () => {
    expect(body).toMatch(/The free tier is manual-only/);
  });

  it('CtaBand: primary /pricing#free + secondary docs.driftstack.dev', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/secondaryHref="https:\/\/docs\.driftstack\.dev"/);
  });
});

describe('W599.B /use-cases/web-scraping (data teams)', () => {
  const body = read(SCRAPING);

  it('h1 pinned: "See what iPhone users see." (the approved homepage §4 card phrase)', () => {
    expect(body).toMatch(/title="See what iPhone users see\."/);
  });

  it('mobile-vs-desktop divergence claim stays in the approved homepage form (different content for mobile Safari; no please-use-our-app redirects)', () => {
    expect(body).toMatch(/serve mobile Safari a different site than desktop Chrome/);
    expect(body).toMatch(/no\s*\n?\s*app-steering redirects/);
  });

  it('population-matched framing reuses homepage §6 phrases: iPhone bucket with millions + population-stable vs 100% unique (S20b 2026-07-06 plain words, same facts)', () => {
    expect(body).toMatch(/lands in the iPhone bucket\s*\n?\s*with millions of others/);
    expect(body).toMatch(
      /session after session \(population-stable\); stealth Chromium mints a new one every session — 100% unique, itself a giveaway/,
    );
  });

  it('plan pointer: API ladder → /pricing#api + comparison cross-link for the signal detail', () => {
    expect(body).toMatch(/<a href="\/pricing\/#api" class="btn-secondary">See API pricing →<\/a>/);
    expect(body).toMatch(/href="\/comparison\/"/);
  });

  it('AUP boundary named for scraping specifically: auth-bypassing / rate-limit-abusing collection is out (capability description, never encouragement; S20b plain words, prohibition at full strength)', () => {
    expect(body).toMatch(/href="\/legal\/aup\/"/);
    expect(body).toMatch(
      /gets around logins\s*\n?\s*\(authentication\) or past a site's reasonable rate limits is not\s*\n?\s*allowed/,
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
    expect(body).toMatch(
      /saved iPhone identity<\/strong> that\s*\n?\s*keeps its logins and history/,
    );
    expect(body).toMatch(/sessions running at the same time — think browser tabs/);
    expect(body).toMatch(/own internet exit<\/strong>/);
  });

  it('the three step cards keep the homepage step titles: Pick an iPhone profile / Start a session / Drive it your way', () => {
    expect(body).toMatch(/<Card title="Pick an iPhone profile">/);
    expect(body).toMatch(/<Card title="Start a session">/);
    expect(body).toMatch(/<Card title="Drive it your way">/);
  });

  it('cockpit walkthrough reuses the phone-framed card idiom (no invented UI): Live/Idle name bar + exit-flag pill, example-profile names from the homepage set', () => {
    expect(body).toMatch(/name: 'amsterdam-shopper'/);
    expect(body).toMatch(/\{p\.live \? 'Live' : 'Idle'\}/);
    expect(body).toMatch(/\{p\.flag\} \{p\.cc\}/);
  });

  it('links the glossary as the where-the-rest-of-the-words-live page', () => {
    expect(body).toMatch(/href="\/glossary\/"/);
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
      /id: 'warm-up',[\s\S]{0,500}?regular session activity driven through the GUI, API, or SDK/,
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
