// The Network pane is about to start holding a category, and the policy has to
// already list it.
//
// T-9's receive path — store, relay, route — has been built and deployed for a
// while; the producer in the browser is committed but switched off behind a
// node-side flag, so the pane has always been empty. The moment that flag flips,
// the control plane holds, in memory, the request line of every resource a
// Session's browser loads: the address (query string included), the method, the
// status, the negotiated protocol, timing and size.
//
// `apps/marketing-site/src/pages/about.astro` publishes this sentence:
//
//     Our privacy policy lists every category in full
//
// That is a claim about a different file, and it was true right up until the
// pane starts filling. The privacy policy had no row for live network metadata,
// so flipping the flag would have made a published legal claim false without
// touching the file that makes it — the failure mode where nothing looks wrong
// in either document on its own.
//
// ── WHY THIS IS NOT ANOTHER CONTENT-PARITY PIN ───────────────────────────────
//
// The four privacy content-parity guards each read one copy of one document and
// assert its wording is still there. All four passed the whole time the gap
// existed, and would keep passing if the pane shipped tomorrow, because a pin
// cannot notice a category that was never written down. So this reads the two
// sides that have to agree and were never read together:
//
//   • the CLAIM (about.astro) against the DOCUMENT it names, and
//   • the DOCUMENT against the CODE whose behaviour it describes — the ring cap,
//     the session cap and the idle window are stated as figures in the policy,
//     and a figure in a legal document is a promise, so it is measured from the
//     constant rather than pinned as text.
//
// The no-headers / no-bodies / no-cookies sentence gets the same treatment, and
// it needs the MOST care, because the obvious version of it is false.
//
// ⛔ IT IS NOT TRUE BY CONSTRUCTION OF THE WIRE. `NetworkRequestsFrameSchema`
// types `entries` as `z.array(z.unknown())` deliberately — one malformed row
// must not fail the array parse and drop a whole frame, blanking the pane and
// reading as "the fork emits nothing". So a report MAY carry entry objects with
// any extra keys, headers or a cookie string included, and they are transmitted
// to and parsed by the control plane. What actually protects the customer is the
// relay's per-entry `NetworkRequestEntrySchema.safeParse`, which strips unknown
// keys before a row is held, served, or logged. That is a validation-time
// discard, not a structural impossibility, and the policy must assert the weaker
// of the two — which it now does, scoped to "the entry format Driftstack
// validates and holds".
//
// So this reads BOTH halves of the mechanism that makes the sentence true: the
// entry schema's field list (no field could carry any of them), AND the frame
// schema's `z.unknown()` plus the relay's per-entry strip (extra keys never
// survive validation). An arm that read only the entry schema could never see
// the half of the claim that was wrong — which is exactly how the over-claim
// shipped past a green guard.
//
// ── WHAT IS DELIBERATELY NOT ASSERTED ────────────────────────────────────────
//
// "Lists EVERY category in full" cannot be mechanically verified — no test knows
// the true set of categories a company holds. What is verifiable is the half
// that was actually wrong: the one category the pane is about to start holding
// is in the policy the sentence points at. A future category will need the same
// treatment, and this guard will not find it; the about.astro sentence is a
// standing commitment that someone has to honour each time, not a thing a test
// can discharge once.
//
// The negatives at the end are the other half of honesty. The protection here is
// real but bounded, and the section must not claim more than the code does:
// entries are not encrypted at rest (they are in a process's heap), are not
// dropped at the instant a Session ends (the store's `delete` is deliberately
// not wired to terminal-close — TTL and LRU are the backstop, and the READ path
// is what stops serving), and are not anonymous.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NETWORK_LOG_RING_MAX_ENTRIES,
  NetworkRequestEntrySchema,
} from '../../src/schemas/harness-control-protocol.js';
import { NETWORK_LOG_SESSION_TTL_MS } from '../../src/services/session-network-log-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** The policy ships twice. Both copies are published; both have to disclose it. */
const POLICIES: ReadonlyArray<readonly [string, string]> = [
  ['published', resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md')],
  ['canonical', resolve(REPO_ROOT, 'docs/legal/privacy-policy.md')],
];
const ABOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');
const STORE_SRC = resolve(REPO_ROOT, 'apps/server/src/services/session-network-log-store.ts');
const PROTOCOL_SRC = resolve(REPO_ROOT, 'apps/server/src/schemas/harness-control-protocol.ts');
/** Where the deployed store is actually constructed — see `maxSessionsInUse()`. */
const BOOTSTRAP_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
/** The per-entry strip that makes the no-headers/bodies/cookies sentence true. */
const RELAY_SRC = resolve(REPO_ROOT, 'apps/server/src/services/session-network-log-relay.ts');
/** The only account-path gate on GET /v1/agent-sessions/:id/network. */
const ROUTES_SRC = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * A prose phrase as a wrap-tolerant RegExp: metacharacters escaped, then every
 * run of whitespace matched as `\s+`.
 *
 * Every sentence asserted here is hard-wrapped markdown, and the wrap point is
 * not stable — Prettier owns it, the sentences around it grow, and a re-wrap
 * moves it without changing a word. A regex written against one wrap reds at the
 * push gate for a document nobody edited, which trains the next person to loosen
 * the assertion rather than read it. Writing the phrase and deriving the pattern
 * keeps the assertion at full strength and immune to the wrap.
 */
const ws = (phrase: string): RegExp =>
  new RegExp(
    phrase
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+'),
  );

/**
 * The `NetworkRequestEntrySchema` object literal, on its own. Bounded at the
 * closing `});` so a neighbouring schema cannot contribute a field — or, worse,
 * absorb the absence assertions below into a region where they are trivially
 * true.
 */
function entrySchemaBlock(): string {
  const src = read(PROTOCOL_SRC);
  const start = src.indexOf('export const NetworkRequestEntrySchema = z.object({');
  const end = src.indexOf('\n});', start);
  return start === -1 || end === -1 ? '' : src.slice(start, end + 4);
}

/** The argument list `lib/bootstrap.ts` constructs the deployed store with. */
function storeConstructionArgs(): string {
  const m = /new\s+SessionNetworkLogStore\(([^)]*)\)/.exec(read(BOOTSTRAP_SRC));
  expect(
    m,
    'bootstrap.ts no longer constructs SessionNetworkLogStore — find the new construction site before trusting any published figure about it',
  ).not.toBeNull();
  return (m?.[1] ?? '').trim();
}

/**
 * The cross-session LRU ceiling the DEPLOYED server runs with, in Sessions.
 *
 * ⛔ The store's CONSTRUCTOR DEFAULT is not the answer on its own, and reading
 * only that is how a number published in a legal document gets falsified by a
 * one-word edit somewhere else while this guard stays green. The bound actually
 * in force is whatever the construction site passes; today it passes nothing, so
 * the default applies — but `new SessionNetworkLogStore(1_000)` in bootstrap
 * would change what 5,000 Sessions means without touching the store at all.
 *
 * Contrast the other two figures in the same arm, which import
 * NETWORK_LOG_RING_MAX_ENTRIES and NETWORK_LOG_SESSION_TTL_MS directly and so
 * have always been bound to the value in use. This closes the same loop on the
 * one figure whose source is indirect: the call site first, the default only
 * when the call site declines to override it.
 */
function maxSessionsInUse(): number {
  const args = storeConstructionArgs();
  if (args !== '') {
    const first = (args.split(',')[0] ?? '').trim();
    expect(
      first,
      'bootstrap passes a maxSessions override that is not a numeric literal — re-derive the figure the policy publishes by hand rather than letting this arm guess',
    ).toMatch(/^[0-9_]+$/);
    return Number(first.replace(/_/g, ''));
  }
  const fallback = /maxSessions\s*=\s*([0-9_]+)/.exec(read(STORE_SRC))?.[1];
  expect(fallback, "the store's maxSessions constructor default").toBeDefined();
  return Number((fallback ?? '').replace(/_/g, ''));
}

/** A figure the policy states, read back as a number ("2,000" → 2000). */
function figure(body: string, re: RegExp, label: string): number {
  const raw = re.exec(body)?.[1];
  expect(raw, `${label}: the policy sentence stating this figure was not found`).toBeDefined();
  return Number((raw ?? '').replace(/,/g, ''));
}

describe('the Network pane holds a category the privacy policy lists', () => {
  it('CRITICAL every file this reads is the real one. Each arm below asks whether a sentence is present, and a path that silently read the wrong file — or an empty one — would report the two documents in perfect agreement about nothing.', () => {
    for (const [label, path] of POLICIES) {
      const body = read(path);
      expect(body.length, `${label} policy length`).toBeGreaterThan(20_000);
      expect(body, `${label} policy is the privacy policy`).toMatch(/## 9\. Retention/);
    }
    expect(read(ABOUT), 'about.astro is the about page').toMatch(/privacy policy<\/a>/);
    expect(entrySchemaBlock().length, 'NetworkRequestEntrySchema block').toBeGreaterThan(200);
    expect(entrySchemaBlock(), 'and it is the entry schema, not a neighbour').toMatch(
      /protocol:\s*NetworkRequestProtocolSchema,?/,
    );
    expect(maxSessionsInUse(), 'maxSessions the deployed store runs with').toBeGreaterThan(0);
    expect(read(RELAY_SRC).length, 'the relay source').toBeGreaterThan(1_000);
    expect(read(ROUTES_SRC), 'the agent-sessions routes file').toMatch(
      /'\/v1\/agent-sessions\/:id\/network'/,
    );
    // The helper has to be able to fail. A `ws()` that matched everything would
    // make every prose assertion below vacuous while reading perfectly.
    expect('a  b\nc', 'ws() spans a wrap').toMatch(ws('a b c'));
    expect('a b d', 'ws() still discriminates').not.toMatch(ws('a b c'));
  });

  it('CRITICAL both published copies list live network metadata as a data category, with an in-memory, life-of-the-Session retention. This is the row the pane makes necessary: while it is absent, switching the producer on means holding a category the policy does not disclose — and about.astro publishes a sentence saying it discloses them all.', () => {
    for (const [label, path] of POLICIES) {
      const body = read(path);
      expect(body, `${label}: §3 category heading`).toMatch(
        ws('### 3.12 Live network metadata (Network pane)'),
      );
      expect(body, `${label}: §3.12 retention paragraph`).toMatch(
        ws('**Retention:** live network metadata is **not stored**.'),
      );
      expect(body, `${label}: §3.12 in-memory boundary`).toMatch(
        ws(
          "held in the control-plane API server's memory only — never written to a database, to object storage, or to any store that outlives the server process, and never written to a log line.",
        ),
      );
      // ⛔ The row says "held in the API server's memory only", NOT "for the
      // life of the Session only", and the difference is the whole point of
      // pinning it. Nothing drops a Session's ring at terminal-close —
      // `SessionNetworkLogStore.delete()` is never called in src, and the only
      // eviction is the TTL sweep that runs INSIDE `append()`. Entries outlive
      // the Session by at least the 30-minute idle window, and in a process that
      // receives no further accepted append they are held until restart. The
      // §3.12 body always stated that correctly; the retention TABLE is the half
      // a regulator reads as operative, so it has to state the same boundary.
      expect(body, `${label}: §9 retention row`).toMatch(
        ws(
          "| Live network metadata | Not stored by Driftstack; held in the API server's memory only, served only while the Session is running, and retained after the Session ends until swept — on the next report the server receives — once 30 idle minutes have passed, or discarded on process restart.",
        ),
      );
      expect(body, `${label}: §9 does not reinstate the life-of-Session claim`).not.toMatch(
        /for the life of the Session only/,
      );
      expect(body, `${label}: §4 names it as a Special-Category route`).toMatch(
        ws('pass through live-session media, live network metadata, or an API Capture request'),
      );
    }
  });

  it('CRITICAL about.astro\'s "lists every category in full" reads together with the policy it links to. The sentence is a claim about another file, so it cannot be checked in the file that makes it — that is why it survived the gap. Neither half may move alone: drop the policy row and this fails, soften the sentence and this fails.', () => {
    const about = read(ABOUT);
    expect(about, 'the published completeness claim').toMatch(ws('lists every category in full'));
    expect(about, 'and it points at the policy checked above').toMatch(/href="\/legal\/privacy\/"/);
    // The referent: the category the claim is currently exposed on.
    const published = read(POLICIES[0]![1]);
    expect(published, 'the policy the sentence names lists the category').toContain(
      'Live network metadata',
    );
  });

  it('CRITICAL the figures the policy publishes are the figures the code enforces. A number in a privacy policy is a promise, so it is measured from the constant rather than pinned as text — lowering a cap silently would leave the document overstating what is held, and raising one would leave it understating.', () => {
    for (const [label, path] of POLICIES) {
      const body = read(path);
      expect(
        figure(body, /At\s+most\s+([\d,]+)\s+entries\s+are\s+held/, `${label} ring cap`),
        `${label}: published per-Session entry cap vs NETWORK_LOG_RING_MAX_ENTRIES`,
      ).toBe(NETWORK_LOG_RING_MAX_ENTRIES);
      expect(
        figure(body, /at\s+most\s+([\d,]+)\s+Sessions'\s+entries\s+at\s+once/, `${label} LRU`),
        `${label}: published concurrent-Session cap vs the maxSessions the deployed store is constructed with`,
      ).toBe(maxSessionsInUse());
      expect(
        figure(body, /once\s+(\d+)\s+minutes\s+have\s+passed/, `${label} idle window`),
        `${label}: published idle window vs NETWORK_LOG_SESSION_TTL_MS`,
      ).toBe(NETWORK_LOG_SESSION_TTL_MS / 60_000);
    }
    // And the construction site itself, stated rather than inferred. The two
    // caps above that import a constant are bound to the value in use by that
    // import; the 5,000 is not, so the fact it is the DEFAULT that applies — no
    // positional override in bootstrap — is the assertion that makes it so.
    expect(
      storeConstructionArgs(),
      'bootstrap constructs SessionNetworkLogStore with no positional override, which is why the store default IS the deployed 5,000-Session bound',
    ).toBe('');
  });

  it('CRITICAL "no headers, no bodies, no cookies" is bound to BOTH halves of what makes it true: the entry schema defines no such field, AND the relay strips every unknown key per entry before a row is held. The frame schema is `z.array(z.unknown())` on purpose, so the wire CAN carry them — an arm that read only the entry schema could never see the half of the claim that would be wrong.', () => {
    const block = entrySchemaBlock();
    // Positive control first: the fields that ARE carried, so an empty or
    // mis-sliced block cannot make the three absences below pass vacuously.
    for (const field of ['id:', 'url:', 'method:', 'status:', 'started_at:']) {
      expect(block, `carried field missing from the schema block: ${field}`).toContain(field);
    }
    expect(block, 'no header field in the entry format').not.toMatch(/\bheaders?\s*:/i);
    expect(block, 'no body field in the entry format').not.toMatch(/\bbod(?:y|ies)\s*:/i);
    expect(block, 'no cookie field in the entry format').not.toMatch(/\bcookies?\s*:/i);

    // ── The half the published sentence used to overstate ────────────────────
    // The FRAME accepts raw entries. This is deliberate (one malformed row must
    // not fail the array parse and drop the whole frame), and it is exactly why
    // the policy may not say the wire cannot carry a header or a cookie: a
    // report legitimately may, and the control plane parses it.
    const protocol = read(PROTOCOL_SRC);
    expect(
      protocol,
      'the frame still accepts raw entries, so the wire is NOT the guarantee',
    ).toMatch(/entries:\s*z\.array\(\s*z\.unknown\(\)\s*\)/);
    // …so the guarantee is the relay's PER-ENTRY parse. zod strips unknown keys
    // on a non-strict object (3.25.76, verified), so a header or cookie key sent
    // alongside the real fields never reaches `valid`, the ring, the route, or a
    // log line. Both sides are asserted: the parse, and the fact that what is
    // kept is the PARSED value rather than the raw row.
    const relay = read(RELAY_SRC);
    expect(relay, 'the relay validates each entry against the canonical entry schema').toMatch(
      /NetworkRequestEntrySchema\.safeParse\(\s*raw\s*\)/,
    );
    expect(relay, 'and keeps parsed.data — the stripped row — not the raw one').toMatch(
      /valid\.push\(\s*parsed\.data\s*\)/,
    );
    expect(relay, 'the raw row is never pushed through unvalidated').not.toMatch(
      /valid\.push\(\s*raw\s*\)/,
    );
    // Executable proof of the strip rather than a claim about zod's defaults: if
    // a later zod major stopped stripping, every assertion above would still
    // pass and the published sentence would be false.
    const stripped = NetworkRequestEntrySchema.safeParse({
      id: 'r1',
      url: 'https://example.test/a',
      method: 'GET',
      status: 200,
      protocol: 'h2',
      started_at: 1,
      headers: { cookie: 'session=secret' },
      body: 'response bytes',
      cookies: 'a=b',
    });
    expect(stripped.success, 'an entry with extra keys still validates').toBe(true);
    expect(
      Object.keys(stripped.success ? stripped.data : {}).sort(),
      'the extra keys are discarded at validation, before anything is held, served, or logged',
    ).toEqual(['id', 'method', 'protocol', 'started_at', 'status', 'url']);

    for (const [label, path] of POLICIES) {
      const body = read(path);
      expect(body, `${label}: the sentence the entry schema makes true`).toMatch(
        ws(
          'The entry format Driftstack validates and holds defines no request or response headers, no request or response bodies, and no cookies.',
        ),
      );
      expect(body, `${label}: and the discard that makes the rest of it true`).toMatch(
        ws(
          'Any other field a report carries is discarded when the entry is validated — before it is held, served, or logged',
        ),
      );
      // The stronger, false version must not come back.
      expect(body, `${label}: no claim that the wire cannot carry them`).not.toMatch(
        /The wire format carries no request or response headers/,
      );
      expect(body, `${label}: no claim that the fields cannot be reported`).not.toMatch(
        /Those fields do not exist in it/,
      );
    }
  });

  it("CRITICAL §3.12 Recipients names every path the route's gate actually admits. The sentence ends \"and to no one else\" — an absolute that occurs nowhere else in this policy, so it is the one a reader treats as exhaustive. The account path does NOT stop at the owning account: `callerCanAccessAgentSession` also returns true for a DIFFERENT account holding an admin-role membership on the owner's team, and that is a real, reachable read of another account's network entries.", () => {
    const routes = read(ROUTES_SRC);
    // The gate, read where it is defined: self OR an admin-role team membership.
    // `ctx.teams` is memberships on OTHER accounts' teams, resolved server-side,
    // so this is genuinely a second account and not the owner wearing a header.
    expect(routes, 'the gate still admits self').toMatch(
      /if\s*\(\s*ownerAccountId\s*===\s*ctx\.account\.id\s*\)\s*return true;/,
    );
    expect(routes, 'and still admits an admin-role team member of the owner').toMatch(
      /membership\s*!==\s*undefined\s*&&\s*membership\.role\s*===\s*'admin'/,
    );
    // …and that this is the gate the network route uses, not a neighbour's.
    const routeStart = routes.indexOf("'/v1/agent-sessions/:id/network'");
    expect(routeStart, 'the network route is registered here').toBeGreaterThan(0);
    const routeBlock = routes.slice(routeStart, routeStart + 2_000);
    expect(routeBlock, 'the network route gates the account path through that helper').toMatch(
      /callerCanAccessAgentSession\(\s*ctx,\s*rec\.accountId\s*\)/,
    );

    for (const [label, path] of POLICIES) {
      const body = read(path);
      expect(body, `${label}: the absolute is still the sentence being made`).toMatch(
        ws('and to no one else.'),
      );
      expect(body, `${label}: the owning account`).toMatch(
        ws('which serves them to the account that owns the Session,'),
      );
      expect(body, `${label}: the team-admin path the gate admits`).toMatch(
        ws("to any account the Customer has given the admin role on that account's team,"),
      );
      expect(body, `${label}: the control-key path`).toMatch(
        /to\s+the\s+single-Session\s+control\s+key\s+the\s+GUI\s+[Cc]lient\s+holds\s+for\s+it/,
      );
    }
  });

  it("CRITICAL the section does not overstate the protection. The entries sit in a process heap, the store's `delete` is deliberately NOT wired to terminal-close (the read path is what stops serving, and TTL + LRU are the backstop), and every row is scoped by Session id and owning account. A legal surface that claims more than the code does is worse than one that claims less.", () => {
    for (const [label, path] of POLICIES) {
      const body = read(path);
      expect(body, `${label}: no at-rest encryption claim`).not.toMatch(
        /network metadata is (?:end-to-end )?encrypted (?:at rest|end-to-end)/i,
      );
      expect(body, `${label}: no instant-delete-on-session-end claim`).not.toMatch(
        /live network metadata is (?:deleted|dropped|erased) (?:the moment|as soon as|when) the Session ends/i,
      );
      expect(body, `${label}: no anonymity claim`).not.toMatch(
        /live network metadata (?:is|are) (?:anonymous|anonymised)/i,
      );
      // What it DOES say about the end of a Session is the checkable half: the
      // endpoint stops serving. That is the route's own `status !== 'active'`
      // branch, not a claim about when memory is freed.
      expect(body, `${label}: the serving boundary is the one stated`).toMatch(
        ws('serves entries only while the Session is running and returns none once it is not.'),
      );
    }
  });
});
