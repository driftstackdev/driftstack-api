// Types for `build-publish.mjs`, so the strict apps/server test tsconfig can
// import the REAL transform instead of a re-typed copy.
//
// Same reason `scripts/scan-shipped-text.d.mts` and `scripts/verify-suite.d.mts`
// exist: an untyped `.mjs` import fails the strict test project with TS7016, and
// a guard that re-implemented the transform would be checking a copy of the
// thing rather than the thing.

/** The module the published barrel must not re-export: `./ai-credits.js`. */
export const WITHHELD_MODULE: string;

/**
 * `text` with the `export * from '<specifier>';` line removed. Throws when that
 * line is not present exactly once.
 */
export function withoutReExport(text: string, specifier?: string): string;

/** `text` with its trailing `//# sourceMappingURL=` line removed, if it has one. */
export function withoutSourceMappingUrl(text: string): string;

/** The `dist/` entries whose name belongs to the withheld module. */
export function withheldArtifacts(distFiles: readonly string[]): string[];

/**
 * The lines of `text` that name the unreleased credits feature, as
 * `{ line, text }` with a 1-based line number. Bounded on LETTERS rather than
 * word characters, so a published field name such as `monthly_credits` matches
 * and `Accredited` does not.
 */
export function creditsMentions(text: string): { line: number; text: string }[];
