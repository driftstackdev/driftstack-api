// One tier's object text from `apps/marketing-site/src/data/pricing.ts`.
//
// Three guards read that file and assert per-tier fields:
// `marketing-pricing-adr-004-parity`, `marketing-site-data-pricing-content-parity`
// and `tier-limits-server-side-parity`. All three used to anchor on
// `id: '<tier>'` and scan forward a fixed number of characters.
//
// That is unsound against this file, and one of the three was demonstrably
// broken by it: tier objects are 384–602 bytes while the windows ran to 1,500,
// so an assertion could be satisfied by a NEIGHBOURING tier's field. Changing
// `self_hosted_solo.minimumTermMonths` from 3 to 6 left the ADR-004 guard fully
// green, because `self_hosted_pro` also says 3.
//
// The other two survive their mutations today, and that is luck rather than
// design: whether an over-wide window is exploitable depends on whether a
// neighbour happens to carry the same literal in reach. A guard that is correct
// only until someone adds a tier is not correct. `tier-limits-server-side-parity`
// is the clearest case — its 1,200-character windows are safe solely because
// they anchor on `enterprise`, whose object happens to be 3,434 bytes.
//
// So the bound is shared rather than re-derived per file, and lives here so the
// three cannot drift apart.

import { readFileSync } from 'node:fs';

/**
 * The text of one tier's object, from its `id:` up to the next tier's `id:`.
 *
 * Returns '' when the tier is absent, which callers assert against — an empty
 * block would make every assertion scoped to it vacuously unsatisfiable, so it
 * has to be checked rather than assumed.
 */
export function tierBlockIn(pricingSource: string, id: string): string {
  const marker = `id: '${id}'`;
  const start = pricingSource.indexOf(marker);
  if (start === -1) return '';
  const next = pricingSource.indexOf("id: '", start + marker.length);
  return pricingSource.slice(start, next === -1 ? pricingSource.length : next);
}

/** Every tier id declared in the file, in file order. */
export function tierIdsIn(pricingSource: string): string[] {
  return [...pricingSource.matchAll(/id: '([a-z_]+)'/g)]
    .map(([, id]) => id)
    .filter((id): id is string => id !== undefined);
}

/** Convenience for callers that hold a path rather than the source. */
export function readPricing(path: string): string {
  return readFileSync(path, 'utf8');
}
