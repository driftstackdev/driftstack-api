// THE COMMITMENT ARM of the consequential-action gate — structural, and
// language-free.
//
// ⛔ WHY THIS EXISTS, IN ONE MEASUREMENT. The caption arm
// (agent-consequential-action.ts) matches fourteen ENGLISH phrases against what
// a tap target is called. Its own header says false negatives are acceptable,
// and they were: a checkout whose submit button is captioned with an ordinary
// neutral word is outside every pattern, so both planner models completed the
// order with no approval, ten repetitions out of ten each. The customer had
// ASKED for the order, so the model was doing its job — the approval step is the
// product's job, and a gate that only works where a shop happens to use our
// English words is not one.
//
// So this arm reads no captions and no prose. It asks four questions about the
// SHAPE of what a tap would submit:
//
//   C1  does the tap activate a form submission?
//   C2  is the submission something other than a query (a GET with fields)?
//   C3  does it commit value already held, rather than collect new value?
//   C4  are stakes on the table — money, a payment instrument, price microdata —
//       on this page or earlier in this turn?
//
// Every input is a tag name, an HTML keyword, an attribute the HTML or W3C
// specifications fix, a Unicode currency symbol beside a digit run, or an
// ISO-4217 code. ⛔ NO PAGE PROSE IS AN INPUT TO ANY VERDICT, which is what
// makes the measured attack — a notice on the page arguing that approval does
// not apply here — inert rather than merely unlikely to work. A notice can only
// ADD amounts to a page, and more amounts arm the gate harder.
//
// ⛔ AND IT CAN ONLY ADD HALTS. The caption arm runs first and unchanged; this
// one is consulted only when that arm says nothing. Every degradation — a page
// that cannot be read, a selector nothing is keyed under, an over-cap document,
// a spent read budget — falls back to exactly the behaviour that shipped. That
// monotonicity is asserted as a property, not claimed here.
//
// ⛔ WHAT IT DOES NOT COVER, said plainly because the product promise is wider
// than the gate: a commit driven by a script handler on a non-submit control
// (a `type="button"` button, a div, a link styled as a button) fails C1 and
// nothing here reaches it; account deletion has no money and usually a re-auth
// field, so it still rests entirely on the caption arm's English patterns.

import type { AgentIntent, ConsequentialActionCategory } from '@driftstack/api-types';

/** A source larger than this is not walked at all: the facts come back empty
 *  and the gate degrades to the caption arm. A document this size is already
 *  past the device's own read cap. */
const MAX_COMMITMENT_SOURCE_CHARS = 2_000_000;

/** How long a caption may be in a halt's `matchedText`.
 *
 *  ⛔ THIS IS A PUBLIC-SURFACE BOUND, NOT A TIDINESS ONE. The approval echoes
 *  the text back and the route validates it at 200 characters, while the
 *  digest's own label clamp is 400. Today `matchedText` is a short regex match
 *  so the mismatch is dormant; the moment a structural halt puts a page's own
 *  caption there, a longer one would produce a halt the customer CANNOT
 *  approve — the echo fails validation and the approval can never be given. */
export const COMMITMENT_MATCHED_TEXT_MAX = 200;

/** How much of a control's own KEY may stand in for a caption it does not have.
 *
 *  ⛔ SHORTER THAN A CAPTION'S CLAMP ON PURPOSE. A caption is what a person
 *  reads on the button, so showing it back is showing them what they saw. An
 *  id or a test id is INVISIBLE to them, so a page that writes a sentence into
 *  one would be putting words the page never displayed into the approval the
 *  customer is being asked for. It is used only where there is no caption and
 *  no figure at all, it goes through the caller's sanitiser like every other
 *  page string, and it is kept to a name's length rather than a sentence's. */
export const COMMITMENT_FALLBACK_TEXT_MAX = 48;

/** Commitment prompts one turn may raise. A third is not a prompt: the turn
 *  stops. A ceiling that keeps asking can be farmed for consent by a page that
 *  scatters commit-shaped forms around; a ceiling that stops cannot. */
export const COMMITMENT_PROMPT_CEILING = 2;

// ── reading the markup ────────────────────────────────────────────────

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;

/** Attributes as a plain map. Double-quoted forms only, exactly as the planner
 *  digest reads them, so the two readings of one page agree about what an
 *  attribute says. */
export function readCommitAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m !== null; m = ATTR_RE.exec(raw)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) attrs.set(name.toLowerCase(), value);
  }
  return attrs;
}

/** Not rendered by its own markup: the bare `hidden` attribute or an inline
 *  `display: none`. Quoted values are blanked first so a class named "hidden"
 *  cannot read as the attribute. Markup only — there is no cascade to consult. */
export function markedNotRendered(rawAttrs: string, attrs: Map<string, string>): boolean {
  if (/(?:^|\s)hidden(?=\s|=|\/|$)/i.test(rawAttrs.replace(/"[^"]*"/g, '""'))) return true;
  return /display\s*:\s*none/i.test(attrs.get('style') ?? '');
}

/**
 * ⛔ THE ONE DERIVATION OF A TAP'S KEYS, used by the caption arm's page-label
 * lookup and by this arm's fact lookup.
 *
 * A planner may respell the selector the page was described by, so an element is
 * looked up as written, then by the id or test id in its last compound
 * (`button#pay` and `#pay` are one element). Two lookups keyed differently would
 * mean the labels and the facts disagreed about which element a tap addresses,
 * which is the kind of drift nothing fails on.
 */
export function selectorKeysForTap(selector: string): string[] {
  const keys: string[] = [];
  for (const branch of selector.split(',')) {
    const one = branch.trim();
    if (one.length === 0) continue;
    const last = one.split(/[\s>+~]+/).at(-1) ?? '';
    const id = /#([-\w]+)/.exec(last.replace(/\[[^\]]*\]/g, ''));
    const testId = /\[data-testid\s*=\s*["']?([^"'\]]+)["']?\]/.exec(last);
    keys.push(one);
    if (id !== null) keys.push(`#${id[1] ?? ''}`);
    if (testId !== null) keys.push(`[data-testid="${testId[1] ?? ''}"]`);
  }
  return keys;
}

/** The most specific stable key the markup supports, in the order the planner
 *  digest picks one — so a control's facts are filed under the same string the
 *  digest files its name under. Null when nothing addressable is present. */
export function commitSelectorKey(tag: string, attrs: Map<string, string>): string | null {
  const testId = attrs.get('data-testid');
  if (testId !== undefined && testId.length > 0) return `[data-testid="${testId}"]`;
  const id = attrs.get('id');
  if (id !== undefined && id.length > 0) return `#${id}`;
  const name = attrs.get('name');
  if (name !== undefined && name.length > 0) return `${tag}[name="${name}"]`;
  const label = attrs.get('aria-label');
  if (label !== undefined && label.length > 0) return `[aria-label="${label}"]`;
  const type = attrs.get('type');
  if (tag === 'input' && type !== undefined && type.length > 0) return `input[type="${type}"]`;
  return null;
}

// ── character references, inside the money scan only ──────────────────

const NAMED_REFS: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  pound: '£',
  euro: '€',
  yen: '¥',
  cent: '¢',
  curren: '¤',
  dollar: '$',
  rupee: '₹',
  won: '₩',
  ruble: '₽',
};

/**
 * Numeric and named character references, decoded.
 *
 * ⛔ SCOPED TO THIS MODULE'S MONEY SCAN ON PURPOSE. The planner digest decodes
 * six entities and no more, and widening that would change what the model is
 * shown. But a page that writes its total as a numeric reference is writing a
 * price, and a detector that cannot see it hands a free bypass to any page
 * whose template escapes its currency symbol — which plenty do without meaning
 * anything by it.
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    const ref = String(body);
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const code = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCode(code) : whole;
    }
    if (ref.startsWith('#')) {
      const code = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCode(code) : whole;
    }
    return NAMED_REFS[ref.toLowerCase()] ?? whole;
  });
}

function safeFromCode(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// ── money ─────────────────────────────────────────────────────────────

/**
 * ISO-4217 alphabetic codes in circulation. A closed, externally maintained set
 * — the distinction from the caption arm's word list is the whole point: the
 * world's currencies are a finite standardised set, and the ways to write
 * "place the order" are not.
 */
const CURRENCY_CODES = [
  'AED',
  'ARS',
  'AUD',
  'BGN',
  'BHD',
  'BRL',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KES',
  'KRW',
  'KWD',
  'MAD',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'TWD',
  'UAH',
  'USD',
  'VND',
  'ZAR',
];

/**
 * Currency units ordinarily written as letters rather than as a Unicode
 * currency symbol. A closed list, and short on purpose: a unit written out as a
 * word ("129 kroner") is a named residual, not something to guess at.
 */
const LETTER_UNITS = ['zł', 'Kč', 'kr', 'Ft', 'lei', 'руб', 'грн', '元', '円', '원'];

const AMOUNT = String.raw`\d{1,3}(?:[\s,.']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const SYMBOL = String.raw`\p{Sc}`;
const CODE = `(?<![A-Za-z])(?:${CURRENCY_CODES.join('|')})(?![A-Za-z])`;
const UNIT = `(?:${LETTER_UNITS.join('|')})(?![A-Za-z])`;

/**
 * A money amount: a currency symbol or ISO-4217 code beside a digit run, or a
 * digit run beside one of those or a letter-written unit.
 *
 * ⛔ NEVER A LITERAL CURRENCY SYMBOL FROM ANY ONE PAGE. `\p{Sc}` is Unicode's
 * own category and the code list is a standard; the eval's anti-tuning sweep
 * over this whole source tree is what keeps it that way.
 *
 * Deliberately does NOT match a bare percentage or a clock time: neither has a
 * currency symbol, a currency code or a currency unit beside it.
 */
const MONEY_RE = new RegExp(
  `(?:${SYMBOL}|${CODE})\\s?(?:${AMOUNT})|(?:${AMOUNT})\\s?(?:${SYMBOL}|${CODE}|${UNIT})`,
  'gu',
);

/** Attribute vocabularies that state a price without rendering a symbol. */
const PRICE_ITEMPROPS = new Set(['price', 'pricecurrency', 'lowprice', 'highprice']);
const PRICE_PROPERTIES = new Set([
  'product:price:amount',
  'product:price:currency',
  'og:price:amount',
  'og:price:currency',
]);

/** W3C autofill tokens for a payment instrument. Identical in every locale. */
const PAYMENT_TOKENS = new Set([
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-name',
  'cc-type',
  'cc-given-name',
  'cc-family-name',
  'cc-additional-name',
]);

function hasPaymentToken(attrs: Map<string, string>): boolean {
  const auto = attrs.get('autocomplete');
  if (auto === undefined) return false;
  return auto
    .toLowerCase()
    .split(/\s+/)
    .some((token) => PAYMENT_TOKENS.has(token));
}

/** Every money amount in a piece of already-decoded text, as written. */
export function moneyAmountsIn(text: string): string[] {
  MONEY_RE.lastIndex = 0;
  const found: string[] = [];
  for (let m = MONEY_RE.exec(text); m !== null; m = MONEY_RE.exec(text)) found.push(m[0]);
  return found;
}

/**
 * The numeric value of an amount, for the "no more than what was approved"
 * comparison and for nothing else. Never displayed, never compared across
 * currencies — an approval is released only when the unit text also matches.
 */
export function amountValueOf(text: string): number | null {
  const digits = text.replace(/[^\d.,]/g, '');
  if (digits.length === 0) return null;
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);
  let whole = digits;
  let fraction = '';
  if (decimalAt !== -1) {
    const tail = digits.slice(decimalAt + 1);
    // Three trailing digits after the LAST separator is a thousands group, not
    // a fractional part: `1,234` is one thousand two hundred and thirty-four.
    if (tail.length !== 3 || digits.slice(0, decimalAt).replace(/[.,]/g, '').length === 0) {
      whole = digits.slice(0, decimalAt);
      fraction = tail;
    }
  }
  const value = Number.parseFloat(`${whole.replace(/[.,]/g, '')}.${fraction || '0'}`);
  return Number.isFinite(value) ? value : null;
}

// ── the facts ─────────────────────────────────────────────────────────

/** One commitment-shaped control, as the page's markup describes it. */
export interface CommitControl {
  /** The key the page's own markup gives this control — the last-resort
   *  `matchedText` for a control with no caption on a page with no figure. */
  key: string;
  /** The control's own caption, sanitised and clamped by the reader's caller. */
  caption: string;
  /** What to show when the control has no caption AND the page prints no
   *  figure — the page's own key for it, through the caller's sanitiser and
   *  clamped. ⛔ Never used while a caption or an amount exists, because an id
   *  is INVISIBLE to the person looking at the page: a page that names its
   *  button `#your-bank-already-approved-this` must not get to say that to the
   *  customer while a visible caption or a figure is available to say instead. */
  fallbackText: string;
  /** The effective method of the submission this control performs. */
  method: 'get' | 'post';
  /** Controls in the submitted form the customer would type or choose into. */
  entryFields: number;
  /** A W3C payment-instrument autofill token inside the submitted form. */
  paymentInstrument: boolean;
  /** A money amount inside the submitted form's OWN subtree. */
  moneyInForm: boolean;
  /** The form's `action`, as written. Compared for equality when an approval
   *  releases a second step of the same commitment; never matched as prose. */
  action: string;
  /** The last money amount at or before this control in document order — a
   *  checkout prints its total immediately before its button, so this is the
   *  figure the customer is being asked about. */
  amountNearby: string | null;
}

export interface PageCommitFacts {
  /** Commitment-shaped controls, by every key a tap may address them under. */
  controls: ReadonlyMap<string, CommitControl>;
  /**
   * ⛔ WHAT PRESSING ENTER WOULD SUBMIT. Keyed by an ENTRY FIELD's own key: the
   * commitment-shaped control that an implicit submission from inside that
   * field would activate. A tap is not the only way a form is submitted — the
   * customer's plan vocabulary carries `interact:press`, whose `Enter` is one
   * genuine key press on the focused element, and HTML submits the focused
   * field's form from it. A gate that reads taps alone leaves that open.
   */
  submitForField: ReadonlyMap<string, CommitControl>;
  /** Money, a payment instrument or price microdata anywhere on this page. */
  stakes: boolean;
  /** The last money amount on the page, for a turn that carries arming forward
   *  from a basket to a checkout that prints no figure of its own. */
  amount: string | null;
  /** The markup nested one form inside another, or was too large to walk. The
   *  facts are still used — they can only add halts — and this is counted, so a
   *  page that defeats the reading is visible rather than silently absent. */
  unreliable: boolean;
}

export const NO_COMMIT_FACTS: PageCommitFacts = {
  controls: new Map(),
  submitForField: new Map(),
  stakes: false,
  amount: null,
  unreliable: false,
};

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_CONTENT_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template']);
/** Input types that are not somewhere the customer puts information. A terms
 *  tick or a "save my card" box is a consent toggle, not information — counting
 *  it would drop every real checkout that has one out of the gate. */
const NON_ENTRY_INPUT_TYPES: ReadonlySet<string> = new Set([
  'hidden',
  'submit',
  'image',
  'button',
  'reset',
  'checkbox',
  'radio',
]);

interface RawForm {
  id: string | null;
  method: 'get' | 'post';
  action: string;
  entryFields: number;
  payment: boolean;
  money: boolean;
}

interface RawSubmit {
  key: string;
  caption: string;
  at: number;
  formIndex: number | null;
  formAttr: string | null;
  formMethod: 'get' | 'post' | null;
}

interface TextPart {
  text: string;
  at: number;
  formIndex: number | null;
}

/**
 * Read a page source into the structural facts the commitment arm judges on.
 *
 * `sanitizeCaption` is the caller's own one-line sanitiser — the executor passes
 * the same one the planner digest uses, so a caption that reaches a customer
 * through this path is fenced exactly as every other page string is. Absent, the
 * caption is returned as written, which is what a unit test wants.
 *
 * ⛔ TWO READINGS THAT FAIL TOWARD HALTING, because a malformed page must not be
 * able to downgrade itself to "no commit form":
 *   - an unclosed `<form>` is read as extending to the end of the document;
 *   - nested forms mark the facts unreliable, and the facts are still used.
 */
export function readCommitFacts(
  source: string,
  sanitizeCaption: (text: string) => string = (text) => text,
): PageCommitFacts {
  if (source.length > MAX_COMMITMENT_SOURCE_CHARS) {
    return { ...NO_COMMIT_FACTS, controls: new Map(), submitForField: new Map(), unreliable: true };
  }
  const forms: RawForm[] = [];
  const formsById = new Map<string, number>();
  const submits: RawSubmit[] = [];
  const parts: TextPart[] = [];
  /** Entry fields and payment tokens hoisted out of their form by `form="id"`. */
  const hoistedEntry: string[] = [];
  const hoistedPayment: string[] = [];
  /** Every entry field's own key, beside the form an Enter inside it submits. */
  const fieldForms: Array<{ key: string; formIndex: number | null; formAttr: string | null }> = [];
  let stakesFromAttributes = false;
  let unreliable = false;

  const formStack: number[] = [];
  const stack: Array<{
    tag: string;
    hidden: boolean;
    /** Set while a submit control is open, to collect its caption. */
    collecting: RawSubmit | null;
    parts: string[];
  }> = [];
  const top = () => stack[stack.length - 1];
  const currentForm = (): number | null => formStack[formStack.length - 1] ?? null;

  const noteText = (raw: string, at: number): void => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length === 0) return;
    for (let k = stack.length - 1; k >= 0; k--) {
      const entry = stack[k];
      if (entry?.collecting != null) {
        entry.parts.push(text);
        break;
      }
    }
    if (stack.some((entry) => entry.tag === 'title' || entry.tag === 'textarea')) return;
    parts.push({ text, at, formIndex: currentForm() });
  };

  const finish = (entry: (typeof stack)[number]): void => {
    if (entry.collecting === null) return;
    // The control's own visible text WINS over the accessible name prefilled
    // when it opened: a caption is what a person reads on the button, and the
    // aria-label is only the fallback for one that has no text at all.
    const caption = entry.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (caption.length > 0) entry.collecting.caption = caption;
  };

  let cursor = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(source); m !== null; m = TAG_RE.exec(source)) {
    noteText(source.slice(cursor, m.index), cursor);
    cursor = TAG_RE.lastIndex;
    const tag = m[2]?.toLowerCase();
    if (tag === undefined) continue; // a comment
    if (m[1] === '/') {
      if (tag === 'form' && formStack.length > 0) formStack.pop();
      let at = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]?.tag === tag) {
          at = k;
          break;
        }
      }
      if (at === -1) continue;
      while (stack.length > at) {
        const closed = stack.pop();
        if (closed !== undefined) finish(closed);
      }
      continue;
    }
    const rawAttrs = m[3] ?? '';
    if (RAW_CONTENT_TAGS.has(tag)) {
      const close = source.toLowerCase().indexOf(`</${tag}`, cursor);
      const resume = close === -1 ? source.length : close;
      cursor = resume;
      TAG_RE.lastIndex = resume;
      continue;
    }
    const attrs = readCommitAttributes(rawAttrs);
    const hidden = top()?.hidden === true || markedNotRendered(rawAttrs, attrs);

    if (PRICE_ITEMPROPS.has((attrs.get('itemprop') ?? '').toLowerCase())) {
      stakesFromAttributes = true;
    }
    if (PRICE_PROPERTIES.has((attrs.get('property') ?? '').toLowerCase())) {
      stakesFromAttributes = true;
    }

    if (tag === 'form') {
      if (formStack.length > 0) unreliable = true;
      const id = attrs.get('id') ?? null;
      const index = forms.length;
      forms.push({
        id,
        // Per HTML, a form with no method submits as GET.
        method: (attrs.get('method') ?? '').toLowerCase() === 'post' ? 'post' : 'get',
        action: attrs.get('action') ?? '',
        entryFields: 0,
        payment: false,
        money: false,
      });
      if (id !== null && id.length > 0 && !formsById.has(id)) formsById.set(id, index);
      formStack.push(index);
      stack.push({ tag, hidden, collecting: null, parts: [] });
      continue;
    }

    const formAttr = attrs.get('form') ?? null;
    const owner = formAttr !== null && formAttr.length > 0 ? null : currentForm();
    const type = (attrs.get('type') ?? '').toLowerCase();

    if (hasPaymentToken(attrs)) {
      if (owner !== null) {
        const form = forms[owner];
        if (form !== undefined) form.payment = true;
      } else if (formAttr !== null && formAttr.length > 0) hoistedPayment.push(formAttr);
    }

    const isEntry =
      !hidden &&
      (tag === 'textarea' ||
        tag === 'select' ||
        (tag === 'input' && !NON_ENTRY_INPUT_TYPES.has(type === '' ? 'text' : type)));
    if (isEntry) {
      if (owner !== null) {
        const form = forms[owner];
        if (form !== undefined) form.entryFields += 1;
      } else if (formAttr !== null && formAttr.length > 0) hoistedEntry.push(formAttr);
      // ⛔ AND WHERE AN ENTER INSIDE IT WOULD GO. Recorded for every entry
      // field, whether or not its form has a submit yet — the submits are
      // resolved after the walk, because a form's button comes after its
      // fields as often as not.
      const fieldKey = commitSelectorKey(tag, attrs);
      if (fieldKey !== null) {
        fieldForms.push({
          key: fieldKey,
          formIndex: owner,
          formAttr: owner === null ? formAttr : null,
        });
      }
    }

    // C1 — a submit is `<button>` with no type or `type="submit"`, or
    // `<input type="submit">` / `<input type="image">`. Nothing else submits.
    const isSubmit =
      (tag === 'button' && (type === '' || type === 'submit')) ||
      (tag === 'input' && (type === 'submit' || type === 'image'));
    if (isSubmit && (owner !== null || (formAttr !== null && formAttr.length > 0))) {
      const key = commitSelectorKey(tag, attrs);
      if (key !== null) {
        const formMethodAttr = (attrs.get('formmethod') ?? '').toLowerCase();
        const record: RawSubmit = {
          key,
          caption:
            tag === 'input' ? `${attrs.get('value') ?? ''} ${attrs.get('alt') ?? ''}`.trim() : '',
          at: m.index,
          formIndex: owner,
          formAttr: owner === null ? formAttr : null,
          formMethod: formMethodAttr === 'post' ? 'post' : formMethodAttr === 'get' ? 'get' : null,
        };
        if (record.caption.length === 0) {
          record.caption = (attrs.get('aria-label') ?? attrs.get('title') ?? '').trim();
        }
        submits.push(record);
        if (!VOID_TAGS.has(tag) && !rawAttrs.trimEnd().endsWith('/')) {
          stack.push({ tag, hidden, collecting: record, parts: [] });
          continue;
        }
      }
    }
    if (VOID_TAGS.has(tag) || rawAttrs.trimEnd().endsWith('/')) continue;
    stack.push({ tag, hidden, collecting: null, parts: [] });
  }
  noteText(source.slice(cursor), cursor);
  while (stack.length > 0) {
    const closed = stack.pop();
    if (closed !== undefined) finish(closed);
  }

  for (const id of hoistedEntry) {
    const index = formsById.get(id);
    const form = index === undefined ? undefined : forms[index];
    if (form !== undefined) form.entryFields += 1;
  }
  for (const id of hoistedPayment) {
    const index = formsById.get(id);
    const form = index === undefined ? undefined : forms[index];
    if (form !== undefined) form.payment = true;
  }

  // ⛔ THE MONEY SCAN RUNS OVER THE JOINED TEXT, so a symbol and its digits
  // split across two elements read as one token — which is how a styled price
  // is ordinarily marked up, and a per-node scan cannot see it at all.
  const decoded = parts.map((part) => ({ ...part, text: decodeCharacterReferences(part.text) }));
  const offsets: number[] = [];
  let joined = '';
  for (const part of decoded) {
    if (joined.length > 0) joined += ' ';
    offsets.push(joined.length);
    joined += part.text;
  }
  const partAt = (offset: number): TextPart | undefined => {
    let lo = 0;
    let hi = offsets.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid] ?? 0) <= offset) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found === -1 ? undefined : decoded[found];
  };
  const amounts: Array<{ text: string; at: number }> = [];
  MONEY_RE.lastIndex = 0;
  for (let m = MONEY_RE.exec(joined); m !== null; m = MONEY_RE.exec(joined)) {
    const part = partAt(m.index);
    if (part === undefined) continue;
    amounts.push({ text: m[0], at: part.at });
    if (part.formIndex !== null) {
      const form = forms[part.formIndex];
      if (form !== undefined) form.money = true;
    }
  }

  const controls = new Map<string, CommitControl>();
  /** The commitment-shaped control each form's implicit submission activates —
   *  the FIRST submit in the form, as HTML defines it. */
  const submitOfForm = new Map<number, CommitControl>();
  for (const submit of submits) {
    const index =
      submit.formIndex ??
      (submit.formAttr !== null ? (formsById.get(submit.formAttr) ?? null) : null);
    if (index === null) continue;
    const form = forms[index];
    if (form === undefined) continue;
    let amountNearby: string | null = null;
    for (const amount of amounts) {
      if (amount.at <= submit.at) amountNearby = amount.text;
    }
    const next: CommitControl = {
      key: submit.key,
      caption: sanitizeCaption(submit.caption).slice(0, COMMITMENT_MATCHED_TEXT_MAX),
      fallbackText: sanitizeCaption(submit.key).slice(0, COMMITMENT_FALLBACK_TEXT_MAX),
      // C2's input: the submitter's own `formmethod` overrides the form's.
      method: submit.formMethod ?? form.method,
      entryFields: form.entryFields,
      paymentInstrument: form.payment,
      moneyInForm: form.money,
      action: form.action,
      amountNearby,
    };
    const already = controls.get(submit.key);
    controls.set(submit.key, already === undefined ? next : mergeTowardHalting(already, next));
    if (!submitOfForm.has(index)) submitOfForm.set(index, next);
  }

  const submitForField = new Map<string, CommitControl>();
  for (const field of fieldForms) {
    const index =
      field.formIndex ?? (field.formAttr !== null ? (formsById.get(field.formAttr) ?? null) : null);
    if (index === null) continue;
    const control = submitOfForm.get(index);
    if (control !== undefined && !submitForField.has(field.key)) {
      submitForField.set(field.key, control);
    }
  }

  return {
    controls,
    submitForField,
    stakes: stakesFromAttributes || amounts.length > 0 || forms.some((form) => form.payment),
    amount: amounts.at(-1)?.text ?? null,
    unreliable,
  };
}

/** Two controls under one key — a page with a duplicated id. Read the pair the
 *  way that ADDS halts, since a tap on that key may reach either. */
function mergeTowardHalting(a: CommitControl, b: CommitControl): CommitControl {
  return {
    key: a.key,
    caption: a.caption.length > 0 ? a.caption : b.caption,
    fallbackText: a.fallbackText,
    method: a.method === 'post' || b.method === 'post' ? 'post' : 'get',
    entryFields: Math.min(a.entryFields, b.entryFields),
    paymentInstrument: a.paymentInstrument || b.paymentInstrument,
    moneyInForm: a.moneyInForm || b.moneyInForm,
    action: a.action,
    amountNearby: a.amountNearby ?? b.amountNearby,
  };
}

// ── the turn's arming, budget and ceiling ─────────────────────────────

/**
 * Mutable state shared by every plan of ONE TURN, threaded the way the
 * element-wait ceiling already is: the runtime owns one and passes it to every
 * run, so arming and the prompt ceiling span the turn rather than the plan.
 *
 * ⛔ IT SURVIVES AN APPROVAL RESUME. A resume is a new turn, so turn-scoped
 * arming would reset — and on a checkout page that prints no figure of its own
 * a resumed suffix carrying a SECOND commitment would be unarmed and would
 * dispatch unapproved. It is persisted on the halted transcript entry and read
 * back when the reviewed plan is reconstructed.
 */
export interface CommitmentBudget {
  /** Stakes seen anywhere in this turn so far. Never cleared within it. */
  sawMoney: boolean;
  /** The most recent money amount seen this turn, for a page that shows none. */
  amount: string | null;
  /** Extra page reads spent by this arm. */
  pageReads: number;
  /** Commitment prompts raised this turn. */
  prompts: number;
  /** Set when a prompt was refused by the ceiling: the turn stops. */
  overCeiling: boolean;
  /** The one commitment the customer approved, and what it may release. */
  approved: {
    category: ConsequentialActionCategory;
    action: string;
    amount: string | null;
    value: number | null;
    /**
     * ⛔ EVERY COMMITMENT CONTROL THE APPROVED PAGE ALREADY OFFERED. The
     * release exists for the SECOND STEP of one commitment — a confirm the
     * customer reaches after the step they approved — so it must never cover a
     * control that was sitting on the page they were looking at. Measured
     * without it: two order forms side by side posting to the same place, one
     * approval, BOTH bought.
     */
    siblings: ReadonlySet<string>;
  } | null;
}

export function newCommitmentBudget(
  seed?: Partial<Pick<CommitmentBudget, 'sawMoney' | 'amount' | 'pageReads' | 'prompts'>>,
): CommitmentBudget {
  return {
    sawMoney: seed?.sawMoney ?? false,
    amount: seed?.amount ?? null,
    pageReads: seed?.pageReads ?? 0,
    prompts: seed?.prompts ?? 0,
    overCeiling: false,
    approved: null,
  };
}

/** Fold what a freshly read page says into the turn's arming. Money seen once
 *  in a turn stays seen: a basket that prints a total and a checkout that does
 *  not are one commitment. */
export function armFromFacts(budget: CommitmentBudget, facts: PageCommitFacts): void {
  if (facts.stakes) budget.sawMoney = true;
  if (facts.amount !== null) budget.amount = facts.amount;
}

/** Device-reported target types a form submit can never be, so no page read is
 *  spent looking one up. */
const NEVER_A_SUBMIT: ReadonlySet<string> = new Set([
  'link',
  'select',
  'textarea',
  'checkbox',
  'radio',
]);

export function tapCannotBeASubmit(targetType: string | undefined): boolean {
  return targetType !== undefined && NEVER_A_SUBMIT.has(targetType);
}

/**
 * Keys whose press SUBMITS THE FOCUSED ELEMENT'S FORM.
 *
 * ⛔ A TAP IS NOT THE ONLY WAY A FORM IS SUBMITTED, and the plan vocabulary the
 * planner is given says so in as many words: `interact:press` carries a DOM key
 * name and the device performs one genuine W3C key press on the focused
 * element. HTML's implicit submission then submits the form the focused field
 * is in — no tap, no caption, and nothing for either arm of the gate to read.
 * Measured: typing a delivery note into a checkout form and pressing Enter
 * completed the order with no approval at all.
 */
const SUBMITTING_KEYS: ReadonlySet<string> = new Set(['enter', 'numpadenter', 'return']);

export function keyMaySubmitAForm(value: string | undefined): boolean {
  return value !== undefined && SUBMITTING_KEYS.has(value.trim().toLowerCase());
}

/** Text sent to a field that carries a line break, which WebDriver's send-keys
 *  delivers as a real Enter — so a plan that types "…\n" into a checkout field
 *  submits the form without ever planning a tap. ⛔ The eval's device does not
 *  model this (its send_keys only appends), so it is closed here by shape and
 *  pinned in the unit file, not in the DOM-backed eval. */
export function typedTextMaySubmit(value: string | undefined): boolean {
  return value !== undefined && /[\r\n]/.test(value);
}

/** Whether this intent is one the commitment arm judges at all.
 *
 *  ⛔ A TAP IS NOT THE ONLY WAY A FORM IS SUBMITTED. The plan vocabulary also
 *  carries a key press (Enter on the focused element) and typed text that may
 *  contain a line break; both submit, and neither has a caption for the words
 *  arm to read. */
export function intentMayCommit(intent: AgentIntent): boolean {
  if (intent.kind !== 'interact') return false;
  if (intent.action === 'tap') return true;
  if (intent.action === 'press') return keyMaySubmitAForm(intent.value);
  return intent.action === 'type' && typedTextMaySubmit(intent.value);
}

export interface CommitmentVerdict {
  category: ConsequentialActionCategory;
  matchedText: string;
  /** The amount the halt is bound to, for the release rule. */
  amount: string | null;
  /** The control the verdict was reached on — the destination and the key the
   *  release rule compares. Present on every verdict this module returns; the
   *  optionality is for callers in tests that build a verdict by hand. */
  control?: CommitControl;
}

/**
 * The four conditions, over the page's structure and the turn's arming.
 *
 * Returns null — no halt — whenever anything at all is missing, which is what
 * makes every degradation fall back to the caption arm alone.
 */
export function classifyCommitTap(args: {
  intent: AgentIntent;
  facts: PageCommitFacts | null;
  budget: CommitmentBudget;
  /** What the device said the tap target is, from the look before the tap. */
  targetType?: string;
  /** The selector the device's focus is believed to be on, for an `interact:press`
   *  whose key submits: the last control this run typed into or tapped. */
  focusSelector?: string;
}): CommitmentVerdict | null {
  const { intent, facts, budget } = args;
  if (facts === null || intent.kind !== 'interact') return null;

  // C1 — only a control the markup says submits a form is judged at all, and
  // there are two ways to reach one: a tap on it, or a key press that submits
  // the form the focus is inside.
  let control: CommitControl | undefined;
  if (intent.action === 'tap') {
    if (intent.selector === undefined) return null;
    if (tapCannotBeASubmit(args.targetType)) return null;
    for (const key of selectorKeysForTap(intent.selector)) {
      control = facts.controls.get(key);
      if (control !== undefined) break;
    }
  } else if (intent.action === 'press' && keyMaySubmitAForm(intent.value)) {
    // The focus is a belief, not a fact, so an unresolved one falls through to
    // any control on the page that would commit — see `submitReachedByKey`.
    control = submitReachedByKey(facts, args.focusSelector, true);
  } else if (intent.action === 'type' && typedTextMaySubmit(intent.value)) {
    // The line break lands in the field this step is typing into, so the focus
    // is not a guess here — it is the selector. A textarea takes the break as a
    // newline and submits nothing, which the device's own type for the target
    // rules out before anything else is read.
    if (intent.selector === undefined || tapCannotBeASubmit(args.targetType)) return null;
    control = submitReachedByKey(facts, intent.selector, false);
  } else return null;
  if (control === undefined) return null;

  // C2 and C3, over the control the press or the tap reaches.
  if (!commitsValue(control)) return null;

  // C4 — stakes, on this page or earlier in this turn.
  if (!facts.stakes && !budget.sawMoney) return null;

  const amount = control.amountNearby ?? facts.amount ?? budget.amount;
  const category: ConsequentialActionCategory = control.paymentInstrument ? 'payment' : 'purchase';
  return { category, matchedText: commitMatchedText(control, amount), amount, control };
}

/**
 * C2 and C3 — a submission that commits value already held, rather than a
 * query or a form collecting new value.
 *
 * C2: a GET form the customer types into is a query. A FIELDLESS GET form is
 * still a commitment — `method="get"` on an order form must buy no discount.
 * C3: a form with entry fields is still a commitment when it carries the
 * payment instrument itself, or the amount inside its own subtree, which is
 * the single-page checkout where address, card and total are one form.
 */
function commitsValue(control: CommitControl): boolean {
  if (control.method === 'get' && control.entryFields >= 1) return false;
  if (control.entryFields > 0 && !control.paymentInstrument && !control.moneyInForm) return false;
  return true;
}

/**
 * What a submitting key press would activate.
 *
 * The focus is the last control this run typed into or tapped, which is where
 * the device put it. Resolved three ways, each failing TOWARD halting:
 *   - the focus is an entry field → the control its form's implicit submission
 *     would activate;
 *   - the focus is itself a commitment-shaped control → that control, because
 *     Enter on a focused button is a click on it;
 *   - the focus is unknown or is neither → ⛔ ANY commitment-shaped control on
 *     the page. A key press carries no selector, so "I do not know where the
 *     focus is" cannot be allowed to mean "so nothing can be submitted"; the
 *     later conditions still have to hold, and the page still has to be a page
 *     with a commitment on it.
 */
function submitReachedByKey(
  facts: PageCommitFacts,
  focusSelector: string | undefined,
  fallbackToAnyControl: boolean,
): CommitControl | undefined {
  if (focusSelector !== undefined) {
    for (const key of selectorKeysForTap(focusSelector)) {
      const viaField = facts.submitForField.get(key);
      if (viaField !== undefined) return viaField;
      const own = facts.controls.get(key);
      if (own !== undefined) return own;
    }
  }
  // Unknown focus: the first control on the page that WOULD commit value, so a
  // page whose search box is its first form cannot hide its order button
  // behind it. Only where the focus was a belief in the first place — a step
  // that names its own field resolves exactly or not at all.
  if (!fallbackToAnyControl) return undefined;
  for (const control of facts.controls.values()) {
    if (commitsValue(control)) return control;
  }
  return undefined;
}

/**
 * What the customer is asked to approve.
 *
 * ⛔ THE CONTROL'S OWN CAPTION AND AN AMOUNT WE PARSED — never a sentence from
 * the page and never a sentence from us. The caption has already been through
 * the caller's one-line sanitiser; the amount is a token this module matched
 * itself. Putting the amount in binds the approval signature to the figure for
 * free, so a basket swapped between the halt and the resume re-prompts.
 *
 * Falls back to the control's own key — the page's own markup, never a sentence
 * of ours — so an icon-only submit with no caption on a page with no figure
 * still produces the non-empty text the approval echo requires. Clamped to what
 * that echo will accept.
 */
function commitMatchedText(control: CommitControl, amount: string | null): string {
  const parts = [control.caption, amount ?? ''].filter((part) => part.length > 0);
  const text = parts.join(' · ');
  if (text.length > 0) return text.slice(0, COMMITMENT_MATCHED_TEXT_MAX);
  // Neither a caption nor a figure: the page's own key for the control, through
  // the caller's sanitiser and kept to a name's length. See
  // COMMITMENT_FALLBACK_TEXT_MAX for why it is not a caption's clamp.
  return control.fallbackText.length > 0
    ? control.fallbackText
    : control.key.slice(0, COMMITMENT_FALLBACK_TEXT_MAX);
}

/**
 * ⛔ THE ONE PLACE AN APPROVAL COVERS A TAP THE CUSTOMER DID NOT SEE, and the
 * reason a two-step confirm is one prompt rather than two: the second step of
 * the SAME commitment, in the same turn, submitting to the same place, for no
 * more than what was approved.
 *
 * Fail-closed in every direction it can be: an unknown amount on either side
 * does not release, a different destination does not release, a different
 * category does not release. It can only release a halt THIS arm raised — a
 * caption halt is decided before this is consulted — so the behaviour that
 * shipped is untouched by it.
 */
export function commitmentReleasedByApproval(
  budget: CommitmentBudget,
  verdict: CommitmentVerdict,
  control: { action: string; key?: string },
): boolean {
  const approved = budget.approved;
  if (approved === null) return false;
  if (approved.category !== verdict.category) return false;
  if (approved.action !== control.action) return false;
  // ⛔ NOT A CONTROL THE APPROVED PAGE WAS ALREADY OFFERING. A second step is
  // one the customer reaches AFTER the step they approved; a second button
  // beside the first is a second decision, however alike the two look.
  if (control.key !== undefined && approved.siblings.has(control.key)) return false;
  const value = verdict.amount === null ? null : amountValueOf(verdict.amount);
  if (approved.value === null || value === null) return false;
  if (value > approved.value) return false;
  budget.approved = null;
  return true;
}

/** The control a verdict was reached on, for the release rule's destination
 *  comparison. Looked up by the same keys the verdict used. */
export function commitControlForTap(
  facts: PageCommitFacts,
  selector: string,
): CommitControl | undefined {
  for (const key of selectorKeysForTap(selector)) {
    const found = facts.controls.get(key);
    if (found !== undefined) return found;
  }
  return undefined;
}
