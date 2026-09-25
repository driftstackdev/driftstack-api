// W483 — errors.driftstack.dev site ↔ PROBLEM_TYPES drift guard.
//
// Every problem `type` URI the API emits must have a live page on
// errors.driftstack.dev (the site exists precisely so those URIs aren't dead
// links). This pins the generator's ERROR_PAGES slug set to api-types
// PROBLEM_TYPES exactly — adding a problem type without an error page (or
// documenting a page for a type that doesn't exist) fails the gate.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BUILD = resolve(REPO_ROOT, 'apps/errors-site/build.mjs');
const DIST = resolve(REPO_ROOT, 'apps/errors-site/dist');

const slugsIn = (file: string): Set<string> =>
  new Set(
    [...readFileSync(file, 'utf8').matchAll(/errors\.driftstack\.dev\/([a-z0-9-]+)/g)].map(
      (m) => m[1] as string,
    ),
  );

describe('W483 errors-site ↔ PROBLEM_TYPES slug parity', () => {
  const canonical = slugsIn(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
  // ERROR_PAGES keys are bare slugs; the per-page body interpolates the full
  // URI, so match the object keys directly.
  const siteSrc = readFileSync(resolve(REPO_ROOT, 'apps/errors-site/build.mjs'), 'utf8');
  const m = siteSrc.match(/export const ERROR_PAGES = \{([\s\S]+?)\n\};/);
  const pageSlugs = new Set(
    [...(m?.[1] ?? '').matchAll(/^ {2}'?([a-z0-9-]+)'?: \{/gm)].map((x) => x[1] as string),
  );

  beforeAll(() => {
    execFileSync(process.execPath, [BUILD], { cwd: REPO_ROOT, stdio: 'pipe' });
  });

  it('parses both slug sets', () => {
    expect(canonical.size).toBeGreaterThanOrEqual(29);
    expect(pageSlugs.size).toBeGreaterThanOrEqual(29);
  });

  it('every canonical problem type has an error page (no dead type URIs)', () => {
    const missing = [...canonical].filter((s) => !pageSlugs.has(s)).sort();
    expect(missing, `PROBLEM_TYPES without an errors-site page:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('every error page documents a real problem type (no phantom pages)', () => {
    const phantom = [...pageSlugs].filter((s) => !canonical.has(s)).sort();
    expect(
      phantom,
      `errors-site pages with no PROBLEM_TYPES entry:\n${phantom.join('\n')}`,
    ).toEqual([]);
  });

  it('W556: every RELATED cross-link key + target is a real error page slug', () => {
    const m = siteSrc.match(/export const RELATED = \{([\s\S]+?)\n\};/);
    expect(m, 'RELATED map present').not.toBeNull();
    const block = m?.[1] ?? '';
    const keys = [...block.matchAll(/^ {2}'?([a-z0-9-]+)'?:/gm)].map((x) => x[1] as string);
    const targets = [...block.matchAll(/'([a-z0-9-]+)'/g)]
      .map((x) => x[1] as string)
      .filter((s) => !keys.includes(s) || true);
    const bad = [...new Set([...keys, ...targets])].filter((s) => !pageSlugs.has(s)).sort();
    expect(bad, `RELATED references non-existent slugs:\n${bad.join('\n')}`).toEqual([]);
  });

  it('errors-site generator writes one catch-all six-header security baseline', () => {
    // The baseline moved to apps/errors-site/public/_headers so the CSP guard can
    // audit it from source like every other Pages app. What is checked here is
    // unchanged: ONE catch-all rule carrying all six headers exactly once —
    // Cloudflare Pages MERGES matching _headers rules, so a second occurrence
    // ships duplicates.
    const block = readFileSync(resolve(REPO_ROOT, 'apps/errors-site/public/_headers'), 'utf8');
    expect(block).toMatch(/^\/\*$/m);
    for (const header of [
      'Strict-Transport-Security:',
      'X-Frame-Options:',
      'X-Content-Type-Options:',
      'Referrer-Policy:',
      'Permissions-Policy:',
      'Content-Security-Policy:',
    ]) {
      expect(block.match(new RegExp(header, 'g')), header).toHaveLength(1);
    }
    // ...and the generator still actually emits it. A source file nothing copies
    // into dist would be audited here and absent in production.
    expect(siteSrc).toMatch(/readFileSync\(join\(HERE, 'public', '_headers'\), 'utf8'\)/);
    expect(siteSrc).toMatch(/writeFileSync\(join\(DIST, '_headers'\), SECURITY_HEADERS\);/);
  });

  // P4 (2026-09-25) — the site is the desktop app's light theme (owner decision:
  // light everywhere), so the theme-color is the light page ground, read from
  // the token package instead of typed; it was the retired near-black #0b0f14.
  const lightGround = (
    JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/design-tokens/tokens.json'), 'utf8')) as {
      modes: { light: Record<string, string> };
    }
  ).modes.light['surface-base'] as string;
  const themeColor = new RegExp(`<meta name="theme-color" content="${lightGround}">`, 'g');

  it('P4 the page CSS is built from the shared tokens (hex.mjs): no colour literal is typed into the generator’s stylesheet, the built pages carry the app’s light values, and the retired dark ground and #e5484d red are gone', () => {
    expect(lightGround).toBe('#ebedf2');
    expect(siteSrc).toMatch(
      /import \{ accent, font, light, radius \} from '@driftstack\/design-tokens\/hex';/,
    );
    const cssTemplate = siteSrc.slice(
      siteSrc.indexOf('const css = `'),
      siteSrc.indexOf('`.trim();'),
    );
    expect(cssTemplate.length).toBeGreaterThan(500);
    expect(cssTemplate.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    const page = readFileSync(resolve(DIST, 'rate-limited', 'index.html'), 'utf8');
    for (const hex of ['#ebedf2', '#f8f9fb', '#1a1d23', '#525863', '#8f3241', '#cdd3dc']) {
      expect(page, hex).toContain(hex);
    }
    for (const retired of ['#0b0f14', '#e5484d', 'color-scheme:dark']) {
      expect(page, retired).not.toContain(retired);
    }
  });

  it('P4 the error copy’s `backtick` field names render as code, never as literal backticks', () => {
    const limited = readFileSync(resolve(DIST, 'rate-limited', 'index.html'), 'utf8');
    expect(limited).toContain('<code>retry_after_seconds</code>');
    expect(limited).toContain('<code>Idempotency-Key</code>');
    for (const slug of pageSlugs) {
      const main = readFileSync(resolve(DIST, slug, 'index.html'), 'utf8').split('<main>')[1] ?? '';
      expect(main, slug).not.toContain('`');
    }
  });

  it('every real error page is indexable with a description and exact final-URL canonical', () => {
    const index = readFileSync(resolve(DIST, 'index.html'), 'utf8');
    expect(index.match(themeColor)).toHaveLength(1);
    expect(index).toMatch(/<meta name="description" content="[^"]+">/);
    expect(index).toContain('<meta name="robots" content="index,follow">');
    expect(index).toContain('<link rel="canonical" href="https://errors.driftstack.dev/">');

    for (const slug of pageSlugs) {
      const rendered = readFileSync(resolve(DIST, slug, 'index.html'), 'utf8');
      expect(rendered.match(themeColor), slug).toHaveLength(1);
      expect(rendered, slug).toMatch(/<meta name="description" content="[^"]+">/);
      expect(rendered, slug).toContain('<meta name="robots" content="index,follow">');
      expect(rendered, slug).toContain(
        `<link rel="canonical" href="https://errors.driftstack.dev/${slug}/">`,
      );
    }
  });

  it('the AI pages a customer lands on from a `type` URI describe the API as it now answers', () => {
    // These two are where a developer arrives from the URI in the error body,
    // so they are the LAST place that should still describe an older API. Two
    // things had gone stale: the AI-key 502 is two different answers (no key,
    // and a key the provider refused) and the page described only the first,
    // while telling everyone to opt in to the included AI — which an own-key-only
    // plan cannot do; and the 429 covered only the request rate, with the untrue
    // claim that the SDKs always retry it.
    const byok = readFileSync(resolve(DIST, 'byok-anthropic-required', 'index.html'), 'utf8');
    const limited = readFileSync(resolve(DIST, 'rate-limited', 'index.html'), 'utf8');

    // The fields the published document says this problem carries are the
    // fields the page has to explain. Derived, so a new one shows up here.
    const spec = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
    ) as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
    const rfc7807 = new Set(['type', 'title', 'status', 'detail', 'instance']);
    const extensions = Object.keys(
      spec.components.schemas['AgentAiKeyProblem']?.properties ?? {},
    ).filter((f) => !rfc7807.has(f));
    // Vacuity: a schema read as empty would demand nothing at all.
    expect(extensions, 'the published AI-key problem extensions').toContain('key_rejected');
    for (const field of extensions) {
      expect(byok, `the key page explains ${field}`).toContain(field);
    }
    expect(byok, 'the page says a key can be REFUSED, not only missing').toMatch(
      /Anthropic refused the key it did have/,
    );
    expect(byok, 'the page says own-key-only plans cannot opt in').toMatch(
      /cannot opt in|only on your own key/,
    );
    expect(byok, 'the page no longer says a key is simply unavailable').not.toMatch(
      /none is available on your account/,
    );

    expect(limited, 'the page covers the AI-turn limit').toMatch(
      /AI turns running at once|AI turns running/,
    );
    expect(limited, 'the page names the wait it carries').toContain('retry_after_seconds');
    expect(limited, 'the page says the AI-turn refusal ran nothing').toMatch(/no step ran/i);
    expect(limited, 'the page no longer claims every SDK call retries this').not.toMatch(
      /The SDKs retry this automatically/,
    );
    expect(limited, 'the page says which calls a program retries itself').toMatch(
      /transcript stream are yours to retry|are yours to retry/,
    );
  });

  it('unknown-slug 404 is described but noindex with no conflicting canonical', () => {
    const rendered = readFileSync(resolve(DIST, '404.html'), 'utf8');
    expect(rendered.match(themeColor)).toHaveLength(1);
    expect(rendered).toMatch(/<meta name="description" content="[^"]+">/);
    expect(rendered).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(rendered).not.toContain('<link rel="canonical"');
  });
});
