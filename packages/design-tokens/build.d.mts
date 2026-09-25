// Types for build.mjs, so the package's tests (and anything else that imports
// the generator) are typechecked against it. Keep in step with build.mjs.

export type Mode = 'light' | 'dark';

export type ModeColour =
  | 'surface-base'
  | 'surface-raised'
  | 'surface-elevated'
  | 'surface-inset'
  | 'surface-divider'
  | 'ink-primary'
  | 'ink-secondary'
  | 'ink-muted'
  | 'ink-inverted'
  | 'status-ready'
  | 'status-busy'
  | 'status-error'
  | 'status-error-text'
  | 'status-idle'
  | 'accent-text'
  | 'island';

export type AccentColour =
  | 'accent'
  | 'accent-hover'
  | 'accent-active'
  | 'accent-fill-hover'
  | 'accent-subtle'
  | 'on-accent';

export type ModeTokens = Record<ModeColour, string> & {
  'accent-subtle-alpha': number;
  'shadow-lift': string;
  'shadow-float': string;
};

export type AccentTokens = Record<AccentColour, string> & { 'accent-ring-alpha': number };

export interface Tokens {
  accent: AccentTokens;
  modes: Record<Mode, ModeTokens>;
  radius: Record<string, string>;
  font: { sans: string[]; mono: string[]; gui?: { sans: string[]; mono: string[] } };
  fontSize: Record<string, [string, string]>;
  ease: string;
}

export declare const PACKAGE_DIR: string;
export declare const TOKENS_PATH: string;
export declare const DIST_DIR: string;
export declare const MODES: readonly Mode[];
export declare const MODE_COLOURS: readonly ModeColour[];
export declare const ACCENT_COLOURS: readonly AccentColour[];
/** [web name, canonical token] */
export declare const WEB_ALIASES: ReadonlyArray<readonly [string, string]>;
/** [tk name, canonical token] */
export declare const TK_COLOURS: ReadonlyArray<readonly [string, string]>;

export declare function loadTokens(path?: string): Tokens;
export declare function triplet(hex: string): string;
export declare function accentRing(tokens: Tokens): string;
export declare function render(tokens?: Tokens): Record<string, string>;
export declare function staleOutputs(dir?: string, rendered?: Record<string, string>): string[];
