// Types for `scan-shipped-text.mjs`, so a TypeScript guard can import the REAL
// exported rules and functions instead of re-typing them.
//
// Same reason `verify-suite.d.mts` exists: `apps/server/tsconfig.test.json` is
// strict, so a server-side test importing an untyped `.mjs` fails with TS7016.
// Re-deriving the rules in the test would be worse than the type error — a
// ratchet has to count what the SCANNER counts, or it is counting a copy.

export const TICKET_ID: 'ticket-id';
export const INTERNAL_VOCABULARY: 'internal-vocabulary';

export type FindingClass = 'ticket-id' | 'internal-vocabulary';

/** One shape the scanner reports, with the strings that justified it. */
export interface Rule {
  readonly id: string;
  readonly class: FindingClass;
  readonly pattern: RegExp;
  readonly why: string;
  readonly seen: readonly string[];
}

/** Legitimate text a rule would otherwise report, with the reason it is allowed. */
export interface AllowEntry {
  readonly id: string;
  readonly rules: readonly string[] | '*';
  readonly pattern: RegExp;
  readonly reason: string;
}

export interface Finding {
  readonly package?: string;
  readonly artifact?: string;
  readonly file?: string;
  readonly rule: string;
  readonly class: FindingClass;
  readonly why: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly context: string;
}

export interface ShippedFile {
  readonly shipped: string;
  readonly source?: string;
  readonly body?: string | null;
}

export interface ArtifactFiles {
  readonly artifact: string;
  readonly method?: string;
  readonly note?: string;
  readonly files: readonly ShippedFile[];
}

export interface ScannedArtifact {
  readonly artifact: string;
  readonly method: string;
  readonly note?: string;
  readonly fileCount: number;
  readonly textFileCount: number;
  readonly counts: Record<FindingClass, number>;
  readonly findings: readonly Finding[];
}

export interface ScannedPackage {
  readonly package: string;
  readonly artifacts: readonly ScannedArtifact[];
}

export interface ScanOptions {
  readonly npmMethod?: 'auto' | 'derived';
  readonly pythonMethod?: 'auto' | 'derived';
  readonly goTests?: boolean;
}

export const RULES: readonly Rule[];
export const ALLOW_LIST: readonly AllowEntry[];
export const BLIND_SPOTS: readonly string[];
export const PACKAGES: readonly string[];

export function isTextPath(path: string): boolean;
export function allowedRanges(
  text: string,
): { start: number; end: number; allow: string; rules: readonly string[] | '*' }[];
export function scanText(text: string, where?: Record<string, string>): Finding[];
export function sourcesFromSourceMap(mapText: string): { source: string; content: string }[];
export function textUnitsForFile(
  shippedPath: string,
  body: string,
): { file: string; text: string }[];

export function npmShippedFilesViaPack(pkgDir: string): string[] | null;
/**
 * One `files` entry (without its leading `!`) as a matcher over published
 * paths. Exported so a guard can exercise the negation model directly.
 */
export function filesEntryMatcher(entry: string): RegExp;
export function npmShippedFilesDerived(pkgDir: string): string[];
export function hatchListsFrom(pyprojectText: string): {
  wheelPackages: string[] | null;
  sdistInclude: string[] | null;
};
export function nearestVcsIgnore(startDir: string): string | null;
export function pythonShippedFilesDerived(pkgDir: string): ArtifactFiles[];
export function pythonShippedFilesViaBuild(pkgDir: string): ArtifactFiles[] | null;
export function goShippedFiles(
  repoRoot: string,
  options?: { includeTests?: boolean },
): { files: ShippedFile[]; excludedTests: number };

export function shippedArtifacts(
  repoRoot: string,
  pkg: string,
  options?: ScanOptions,
): { package: string; artifacts: ArtifactFiles[] };
export function scanArtifact(
  pkg: string,
  artifact: ArtifactFiles,
): { findings: Finding[]; textFiles: number };
export function countByClass(findings: readonly Finding[]): Record<FindingClass, number>;
export function countsByArtifact(
  results: readonly ScannedPackage[],
): Record<string, Record<string, Record<FindingClass, number>>>;
export function scanPackages(
  repoRoot: string,
  packages?: readonly string[],
  options?: ScanOptions,
): ScannedPackage[];
export function comparePythonMethods(repoRoot: string): {
  built: Record<string, Record<FindingClass, number>>;
  derived: Record<string, Record<FindingClass, number>>;
  agrees: boolean;
  disagreements: string[];
} | null;
export function formatTable(results: readonly ScannedPackage[]): string;
export function main(argv: readonly string[]): number;
