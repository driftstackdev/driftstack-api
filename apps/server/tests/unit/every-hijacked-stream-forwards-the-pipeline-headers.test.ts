// Every hijacked stream forwards what the pipeline computed, not just the one
// that was tested.
//
// `reply.hijack()` hands the socket to the route, so Fastify never flushes its
// header store and no `onSend` hook runs. Everything decided upstream — the
// request id, the rate-limit accounting for the token the connection just spent
// — is computed and thrown away.
//
// There are FOUR hijack sites across three route files, and the live test that
// found this covers exactly one of them. Fixing the file where a defect is
// observed, and stopping there, leaves the same bug in the three places nobody
// happened to open. So this is the repo-wide half: it derives the hijack sites
// from the source and asserts each one forwards.
//
// What each site looked like before:
//
//   account-notifications  no forwarding at all
//   status-stream          no forwarding at all
//   agent-sessions x2      one had none; the other hand-copied
//                          `reply.getHeaders()` minus content-length — the right
//                          instinct, and it STILL missed the request id, because
//                          an onSend hook sets that one and it is therefore not
//                          on the reply at hijack time. That near-miss is why
//                          the helper is shared rather than re-derived per site.
//
// Every one of the four carried a comment saying the hijack bypasses
// `@fastify/cors`'s onSend hook, and hand-set the CORS header because of it. The
// mechanism was understood at all four sites and the conclusion was drawn about
// exactly one hook.
//
// DERIVED, not listed. The sites come from scanning for `reply.raw.writeHead`
// in the server source, so a fifth stream added next month fails here without
// anyone remembering this file exists — which is the only way a guard like this
// keeps working.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

interface WriteHeadSite {
  file: string;
  line: number;
  /** The writeHead object literal, brace-matched. */
  block: string;
}

/** Every `reply.raw.writeHead(` call in the server source, with its block. */
function writeHeadSites(): WriteHeadSite[] {
  const out: WriteHeadSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/reply\.raw\.writeHead\(/g)) {
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const prefix = text.slice(lineStart, match.index).trimStart();
        if (prefix.startsWith('//') || prefix.startsWith('*')) continue;

        const braceAt = text.indexOf('{', match.index);
        if (braceAt === -1) continue;
        let depth = 0;
        let end = braceAt;
        for (let i = braceAt; i < Math.min(braceAt + 4000, text.length); i += 1) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        out.push({
          file: full.slice(SERVER_SRC.length + 1),
          line: text.slice(0, match.index).split('\n').length,
          block: text.slice(braceAt, end + 1),
        });
      }
    }
  };
  walk(SERVER_SRC);
  return out;
}

describe('every hijacked stream forwards the pipeline headers', () => {
  it('CRITICAL the scan found the streams. The assertion below is "none of these is missing the helper", and an empty scan has none of anything — a regex that stopped matching would report every stream correct having read no stream at all.', () => {
    const sites = writeHeadSites();
    // MEASURED: 4 sites across account-notifications, status-stream and
    // agent-sessions (x2).
    expect(sites.length, 'reply.raw.writeHead sites found').toBeGreaterThanOrEqual(4);
    const files = new Set(sites.map((s) => s.file));
    expect(files.size, 'spread across more than one route file').toBeGreaterThanOrEqual(3);
    expect(
      sites.every((s) => s.block.length > 50),
      'and each block was brace-matched to something substantial',
    ).toBe(true);
  });

  it('CRITICAL every hijacked stream spreads the shared helper. Fixing only the file where the defect was observed would have left this bug in the three sites nobody opened — and each of those already carried a comment proving its author knew the hijack bypasses onSend hooks.', () => {
    const missing = writeHeadSites()
      .filter((s) => !s.block.includes('hijackedReplyHeaders(reply)'))
      .map((s) => `${s.file}:${String(s.line)}`)
      .sort();
    expect(
      missing,
      'hijacked stream(s) that drop the request id and rate-limit accounting:',
    ).toEqual([]);
  });

  it('CRITICAL the helper is the FIRST entry at every site. Spread last, it overrides the content-type and cache-control the stream deliberately sets — and one site had it last, which no assertion here caught until the ordering was checked directly rather than assumed from "the helper is present".', () => {
    const outOfOrder = writeHeadSites()
      .filter((s) => {
        const entries = s.block
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && l !== '{' && !l.startsWith('//') && !l.startsWith('*'));
        return entries[0] !== '...hijackedReplyHeaders(reply),';
      })
      .map((s) => `${s.file}:${String(s.line)}`)
      .sort();
    expect(outOfOrder, 'site(s) where the inherited headers are not spread first:').toEqual([]);
  });

  it('CRITICAL no site re-derives the forwarding by hand. One of the four already copied reply.getHeaders() itself and still lost the request id, because an onSend hook sets that one after hijack time. A second implementation is how that subtlety gets rediscovered the hard way.', () => {
    // CODE only. The first version of this arm matched the COMMENT left at the
    // fixed site — "was a bespoke copy of reply.getHeaders()" — and reported a
    // hand-rolled implementation that no longer exists. A guard that reads prose
    // as code fails on the explanation of its own fix.
    const codeOnly = (block: string): string =>
      block
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith('//') && !trimmed.startsWith('*');
        })
        .join('\n');

    const handRolled = writeHeadSites()
      .filter((s) => codeOnly(s.block).includes('reply.getHeaders()'))
      .map((s) => `${s.file}:${String(s.line)}`)
      .sort();
    expect(
      handRolled,
      'writeHead site(s) copying reply headers instead of using the helper:',
    ).toEqual([]);
  });
});
