// An extension cannot overwrite the envelope it travels in.
//
// `ApiError.extensions` is an open `Record<string, unknown>` filled per call
// site — `retry_after_seconds`, `cap_cents`, `active_session_id` and so on —
// and `toProblem()` spreads it into the RFC 7807 body. It used to spread it
// LAST, after type / title / status / detail / instance. So an extension named
// after any of those five silently replaced the real member.
//
// `status` is the one that bites. The error handler does
// `reply.code(problem.status)` — it reads the ALREADY-SPREAD object — so
// `extensions: {status: 'pending'}` would not merely mislabel the body, it
// would set the HTTP status code of the response from an extension, and pass a
// string to `reply.code()`.
//
// The corruption is silent in both directions. The TypeScript SDK builds its
// `.extensions` bag by EXCLUDING exactly these five names
// (`packages/sdk-typescript/src/errors.ts`, `extensionMembers`), so a
// reserved-named extension would overwrite the wire field AND never surface as
// an extension client-side. Nothing anywhere reports the collision.
//
// NOT CURRENTLY TRIGGERED, and that is worth stating plainly rather than
// implying a live incident. All 18 extension keys in use across the server
// source were enumerated — active_session_id, cap_bytes, cap_cents,
// current_sessions, from, issues, limit, pending_acceptances, reason,
// requires_mfa_step_up, resource, retry_after_seconds, spent_cents, tier,
// timeout_ms, transition, used_bytes, winner_client_id — and none is reserved.
// So this is a guard against the next edit, like
// `every-rate-limit-bucket-key-exists`, not a fix for a live defect. `status` is
// a very plausible next extension name (session status, order status,
// subscription status), which is what makes it worth closing now.
//
// The fix strips reserved names AND spreads first. Stripping alone would leave
// the two optional members reachable: with `detail` undefined on the error, a
// conditional spread contributes nothing, so an extension named `detail` would
// still land. Spreading first alone would leave those same two members
// shadowable for the same reason. Both together close it.
//
// The reserved set is DERIVED from `ProblemSchema.shape`, not restated here or
// in the source, so a member added to the schema is protected without anyone
// remembering to update a list.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES, ProblemSchema } from '@driftstack/api-types';
import { ApiError } from '../../src/lib/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

const RESERVED = Object.keys(ProblemSchema.shape);

/** Every `extensions: { … }` literal's keys across the server source. */
function extensionKeysInSource(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/extensions:\s*\{/g)) {
        // Skip matches inside a comment. Prose about this very hazard contains
        // `extensions: {status: …}`, and counting it reported a collision that
        // does not exist. Line-based rather than a comment-stripping pass: a
        // regex that removes comment spans also eats `/*` inside string
        // literals, which silently shrinks the population being scanned.
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const linePrefix = text.slice(lineStart, match.index).trimStart();
        if (linePrefix.startsWith('//') || linePrefix.startsWith('*')) continue;
        // Walk to the matching brace so nested objects do not end the block early.
        let depth = 0;
        let end = match.index + match[0].length - 1;
        for (let i = end; i < Math.min(end + 2000, text.length); i += 1) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const block = text.slice(match.index, end + 1);
        // Both `key:` and SHORTHAND `key` (followed by , or }). Requiring the
        // colon missed `extensions: { issues }` and `{ current_sessions, limit }`
        // entirely — and shorthand is the form a collision would most likely
        // take, since `extensions: { status }` is what you write when a local
        // variable is already named `status`. A scanner blind to the likeliest
        // spelling of the bug is a scanner that reports clean because it looked
        // in the wrong shape, not because nothing is wrong.
        for (const km of block.matchAll(/[{,]\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*(?::|,|\}|$)/gm)) {
          out.push({ key: km[1]!, file: full.slice(SERVER_SRC.length + 1) });
        }
      }
    }
  };
  walk(SERVER_SRC);
  return out;
}

describe('an extension cannot shadow a reserved problem member', () => {
  it('CRITICAL the reserved set was derived and is the five RFC 7807 members. Every assertion below is "not in this set" — an empty or truncated set would make each of them vacuously true, reporting the envelope protected while protecting nothing.', () => {
    expect(RESERVED.length, 'members read from ProblemSchema.shape').toBe(5);
    expect([...RESERVED].sort(), 'and they are the RFC 7807 five').toEqual([
      'detail',
      'instance',
      'status',
      'title',
      'type',
    ]);
  });

  it('CRITICAL a reserved-named extension does not replace the real member. This is the defect the spread order allowed: the error handler sets the response code from problem.status, so an extension named status set the HTTP status — here, a string where a number is typed.', () => {
    const err = new ApiError({
      type: PROBLEM_TYPES.Conflict,
      title: 'Conflict',
      status: 409,
      detail: 'the real detail',
      extensions: { status: 'pending', title: 'not the title', type: 'not the type' },
    });
    const problem = err.toProblem('req-1');

    expect(problem.status, 'the real status survives').toBe(409);
    expect(problem.title, 'the real title survives').toBe('Conflict');
    expect(problem.type, 'the real type survives').toBe(PROBLEM_TYPES.Conflict);
    expect(problem.detail, 'and the real detail survives').toBe('the real detail');
  });

  it('CRITICAL the OPTIONAL members are protected too, which stripping alone would miss. With detail undefined on the error, the conditional spread contributes nothing — so an extension named detail would land in a field the error deliberately omitted, inventing a human-readable explanation the server never wrote.', () => {
    const err = new ApiError({
      type: PROBLEM_TYPES.NotFound,
      title: 'Not Found',
      status: 404,
      extensions: { detail: 'invented', instance: 'invented' },
    });
    const problem = err.toProblem();

    expect(problem.detail, 'no detail is invented').toBeUndefined();
    expect(problem.instance, 'no instance is invented').toBeUndefined();
  });

  it('CRITICAL a NON-reserved extension is still carried through. The fix filters a set; a fix that dropped extensions wholesale would pass every assertion above while removing the retry hints and quota numbers customers actually read.', () => {
    const err = new ApiError({
      type: PROBLEM_TYPES.RateLimited,
      title: 'Too Many Requests',
      status: 429,
      extensions: { retry_after_seconds: 30, cap_cents: 2000 },
    });
    const problem = err.toProblem('req-2') as Record<string, unknown>;

    expect(problem['retry_after_seconds'], 'the retry hint survives').toBe(30);
    expect(problem['cap_cents'], 'and so does the quota number').toBe(2000);
    expect(problem['instance'], 'while instance is still the one passed in').toBe('req-2');
  });

  it('CRITICAL no call site in the server source names an extension after a reserved member. The runtime now strips them, so such a key would be silently DROPPED rather than silently overwriting — a quieter bug than the one being fixed. Catching it in source keeps the mistake impossible to ship either way.', () => {
    const found = extensionKeysInSource();
    // MEASURED: 18 distinct keys across the server source. A floor here is what
    // separates "no call site is wrong" from "no call site was read". It was 16
    // before shorthand properties were counted; the two it had been missing,
    // `issues` and `limit`, are exactly the spelling a real collision would use.
    expect(new Set(found.map((f) => f.key)).size, 'distinct extension keys found').toBeGreaterThan(
      14,
    );

    const collisions = found
      .filter((f) => RESERVED.includes(f.key))
      .map((f) => `${f.file} sets extension '${f.key}'`)
      .sort();
    expect(collisions, 'extension key(s) named after a reserved RFC 7807 member:').toEqual([]);
  });
});
