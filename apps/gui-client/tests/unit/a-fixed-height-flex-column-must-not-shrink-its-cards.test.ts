import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The owner reported the Settings page as "a small bar" with the API-connection
 * block "outside of view". Reproduced in a real browser: the hero <header>
 * rendered **42px tall against 118px of content** and clipped the rest.
 *
 * ⭐ The mechanism is a CSS-spec subtlety, which is why it looked like nothing:
 * these views are a fixed-height flex column (`h-full`) whose content runs far
 * past the viewport, so flex resolves the overflow by SHRINKING its children
 * before the scroll container ever sees it. A flex item is normally protected
 * from that by `min-height: auto` — but **that automatic minimum applies only
 * while the item's own `overflow` is `visible`**. The hero header sets
 * `overflow-hidden` for its rounded corners, which disables the protection. So
 * the one card that clips is the one card that collapses, and every sibling
 * looks fine.
 *
 * It was never Settings-specific: the same hero shipped in five views.
 *
 * ⚠️ jsdom does not do layout, so no render test in this suite can catch it.
 * A source rule is the only automatic guard available, which is why this is one.
 */

const SRC = resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

interface Container {
  file: string;
  classes: string;
}

/** Every fixed-height flex column that scrolls its own content. */
function fixedHeightScrollColumns(): Container[] {
  const found: Container[] = [];
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/className="([^"]*)"/g)) {
      const classes = m[1] ?? '';
      if (
        classes.includes('flex-col') &&
        classes.includes('h-full') &&
        classes.includes('overflow-y-auto')
      ) {
        found.push({ file: file.slice(SRC.length + 1), classes });
      }
    }
  }
  return found;
}

/**
 * ⛔ THE CLIPPING HERO IS THE REAL POPULATION, and the first version of this
 * guard missed two files by measuring the wrong thing.
 *
 * It required `overflow-y-auto` ON THE COLUMN — which is not part of the
 * mechanism. The mechanism is: a fixed-height flex column, plus a direct child
 * whose own overflow is not `visible`. Whether the column scrolls is incidental.
 * That proxy covered 6 of 28 candidate columns and let LogsView, RecordingsView
 * and SessionsView's EmptyConnect ship unprotected — the last being the FIRST
 * screen a customer without an API key sees.
 *
 * So this arm derives from the clipping card itself. Any file that ships the
 * hero must protect the column that holds it.
 */
const CLIPPING_HERO =
  'relative overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised';

describe('every view shipping the clipping hero protects its column', () => {
  const withHero = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes(CLIPPING_HERO));

  it('finds the hero in more than the five originally claimed', () => {
    // The original fix said "five views". It was seven. A non-vacuity floor set
    // at the claimed number would have agreed with the mistake.
    expect(withHero.length).toBeGreaterThanOrEqual(7);
  });

  it.each(withHero.map((f) => [f.slice(SRC.length + 1), f] as const))(
    '%s protects its fixed-height column',
    (_label, file) => {
      const src = readFileSync(file, 'utf8');
      const columns = [...src.matchAll(/className="([^"]*)"/g)]
        .map((m) => m[1] ?? '')
        .filter((c) => c.includes('flex-col') && c.includes('h-full'));
      // ⭐ A hero in a column with NO `h-full` is SAFE and is the better pattern —
      // CommandCenterView is exactly that, which is why it never clipped. The
      // rule only binds where a fixed-height column exists to do the shrinking.
      if (columns.length === 0) return;
      expect(
        columns.some((c) => c.includes('[&>*]:shrink-0')),
        `ships the clipping hero inside a fixed-height column with no [&>*]:shrink-0 — the hero collapses to a bar and clips its own title`,
      ).toBe(true);
    },
  );
});

describe('a fixed-height flex column must not shrink its cards', () => {
  const columns = fixedHeightScrollColumns();

  it('finds the containers, or this guard asserts nothing', () => {
    // Non-vacuity: a regex that matched nothing would make the rule below pass
    // over an empty set — the same silent shape as the bug.
    expect(columns.length).toBeGreaterThanOrEqual(5);
  });

  it.each(columns.map((c) => [`${c.file} :: ${c.classes.slice(0, 60)}…`, c] as const))(
    '%s declares [&>*]:shrink-0',
    (_label, container) => {
      expect(
        container.classes,
        `${container.file} is a fixed-height flex column that scrolls. Without [&>*]:shrink-0, any child ` +
          `setting overflow-hidden loses its min-height:auto protection and gets squashed to a fraction of ` +
          `its content — the card renders as a bar and clips its own title.`,
      ).toContain('[&>*]:shrink-0');
    },
  );
});
