// V-1051 — every email template has a row in the customer-facing catalogue, and vice versa.
//
// V-1050 found `reference/emails.md` describing an email nothing could send. The
// mirror-image failure is an email a customer CAN receive with no row describing
// it: mail arriving from a vendor with no published explanation of what triggered
// it, which for a security advisory is worse than the reverse.
//
// Both directions are derivable, because the two sides carry the same string. Each
// entry in `TEMPLATES` (services/email.ts) has a `subject`, and each catalogue row
// is that subject as its bolded title. Measured today: 20 templates, 20 rows, and
// they correspond exactly.
//
// The only wrinkle is a naming convention the two sides do not share. Templates
// send `Driftstack — <subject>`, or `[Driftstack Status] <subject>` for the status
// feed; the catalogue drops the prefix because every row would otherwise begin the
// same way. Templates also use a typographic apostrophe where the table uses a
// straight one. Normalising those two things is what makes the comparison exact
// rather than approximate — and an arm below asserts the normalisation does NOT
// collapse two different subjects into one, because a normaliser that erases real
// differences would make this file agree with anything.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const EMAIL_SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');
const CATALOGUE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/emails.md');

/** Brace-matched body of `const TEMPLATES = { … }`. */
function templatesBody(): string {
  const src = readFileSync(EMAIL_SERVICE, 'utf8');
  const at = src.indexOf('const TEMPLATES = {');
  expect(at, 'TEMPLATES is no longer declared in services/email.ts').toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('TEMPLATES body is unbalanced');
}

function templateSubjects(): string[] {
  return [
    ...templatesBody().matchAll(/subject:\s*'([^']+)'|subject:\s*"([^"]+)"|subject:\s*`([^`]+)`/g),
  ].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

function catalogueRows(): string[] {
  return [...readFileSync(CATALOGUE, 'utf8').matchAll(/^\|\s\*\*([^*]+)\*\*/gm)].map((m) =>
    (m[1] as string).trim(),
  );
}

/**
 * Strip the two conventions the sides do not share, and nothing else.
 *
 * The send prefix (`Driftstack — `, `[Driftstack Status] `) and the typographic
 * apostrophe. Case and trailing punctuation are folded too; anything beyond that
 * would start hiding real differences.
 */
function normalise(subject: string): string {
  return subject
    .replace(/’/g, "'")
    .replace(/—/g, '-')
    .replace(/^\s*\[driftstack status\]\s*/i, '')
    .replace(/^\s*driftstack\s*-\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

describe('V-1051 every email a customer can receive is in the catalogue', () => {
  it('CRITICAL both sides were really read, and the normaliser does not erase differences. A subject extractor that found nothing, or a normaliser that folded distinct subjects together, would make the comparison below pass for a catalogue missing half the mail.', () => {
    const subjects = templateSubjects();
    const rows = catalogueRows();
    expect(subjects.length, 'template subjects extracted').toBeGreaterThanOrEqual(18);
    expect(rows.length, 'catalogue rows extracted').toBeGreaterThanOrEqual(18);

    // The prefix and apostrophe are folded…
    expect(normalise('Driftstack — Payment receipt')).toBe('payment receipt');
    expect(normalise('[Driftstack Status] Incident posted')).toBe('incident posted');
    expect(normalise('You’re subscribed to Driftstack status')).toBe(
      "you're subscribed to driftstack status",
    );
    // …and nothing else is. These must stay distinct.
    expect(normalise('Incident posted')).not.toBe(normalise('Incident update'));
    expect(normalise('Payment receipt')).not.toBe(normalise('Payment failed'));

    // No two templates collapse onto one row.
    expect(new Set(subjects.map(normalise)).size, 'distinct normalised subjects').toBe(
      subjects.length,
    );
  });

  it('CRITICAL every template a customer can receive has a catalogue row. Mail arriving with no published explanation of what triggered it is the reverse of V-1050, and worse for a security advisory: the customer cannot tell whether it is genuine.', () => {
    const subjects = new Set(templateSubjects().map(normalise));
    const rows = new Set(catalogueRows().map(normalise));
    expect(
      [...subjects].filter((s) => !rows.has(s)).sort(),
      'these templates can be sent to a customer and are described nowhere in ' +
        'reference/emails.md — add a row saying what triggers each:',
    ).toEqual([]);
  });

  it('CRITICAL every catalogue row corresponds to a real template. A row for mail that no longer exists reads as a live notice a customer might wait for, which is how V-1050 started.', () => {
    const subjects = new Set(templateSubjects().map(normalise));
    const rows = new Set(catalogueRows().map(normalise));
    expect(
      [...rows].filter((r) => !subjects.has(r)).sort(),
      'these catalogue rows name mail with no template behind it — delete the row, or restore the ' +
        'template it describes:',
    ).toEqual([]);
  });
});
