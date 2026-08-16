// A key in a deploy template that no source file reads is a key that does
// nothing — and, when it stands in for a name the server DOES read, a feature
// that is silently off in production.
//
// `deploy-api.sh` ships `env-templates/$ROLE.env.template` verbatim as
// `/opt/driftstack/api/.env`, so the template IS the production environment on
// the rebuild path. Measured when this landed, against the production template:
// 16 of 37 keys were read nowhere outside the templates themselves.
//
// Two groups were not merely dead but WRONG, and both disable a feature:
//
//   template                        server actually reads
//   POSTMARK_SERVER_TOKEN           POSTMARK_API_TOKEN
//   POSTMARK_FROM_TRANSACTIONAL     POSTMARK_FROM
//   POSTMARK_FROM_DEFAULT           POSTMARK_REPLY_TO
//   R2_BUCKET_AVATARS               R2_BUCKET_RECORDINGS
//   R2_BUCKET_UPLOADS               R2_ENDPOINT_URL
//   R2_PUBLIC_BASE_URL              —
//
// `config.ts` builds the Postmark and R2 blocks only when every member is
// present, so the wrong names did not error — they left transactional email
// (verification, password reset, magic link) and object storage OFF. Both
// groups are corrected; this keeps them correct.
//
// The read side is DERIVED: the source corpus is scanned at runtime, so
// renaming a var in the server without renaming it in the template fails here
// rather than in production.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const TEMPLATE_DIR = resolve(REPO, 'infra', 'env-templates');

/** Where a var could legitimately be consumed from. */
const SOURCE_ROOTS = [
  join(REPO, 'apps'),
  join(REPO, 'packages'),
  join(REPO, 'infra', 'bootstrap'),
  join(REPO, 'scripts'),
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|astro|sh|service|conf|yml|yaml)$/;
const SKIP_DIR = /^(node_modules|dist|build|\.next|coverage|tests?|__tests__|env-templates)$/;

/**
 * Keys that are genuinely not read by any source file and are NOT being
 * removed here — each one is dead weight rather than a wrong name, so removing
 * them is a separate decision about the real .env files that carry them too.
 *
 * The size is pinned below. This list may shrink; it may not silently grow.
 */
const KNOWN_UNREAD = new Set<string>([
  // Vestigial signing secrets. Nothing in the source reads any of these —
  // they appear ONLY in the two templates and the real .env files.
  'SESSION_SIGNING_SECRET',
  'EMAIL_VERIFICATION_SIGNING_SECRET',
  'PASSWORD_RESET_SIGNING_SECRET',
  'MAGIC_LINK_SIGNING_SECRET',
  'WEBHOOK_DEFAULT_SIGNING_SEED',
  // Base URLs superseded by DASHBOARD_ORIGIN / CORS_ALLOWED_ORIGINS, which
  // are read.
  'PUBLIC_BASE_URL',
  'DASHBOARD_BASE_URL',
  'DOCS_BASE_URL',
  'MARKETING_BASE_URL',
  // The REST pair. The server connects over ioredis with REDIS_URL;
  // @upstash/redis is not a dependency of this repository.
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
]);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // a symlink or a file that vanished under a concurrent build
    }
    if (isDir) {
      if (!SKIP_DIR.test(entry)) walk(p, out);
    } else if (SOURCE_EXT.test(entry)) {
      out.push(p);
    }
  }
}

/** Built lazily, not at module scope: a throw here must fail ONE test, not collapse the file. */
let corpusCache: string | null = null;
function sourceCorpus(): string {
  if (corpusCache === null) {
    const files: string[] = [];
    for (const root of SOURCE_ROOTS) walk(root, files);
    corpusCache = files.map((f) => readFileSync(f, 'utf-8')).join('\n');
  }
  return corpusCache;
}

function templateFiles(): string[] {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith('.env.template'))
    .map((f) => join(TEMPLATE_DIR, f))
    .sort();
}

function keysIn(file: string): string[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l.trim())?.[1])
    .filter((k): k is string => Boolean(k));
}

const isRead = (key: string): boolean => new RegExp(`\\b${key}\\b`).test(sourceCorpus());

describe('every deploy template key is read by the server', () => {
  it('CRITICAL the corpus and the templates were both read, so an absence is measured against a real set', () => {
    expect(templateFiles().length, 'no deploy templates found').toBeGreaterThanOrEqual(2);
    expect(sourceCorpus().length, 'source corpus is empty — the walk is broken').toBeGreaterThan(
      500_000,
    );
    // The detector must be able to say YES, or every key reads as unread and
    // the exemption list below would look like the entire template.
    expect(isRead('DATABASE_URL'), 'the read-detector cannot find a var it must find').toBe(true);
    expect(isRead('ZZ_NOT_A_REAL_ENV_VAR_XYZ'), 'the read-detector says yes to anything').toBe(
      false,
    );
  });

  it('CRITICAL a key the templates define is one the server reads, or is a pinned known-unread key', () => {
    const offenders: string[] = [];
    for (const file of templateFiles()) {
      const name = file.slice(file.lastIndexOf('/') + 1);
      for (const key of keysIn(file)) {
        if (!isRead(key) && !KNOWN_UNREAD.has(key)) offenders.push(`${name}: ${key}`);
      }
    }
    expect(
      offenders.sort(),
      'these keys are shipped as production .env and read by nothing — if one stands in for a name ' +
        'the server DOES read, the feature it configures is silently off',
    ).toEqual([]);
  });

  it('CRITICAL the known-unread list is not stale, and has not silently grown', () => {
    expect(
      KNOWN_UNREAD.size,
      'entries may be removed as keys are retired; adding one needs a reason',
    ).toBe(11);
    const nowRead = [...KNOWN_UNREAD].filter((k) => isRead(k)).sort();
    expect(
      nowRead,
      'these are listed as read by nothing but the source reads them now — drop them from the list',
    ).toEqual([]);
  });
});
