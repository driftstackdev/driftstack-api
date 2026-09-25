// Types for `personal-names.mjs`, so a TypeScript guard imports the REAL
// matcher instead of restating it (the same reason `scan-shipped-text.d.mts`
// exists: the strict test tsconfig refuses an untyped `.mjs` import with TS7016).

/** The made-up canary word that is always on the list. */
export const CANARY_WORD: 'personalnamecanary';

/** Where the list is read from when `DRIFTSTACK_PERSONAL_NAMES_FILE` is unset. */
export const DEFAULT_LIST_PATH: string;

/** NFKD, combining marks dropped, lower-cased. */
export function normaliseWord(text: string): string;

/** Entries from list text: one per line, blank lines and `#` comments skipped. */
export function parseList(text: string): string[];

/** The configured list plus the canary, and where it came from. */
export function loadPersonalNames(options?: {
  env?: Record<string, string | undefined>;
  announce?: boolean;
}): { entries: string[]; configured: boolean; source: string };

/** One notice per process: stderr locally, a GitHub annotation under Actions. */
export function announceMissingList(env?: Record<string, string | undefined>): void;

/** The list for this process, loaded once. */
export function defaultEntries(): string[];

/** Every listed name, handle or address in `text`, with its offset in `text` as given. */
export function personalNameHits(
  text: string,
  entries?: readonly string[],
): { index: number; word: string }[];
