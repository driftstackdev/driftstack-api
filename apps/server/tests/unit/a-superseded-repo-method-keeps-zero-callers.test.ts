// A repo method replaced by a safer sibling must keep zero callers.
//
// Twice now a TOCTOU or single-use fix has added a stronger method beside the one
// it replaces, moved every caller across, and left the original in place — on the
// repo interface, implemented by the in-memory double, fully typed, and reachable
// by anyone who reaches for the obvious name:
//
//   team-members-repo   removeMember        -> removeMemberWithInvites
//     The 2026-07-10 audit made removal transactional: it deletes the membership
//     AND cancels that member's outstanding invites in ONE transaction, so an
//     acceptInvite that read the invite before the removal cannot slip its
//     membership upsert in between and resurrect the seat. V-726 added revoking
//     every live key the member minted on the owner account to the same
//     transaction. `removeMember` does the membership DELETE alone — same
//     owner-scoped WHERE, none of the rest.
//
//   auth-flows-repo     consumeAuthToken    -> consumeAuthTokenFamily
//     The family variant claims every still-unconsumed sibling token for the
//     account, so an older or re-sent link cannot later mint a session. The single
//     variant claims one row.
//
//   sessions-repo       insertSession       -> insertSessionIfUnderLimit
//   webhooks-repo       insertEndpoint      -> insertEndpointIfUnderLimit
//     Both replacements say so themselves: the atomic variant "closes the
//     count-then-insert TOCTOU ... a bare countActiveSessions + insertSession lets
//     N concurrent creates all pass a stale count and exceed the tier cap". The
//     bare inserts do no counting and take no lock, so a production caller reaching
//     for the shorter name reopens the race two browser tabs are enough to hit.
//
// COMPLEMENTARY to every-tier-cap-has-an-atomic-backstop, not a duplicate of it.
// That guard asserts the SAFE method is reached by every file consulting a tier
// limit; this one asserts the WEAK method is not called at all. A file can satisfy
// the first — it calls the conditional insert somewhere — while also calling the
// bare insert elsewhere, and nothing there would notice.
//
// Neither replacement renamed the original, so nothing signals which one is
// correct at a call site. Both weaker methods currently have zero production
// callers, and this pins that: a new invocation of either is a deliberate act that
// has to change this file, which is the point.
//
// Discrimination is the same as unscoped-finders-admin-only-sweep: a CALL is a dot
// invocation (`repo.removeMember(`), while the definition (`async removeMember(`)
// and the interface declaration (`removeMember(id: string): Promise<...>;`) carry
// no leading dot.
//
// SCOPE: apps/server/src only. A test may legitimately call the weaker method to
// prove it still behaves; production may not.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

interface Superseded {
  readonly weak: string;
  readonly strong: string;
  readonly file: string;
}

const SUPERSEDED: readonly Superseded[] = [
  { weak: 'removeMember', strong: 'removeMemberWithInvites', file: 'db/team-members-repo.ts' },
  { weak: 'consumeAuthToken', strong: 'consumeAuthTokenFamily', file: 'db/auth-flows-repo.ts' },
  { weak: 'insertSession', strong: 'insertSessionIfUnderLimit', file: 'db/sessions-repo.ts' },
  { weak: 'insertEndpoint', strong: 'insertEndpointIfUnderLimit', file: 'db/webhooks-repo.ts' },
];

function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) listTs(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// `codeOnly` is the repo helper for this (V-1258): a commented-out call is not a
// call, and nine guards that hand-rolled their own stripper were each wrong in a
// different way. Scanning raw text would let a `// repo.removeMember(...)` note
// red this file.
const SOURCES = listTs(SRC).map((f) => ({ path: f, text: codeOnly(readFileSync(f, 'utf8')) }));

/**
 * Dot-invocations on a REPO receiver.
 *
 * ⛔ The method name alone is not enough, and this guard was caught by the very
 * hazard it exists to describe. `TeamMembersService` exposes its own
 * `removeMember`, so `routes/team.ts` calls `service.removeMember(...)` — a
 * different method that happens to share the name. Matching `\.removeMember\(`
 * flagged the route on the first run.
 *
 * So a service receiver is excluded BY NAME, deliberately and narrowly: only the
 * identifiers a service is bound to at a call site. A repo is reached as `repo.`,
 * `this.repo.`, `this.deps.repo.` or `<something>Repo.`, none of which this drops
 * — the control arm below proves that by requiring a `this.repo.` call to still
 * be flagged.
 */
const SERVICE_RECEIVERS = ['service', 'svc'];

function callers(method: string): string[] {
  const call = new RegExp(`\\.${method}\\s*\\(`);
  const viaService = new RegExp(`\\b(?:${SERVICE_RECEIVERS.join('|')})\\.${method}\\s*\\(`, 'g');
  return SOURCES.filter((s) => {
    if (!call.test(s.text)) return false;
    const stripped = s.text.replace(viaService, '');
    return call.test(stripped);
  }).map((s) => s.path.slice(SRC.length + 1));
}

describe('a superseded repo method keeps zero callers', () => {
  it('CRITICAL the scan read a real source tree and the discrimination works. Every assertion below is an absence, and an absence is satisfied by a broken walk or a regex that matches nothing. The positive control is that the REPLACEMENT is found by the same matcher that reports the weak method missing.', () => {
    expect(SOURCES.length, 'source files walked under src').toBeGreaterThan(200);
    for (const { strong } of SUPERSEDED) {
      expect(
        callers(strong).length,
        `the replacement ${strong} must be reachable by this matcher`,
      ).toBeGreaterThan(0);
    }
    // The definition itself must NOT read as a call, or every arm below is vacuous.
    expect(/\.removeMember\s*\(/.test('async removeMember(membershipId: string) {')).toBe(false);
    expect(/\.removeMember\s*\(/.test('await repo.removeMember(id, owner)')).toBe(true);
    // The service-receiver exclusion must be NARROW: a repo call through any of
    // the receiver spellings this codebase uses has to survive it, or the arm
    // below silently stops guarding anything.
    for (const spelling of ['repo', 'this.repo', 'this.deps.repo', 'teamMembersRepo']) {
      const line = `await ${spelling}.removeMember(id, owner)`;
      const stripped = line.replace(
        new RegExp(`\\b(?:${SERVICE_RECEIVERS.join('|')})\\.removeMember\\s*\\(`, 'g'),
        '',
      );
      expect(
        /\.removeMember\s*\(/.test(stripped),
        `${spelling} must still read as a repo call`,
      ).toBe(true);
    }
  });

  it('CRITICAL no production code calls a superseded method. Reaching for the shorter name is the natural mistake, and it silently drops whatever the replacement added -- see the header for what each pair costs. Every weak method here does a real, correctly-scoped write, so nothing at the call site looks wrong; it simply does less than the method that replaced it. The failure message names the pair, so this title does not enumerate them and cannot go stale as the roster grows.', () => {
    const offenders: string[] = [];
    for (const { weak, strong } of SUPERSEDED) {
      for (const f of callers(weak)) offenders.push(`${f} calls ${weak} (use ${strong})`);
    }
    expect(offenders, 'superseded repo method(s) called from production:').toEqual([]);
  });

  it("CRITICAL every roster weak-name is declared in exactly ONE db file. The matcher below is keyed on a BARE METHOD NAME, so it discriminates only while that name is unique across repos — and several method names here are not (`purgeForTerminatedAccountsBefore` is declared on three). Adding such an entry makes the zero-callers arm report another repo's legitimate calls as offenders: measured 2026-08-28, a probe entry for that name produced `lib/bootstrap.ts` and `services/account-deletion-purge-sweeper.ts` as false offenders, both calling the profiles and snapshots methods of the same name. This arm makes the key's assumption explicit, so a shared name fails HERE with a reason instead of two files away with a wrong accusation.", () => {
    const dbDir = resolve(SRC, 'db');
    const dbFiles = readdirSync(dbDir).filter((f) => f.endsWith('.ts'));
    // Floor first: a broken read would find zero declarations of everything and
    // report every name as unique, which is the reassuring direction.
    expect(dbFiles.length, 'files read out of src/db').toBeGreaterThan(20);
    const shared = SUPERSEDED.map(({ weak }) => {
      const declaring = dbFiles.filter((f) =>
        new RegExp(`\\basync\\s+${weak}\\s*\\(`).test(readFileSync(resolve(dbDir, f), 'utf8')),
      );
      return { weak, declaring };
    }).filter(({ declaring }) => declaring.length !== 1);
    expect(
      shared.map((s) => `${s.weak} declared in ${s.declaring.length}: ${s.declaring.join(', ')}`),
      'roster weak-name(s) that are not unique across src/db — the bare-name matcher cannot attribute a call to the right repo:',
    ).toEqual([]);
  });

  it('CRITICAL every roster entry still names a live pair. An entry whose weak method was deleted is a fossil that makes this file look broader than it is, and an entry whose REPLACEMENT vanished means the supersession was undone -- in which case the zero-caller rule above is enforcing the wrong thing.', () => {
    const stale: string[] = [];
    for (const { weak, strong, file } of SUPERSEDED) {
      const body = readFileSync(resolve(SRC, file), 'utf8');
      if (!new RegExp(`async ${weak}\\s*\\(`).test(body))
        stale.push(`${file}: ${weak} no longer defined`);
      if (!new RegExp(`async ${strong}\\s*\\(`).test(body))
        stale.push(`${file}: ${strong} no longer defined`);
    }
    expect(stale, 'roster entries that no longer describe a real pair:').toEqual([]);
  });
});
