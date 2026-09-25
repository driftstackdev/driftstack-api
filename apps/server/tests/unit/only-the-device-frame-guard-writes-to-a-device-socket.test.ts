// Only the device frame guard writes to a device's control socket.
//
// The device closes its whole control socket — every session on it — when a
// message is larger than it reads. `services/device-frame-guard.ts` measures
// every control-plane → device frame and refuses one that is too large, and that
// check is only as good as the claim that NOTHING ELSE writes to the socket. A
// second path that serialises a frame and hands it to the socket itself would
// work, pass every behavioural test written against the guard, and bring the
// 1009 back for whatever it sends.
//
// So this walks every file under apps/server/src and refuses:
//
//   1. any read of a `send` member — `x.send(`, `x?.send(`, `x.send.bind(`,
//      `x.send` passed as a value — whose receiver is not on the
//      NOT_A_DEVICE_SOCKET roster below for that file, except the one raw write,
//      `socket.send(data)` inside `sendFleetFrame` in routes/fleet-events.ts.
//      The receiver is the name right before the `.send`, or the root of a call
//      chain (`reply.code(200).send(` is `reply`; `getSocket().send(` is
//      `getSocket`). The roster is closed on purpose: a receiver's NAME says
//      nothing about what it is, so a new `.send` has to be looked at and listed,
//      not waved through for not being called `socket`. In fleet-events.ts,
//      where the device socket lives, nothing is on the roster;
//   2. `['send']` in any form — a bracketed member exists only to dodge (1);
//   3. `send` destructured out of anything (`const { send } = socket`,
//      `({ send }) =>`) — a raw send under a bare name;
//   4. `sendFleetFrame(` called anywhere except as the function handed to
//      `registry.register(` — the registry wraps it in the guard at once;
//   5. `send(JSON.stringify(` anywhere — a frame serialised outside the guard is
//      a frame whose size nobody measured;
//   6. the raw send being CALLED anywhere but once, in the guard, after the size
//      comparison (`rawSend(` / `#rawSend(`), or held as the connection's old
//      `this.send` field;
//   7. the raw send's type, `FleetNodeSocketSend`, imported by any module other
//      than the registry that defines it and the guard that consumes it;
//   8. a WebSocket route or the WebSocket library anywhere but fleet-events.ts —
//      a device socket can only come from there, so a second source of sockets
//      would be a second place to write to one.
//
// What text matching cannot see: a member named at run time (`socket[m]`,
// `Reflect.get`). Those are not how this codebase writes anything, and (8)
// keeps the socket itself inside fleet-events.ts, where (1) allows no `.send`
// but the one.
//
// The rules are checked against the real tree (no findings) and, as a positive
// control, against sources with each kind of raw send planted in them (every one
// found). A scanner that finds nothing is only evidence when it can be shown to
// find something.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const FLEET_EVENTS = 'routes/fleet-events.ts';
const REGISTRY = 'services/fleet-control-registry.ts';
const GUARD = 'services/device-frame-guard.ts';

interface Source {
  /** Path relative to apps/server/src, forward slashes. */
  path: string;
  /** Code with comments removed. */
  code: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function realSources(): Source[] {
  return walk(SRC).map((full) => ({
    path: relative(SRC, full).split('\\').join('/'),
    code: codeOnly(readFileSync(full, 'utf8')),
  }));
}

/** The body of `function name(` up to the next top-level declaration. */
function functionBody(code: string, name: string): { start: number; end: number } | null {
  const start = code.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const next = code.slice(start + 1).search(/\n(?:export )?(?:async )?function |\nexport /);
  return { start, end: next === -1 ? code.length : start + 1 + next };
}

/**
 * Receivers whose `send` member is NOT a device socket, and the files where that
 * holds. Every other `send` member read is a finding (rule 1). To add one, say
 * what it is — and keep `where` as narrow as the truth.
 */
const NOT_A_DEVICE_SOCKET: ReadonlyArray<{ receiver: string; where: RegExp; what: string }> = [
  {
    receiver: 'reply',
    where: /^(?!routes\/fleet-events\.ts$)/,
    what: "Fastify's HTTP reply (also the root of `reply.code(…).send(`)",
  },
  {
    receiver: 'frames',
    where: /^services\/fleet-control-registry\.ts$/,
    what: "the connection's DeviceFrameGuard — the guarded send itself",
  },
  {
    receiver: 'transport',
    where: /^services\/[\w-]+-correlator\.ts$/,
    what: "a correlator's transport, which the registry builds on `frames.send`",
  },
  { receiver: 's3', where: /^lib\/r2\.ts$/, what: 'the object-storage client' },
  { receiver: 'emailer', where: /^services\//, what: 'an email sender' },
  {
    receiver: 'plan',
    where: /^services\/agent-turn-health-watchdog\.ts$/,
    what: 'a notice budget — its `send` is a count, not a function',
  },
];

/** Every read of a member named `send`: `.send`, `?.send`. */
const SEND_MEMBER = /(\?\.|\.)\s*send\b/g;
const BRACKET_SEND = /\[\s*(['"`])send\1\s*\]/g;
const DESTRUCTURED_SEND = [
  /\b(?:const|let|var)\s*\{[^{}=]*\bsend\b[^{}=]*\}\s*=/g,
  /\(\s*\{\s*(?:[\w$]+\s*,\s*)*send\s*(?:,\s*[\w$]+\s*)*\}\s*[:)]/g,
];

/**
 * The receiver of the member access that starts at `at` (the `.`/`?.`): the name
 * right before it, or — when a call or index sits in between — the root of the
 * chain. `(expression)` when there is no name to find.
 */
function receiverOf(code: string, at: number): string {
  let i = at - 1;
  const skipSpace = (): void => {
    while (i >= 0 && /\s/.test(code[i] ?? '')) i -= 1;
  };
  skipSpace();
  let throughCall = false;
  for (;;) {
    const ch = code[i];
    if (ch === ')' || ch === ']') {
      throughCall = true;
      const open = ch === ')' ? '(' : '[';
      let depth = 0;
      for (; i >= 0; i -= 1) {
        if (code[i] === ch) depth += 1;
        else if (code[i] === open && --depth === 0) break;
      }
      i -= 1;
      skipSpace();
      continue;
    }
    const end = i + 1;
    while (i >= 0 && /[\w$]/.test(code[i] ?? '')) i -= 1;
    const name = code.slice(i + 1, end);
    if (name === '') return '(expression)';
    if (!throughCall) return name;
    skipSpace();
    if (code[i] !== '.') return name;
    i -= 1;
    if (code[i] === '?') i -= 1;
    skipSpace();
  }
}

function lineOf(code: string, at: number): string {
  const start = code.lastIndexOf('\n', at) + 1;
  const end = code.indexOf('\n', at);
  return code.slice(start, end === -1 ? code.length : end).trim();
}

function findRawDeviceSends(sources: readonly Source[]): string[] {
  const findings: string[] = [];
  let rawWrites = 0;
  let registeredWrites = 0;
  const rosterUses = new Map<string, number>(NOT_A_DEVICE_SOCKET.map((r) => [r.receiver, 0]));
  for (const { path, code } of sources) {
    // 1 — every `send` member read, by receiver.
    const rawWriteBody = path === FLEET_EVENTS ? functionBody(code, 'sendFleetFrame') : null;
    for (const m of code.matchAll(SEND_MEMBER)) {
      const at = m.index ?? 0;
      const receiver = receiverOf(code, at);
      if (
        rawWriteBody !== null &&
        at > rawWriteBody.start &&
        at < rawWriteBody.end &&
        receiver === 'socket' &&
        /^\.\s*send\s*\(/.test(code.slice(at))
      ) {
        rawWrites += 1;
        continue;
      }
      const listed = NOT_A_DEVICE_SOCKET.find((r) => r.receiver === receiver && r.where.test(path));
      if (listed !== undefined) {
        rosterUses.set(listed.receiver, (rosterUses.get(listed.receiver) ?? 0) + 1);
        continue;
      }
      findings.push(
        `${path}: raw socket write — \`${receiver}\` is not a known non-socket here: ${lineOf(code, at)}`,
      );
    }
    // 2 — a bracketed `send` member.
    for (const m of code.matchAll(BRACKET_SEND)) {
      findings.push(`${path}: raw socket write through ['send']: ${lineOf(code, m.index ?? 0)}`);
    }
    // 3 — `send` destructured out of something.
    for (const pattern of DESTRUCTURED_SEND) {
      for (const m of code.matchAll(pattern)) {
        findings.push(
          `${path}: raw socket write through a destructured send: ${lineOf(code, m.index ?? 0)}`,
        );
      }
    }
    // 4 — the raw write reaches the registry, and nowhere else.
    for (const m of code.matchAll(/\bsendFleetFrame\s*\(/g)) {
      const at = m.index ?? 0;
      if (code.slice(Math.max(0, at - 9), at) === 'function ') continue;
      const before = code.slice(Math.max(0, at - 200), at);
      if (
        path === FLEET_EVENTS &&
        /registry\.register\(\s*nodeId,\s*\(data\)\s*=>\s*$/.test(before)
      ) {
        registeredWrites += 1;
        continue;
      }
      findings.push(`${path}: sendFleetFrame called outside registry.register`);
    }
    // 5 — a frame serialised on its way to a send.
    for (const m of code.matchAll(/\bsend\s*\(\s*JSON\.stringify\s*\(/g)) {
      findings.push(`${path}: serialised send \`${m[0]}\` bypasses the guard`);
    }
    // 6 — the raw send called, or kept as the connection's `this.send`.
    const rawCalls = [...code.matchAll(/(?:#|\b)rawSend\s*\(/g)];
    if (path === GUARD) {
      const refusal = code.indexOf('throw new DeviceFrameTooLargeError(');
      if (rawCalls.length !== 1) {
        findings.push(`${path}: the guard calls the raw send ${rawCalls.length} times, not once`);
      } else if (refusal === -1 || (rawCalls[0]?.index ?? 0) < refusal) {
        findings.push(`${path}: the raw send is reached before the size refusal`);
      }
    } else {
      if (rawCalls.length > 0) {
        findings.push(`${path}: the raw send is called outside the guard (${rawCalls.length}×)`);
      }
    }
    if (path === REGISTRY && /\bthis\.send\s*\(|\bprivate readonly send\b/.test(code)) {
      findings.push(`${path}: the connection keeps and calls the raw send itself`);
    }
    // 7 — the raw send's type travels no further than the guard.
    if (path !== REGISTRY && path !== GUARD && /\bFleetNodeSocketSend\b/.test(code)) {
      findings.push(`${path}: handles the raw socket send (FleetNodeSocketSend)`);
    }
    // 8 — sockets come from one route.
    if (path !== FLEET_EVENTS) {
      if (/\bwebsocket\s*:\s*true\b/.test(code)) {
        findings.push(`${path}: a second WebSocket route — a second source of sockets`);
      }
      if (/\bfrom\s*['"](?:ws|@fastify\/websocket)['"]|\brequire\(\s*['"]ws['"]\s*\)/.test(code)) {
        findings.push(`${path}: imports the WebSocket library — a second source of sockets`);
      }
    }
  }
  if (rawWrites !== 1) findings.push(`expected exactly one raw socket write, found ${rawWrites}`);
  // A roster entry that matches nothing is a hole waiting for a socket of that name.
  for (const [receiver, uses] of rosterUses) {
    if (uses === 0) {
      findings.push(`NOT_A_DEVICE_SOCKET lists \`${receiver}\` but nothing matches it: remove it`);
    }
  }
  if (registeredWrites !== 1) {
    findings.push(
      `expected the raw write to reach registry.register once, found ${registeredWrites}`,
    );
  }
  return findings;
}

describe('only the device frame guard writes to a device socket', () => {
  const sources = realSources();

  it('CRITICAL the walk read the server source, including the three files the rules are about', () => {
    expect(sources.length, 'files read under apps/server/src').toBeGreaterThan(300);
    for (const path of [FLEET_EVENTS, REGISTRY, GUARD]) {
      expect(
        sources.some((s) => s.path === path),
        `${path} is missing — the rules below would pass having read nothing`,
      ).toBe(true);
    }
  });

  it('CRITICAL nothing in apps/server/src writes to a device socket except through the guard', () => {
    expect(findRawDeviceSends(sources)).toEqual([]);
  });

  describe('the scanner catches a raw send (positive controls)', () => {
    const plant = (path: string, extra: string): Source[] =>
      sources.map((s) => (s.path === path ? { path, code: `${s.code}\n${extra}\n` } : s));

    const cases: ReadonlyArray<[string, string, string, RegExp]> = [
      [
        'a service writing to a socket it was handed',
        'services/fleet-session-routing-dispatcher.ts',
        'export function leak(socket: { send(d: string): void }) { socket.send("{}"); }',
        /raw socket write/,
      ],
      [
        'a second socket write in the route file',
        FLEET_EVENTS,
        'function sendAnother(ws: { send(d: string): void }, d: string) { ws.send(d); }',
        /raw socket write/,
      ],
      [
        'a frame serialised straight into a transport',
        'services/cookies-request-correlator.ts',
        'export const leak = (t: { send(d: string): void }) => t.send(JSON.stringify({ type: "x" }));',
        /serialised send/,
      ],
      [
        'the connection calling the raw send itself',
        REGISTRY,
        'function sneak(rawSend: (d: string) => void) { rawSend("{}"); }',
        /raw send is called outside the guard/,
      ],
      [
        'the old `this.send` field coming back',
        REGISTRY,
        'class Back { private readonly send = (d: string) => d; go() { this.send("{}"); } }',
        /keeps and calls the raw send/,
      ],
      [
        'another module taking the raw send',
        'routes/agent-sessions.ts',
        'import type { FleetNodeSocketSend } from "../services/fleet-control-registry.js";',
        /FleetNodeSocketSend/,
      ],
      [
        'sendFleetFrame passed somewhere else',
        FLEET_EVENTS,
        'export const again = (s: never) => sendFleetFrame(s, "{}");',
        /sendFleetFrame called outside/,
      ],
      [
        'a second raw call inside the guard',
        GUARD,
        'function twice(g: { rawSend(d: string): void }) { g.rawSend("{}"); }',
        /calls the raw send [2-9] times, not once/,
      ],
      [
        'a socket written through optional chaining',
        'services/fleet-session-routing-dispatcher.ts',
        'export function leak(socket?: { send(d: string): void }) { socket?.send("{}"); }',
        /raw socket write — `socket` is not a known non-socket here/,
      ],
      [
        "a socket written through ['send']",
        'services/fleet-session-routing-dispatcher.ts',
        'export function leak(socket: { send(d: string): void }) { socket[\'send\']("{}"); }',
        /raw socket write through \['send'\]/,
      ],
      [
        'a socket under a name that does not say socket',
        'services/fleet-session-routing-dispatcher.ts',
        'export function leak(client: { send(d: string): void }) { client.send("{}"); }',
        /raw socket write — `client` is not a known non-socket here/,
      ],
      [
        'a send destructured off a socket',
        'services/fleet-session-routing-dispatcher.ts',
        'export function leak(socket: { send(d: string): void }) { const { send } = socket; send("{}"); }',
        /raw socket write through a destructured send/,
      ],
      [
        "a socket's send taken as a value",
        'services/fleet-session-routing-dispatcher.ts',
        'export const leak = (socket: { send(d: string): void }) => socket.send.bind(socket);',
        /raw socket write — `socket` is not a known non-socket here: export const leak/,
      ],
      [
        'a socket reached through a call',
        'services/fleet-session-routing-dispatcher.ts',
        'export const leak = (get: () => { send(d: string): void }) => get().send("{}");',
        /raw socket write — `get` is not a known non-socket here/,
      ],
      [
        'the device socket handed on inside the route file',
        FLEET_EVENTS,
        'function keep(socket: FleetSocket) { return socket.send; }',
        /routes\/fleet-events\.ts: raw socket write — `socket` is not a known non-socket here/,
      ],
      [
        'a second WebSocket route',
        'routes/agent-sessions.ts',
        'export const route = { websocket: true, handler: () => undefined };',
        /routes\/agent-sessions\.ts: a second WebSocket route/,
      ],
      [
        'the WebSocket library imported elsewhere',
        'services/fleet-session-routing-dispatcher.ts',
        "import { WebSocket } from 'ws';",
        /imports the WebSocket library/,
      ],
      [
        'a listed receiver used outside the file it is listed for',
        'routes/agent-sessions.ts',
        'export const leak = (frames: { send(d: string): void }) => frames.send("{}");',
        /routes\/agent-sessions\.ts: raw socket write — `frames` is not a known non-socket here/,
      ],
      [
        "an HTTP reply's name reused in the route file that holds the device socket",
        FLEET_EVENTS,
        'function sneak(reply: FleetSocket) { reply.send("{}"); }',
        /routes\/fleet-events\.ts: raw socket write — `reply` is not a known non-socket here/,
      ],
    ];

    for (const [label, path, planted, expected] of cases) {
      it(`CRITICAL finds ${label}`, () => {
        const findings = findRawDeviceSends(plant(path, planted));
        expect(findings.join('\n'), `the planted raw send in ${path} went unnoticed`).toMatch(
          expected,
        );
      });
    }

    it('CRITICAL finds a roster entry that no longer matches anything', () => {
      const withoutS3 = sources.map((s) =>
        s.path === 'lib/r2.ts'
          ? { ...s, code: s.code.replace(/\bs3\s*\.\s*send\b/g, 's3.put') }
          : s,
      );
      expect(findRawDeviceSends(withoutS3).join('\n')).toMatch(
        /NOT_A_DEVICE_SOCKET lists `s3` but nothing matches it/,
      );
    });
  });
});
