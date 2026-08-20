// V-941 — three endpoints send `Content-Disposition`; the document declared it
// for one.
//
// The audit-log export already carried it, and the comment beside that
// declaration states the principle exactly: "The description above has always
// MENTIONED this header, but prose is not something a code generator can use."
// The other two attachment responses were in precisely the state that comment
// describes. The PDF receipt's own summary says "with Content-Disposition:
// attachment" in text, and the machine-readable contract said nothing.
//
// It is not a theoretical gap. `/docs/guides/paying-with-crypto` tells customers
// to fetch that receipt with `curl -O -J`, and `-J` takes the saved filename FROM
// this header. A documented workflow depended on a header the contract never
// declared, so a generated client had no typed way to know a filename was on
// offer — and the admin GUI's CSV export reads the same header back off the
// response.
//
// The text receipt is deliberately NOT in the set and the arm below asserts its
// absence. It sends `text/plain` inline with no disposition, which is correct for
// something meant to be read rather than saved. Pinning that keeps a future sweep
// from "completing the set" and turning an inline receipt into a download.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface SpecShape {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { headers?: Record<string, unknown> }> }>
  >;
}

function declaredHeaders(path: string, method: string): string[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const r = spec.paths[path]?.[method]?.responses?.['200'];
  return Object.keys(r?.headers ?? {});
}

interface Attachment {
  readonly label: string;
  readonly path: string;
  readonly routeFile: string;
  /** The route's own `content-disposition` send, quoted from source. */
  readonly send: RegExp;
}

const ATTACHMENTS: readonly Attachment[] = [
  {
    label: 'audit-log export',
    path: '/v1/account/audit-log/export',
    routeFile: 'apps/server/src/routes/account-audit.ts',
    send: /\.header\('content-disposition', `attachment; filename="\$\{filenameBase\}\.csv"`\)/,
  },
  {
    label: 'admin crypto-orders CSV',
    path: '/v1/admin/crypto-orders.csv',
    routeFile: 'apps/server/src/routes/admin-crypto-orders.ts',
    send: /\.header\('content-disposition', 'attachment; filename="crypto-orders\.csv"'\)/,
  },
  {
    label: 'PDF receipt',
    path: '/v1/billing/crypto-orders/{order_id}/receipt.pdf',
    routeFile: 'apps/server/src/routes/billing-crypto-orders.ts',
    send: /\.header\(\s*'content-disposition',\s*`attachment; filename="receipt-\$\{receipt\.order_id\}\.pdf"`,?\s*\)/,
  },
];

describe('V-941 an attachment declares its filename header', () => {
  it('CRITICAL every route in this table still sends the header. The document side is compared against these, so if a route stopped attaching a filename the declaration arm would keep passing against a header nobody sends — the direction that turns a contract into a wish.', () => {
    for (const { label, routeFile, send } of ATTACHMENTS) {
      const src = readFileSync(resolve(REPO_ROOT, routeFile), 'utf8');
      expect(src.length, `${routeFile} was read`).toBeGreaterThan(500);
      expect(src, `${label} still attaches a filename`).toMatch(send);
    }
  });

  it('CRITICAL every attachment response declares Content-Disposition. A client generated from the document cannot use prose: `curl -O -J` and the admin GUI both read the filename off this header, and two of these three endpoints named it only in a summary sentence.', () => {
    const missing: string[] = [];
    for (const { label, path } of ATTACHMENTS) {
      const headers = declaredHeaders(path, 'get');
      if (!headers.includes('Content-Disposition')) {
        missing.push(
          `${label} (${path}) declares ${headers.length > 0 ? headers.join(', ') : 'no headers'}`,
        );
      }
    }
    expect(missing, 'these attachment responses do not declare their filename header:').toEqual([]);
  });

  it('CRITICAL the text receipt is still an inline response, not an attachment. It sends text/plain with no disposition, which is right for something read rather than saved — asserted so a later sweep "completing the set" cannot quietly turn it into a download.', () => {
    expect(
      declaredHeaders('/v1/billing/crypto-orders/{order_id}/receipt.txt', 'get'),
      'the text receipt declares no attachment header',
    ).toEqual([]);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'), 'utf8'),
      'and it still replies inline text/plain',
    ).toMatch(/reply\.type\('text\/plain; charset=utf-8'\)\.send\(/);
  });
  it('CRITICAL V-1111 every route that sends Content-Disposition is in this table, and none has grown a second attachment quietly. The table is what the document side is compared against, so a route sending the header without a row here is not reported as undeclared — it is never looked at, which is the state V-941 found: three endpoints sent it and the spec declared it for one. Counts are per file because one endpoint can send it from two branches (the audit-log export does, once per format) and a bare file list would not see a THIRD branch appear.', () => {
    const routesDir = resolve(REPO_ROOT, 'apps/server/src/routes');
    const SEND = /\.header\(\s*'content-disposition'/gi;
    const live = new Map<string, number>();
    for (const f of readdirSync(routesDir).filter((n) => n.endsWith('.ts'))) {
      // Comments are stripped first: the prose beside these handlers discusses
      // the header by name, and counting a sentence as a send site is how a
      // census like this reports coverage it has not got.
      const src = readFileSync(resolve(routesDir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      const n = (src.match(SEND) ?? []).length;
      if (n > 0) live.set(`apps/server/src/routes/${f}`, n);
    }
    expect(live.size, 'route files sending Content-Disposition').toBeGreaterThanOrEqual(3);

    const rostered = new Set(ATTACHMENTS.map((a) => a.routeFile));
    expect(
      [...live.keys()].filter((f) => !rostered.has(f)).sort(),
      'these route files send Content-Disposition but have no row, so nothing checks the document ' +
        'declares it for them:',
    ).toEqual([]);
    expect(
      [...rostered].filter((f) => !live.has(f)).sort(),
      'rows for route files that no longer send the header at all:',
    ).toEqual([]);

    // Per-file send-site counts. A new attachment added inside an
    // already-rostered file keeps the file list identical and would otherwise
    // be invisible.
    const EXPECTED_SITES: Readonly<Record<string, number>> = {
      'apps/server/src/routes/account-audit.ts': 2,
      'apps/server/src/routes/admin-crypto-orders.ts': 1,
      'apps/server/src/routes/billing-crypto-orders.ts': 1,
    };
    const drifted: string[] = [];
    for (const [file, n] of live) {
      const want = EXPECTED_SITES[file];
      if (want === undefined) drifted.push(`${file}: ${String(n)} unregistered send site(s)`);
      else if (want !== n) drifted.push(`${file}: expected ${String(want)}, found ${String(n)}`);
    }
    expect(
      drifted.sort(),
      'the Content-Disposition send-site population changed — a new attachment needs a row and a ' +
        'declared header, a removed one needs its row dropped:',
    ).toEqual([]);
  });
});
