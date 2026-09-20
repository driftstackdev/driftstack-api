// Types for `harden-sourcemaps.mjs`, so the strict apps/server test tsconfig can
// import the REAL transform instead of a re-typed copy.
//
// Same reason `scripts/api-types-build-publish.d.mts` exists: an untyped `.mjs`
// import fails the strict test project with TS7016, and a guard that
// re-implemented the transform would be checking a copy of the thing rather
// than the thing.

/** Absolute path to packages/sdk-typescript. */
export const PACKAGE_DIR: string;

/** The published sourcemaps this step rewrites, package-relative. */
export const MAPS: string[];

/** Whether a map's `sources` entry, resolved against `mapDir`, is a file of this package. */
export function isOwnSource(source: unknown, mapDir: string): boolean;

/**
 * The package-qualified name for a foreign source path — `../../api-types/src/
 * common.ts` becomes `@driftstack/api-types/src/common.ts`. An unrecognised
 * shape keeps only its basename, in angle brackets.
 */
export function publicSourceName(source: string): string;

/**
 * `map` with every foreign source's embedded text replaced by `null` and its
 * path rewritten. Pure — returns a new map plus the list of sources it changed.
 */
export function hardenMap(
  map: { sources?: unknown[]; sourcesContent?: (string | null)[]; [k: string]: unknown },
  mapDir: string,
): {
  map: { sources: unknown[]; sourcesContent?: (string | null)[]; [k: string]: unknown };
  dropped: unknown[];
};
