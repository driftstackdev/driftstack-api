// The DOM the fake device browses, and the three readings the harness takes of
// it: the SOURCE a `get_page_source` returns, the VISIBLE TEXT a person would
// read, and whether an element can be INTERACTED with.
//
// WHY A REAL DOM. The device used to match a selector by exact string equality
// against a hand-listed element array. That is fine while we write both the
// page and the plan — and it fails every plan a real model writes, for a reason
// that is not a fact about the agent: `button#buy` and `#buy` address the same
// node and only one of them was in the list. A parsed document resolved with
// `querySelector` semantics is the smallest thing that removes that artefact.
//
// ⛔ WHAT THIS STILL IS NOT. There is no layout, no CSS cascade, no script
// execution and no shadow DOM. "Visible" and "interactable" are therefore read
// off MARKUP alone — the `hidden` attribute, an inline `display:none` /
// `visibility:hidden`, `disabled`, `type="hidden"` — which is the subset a
// fixture can state without a stylesheet. A page hidden by a class rule is not
// modelled, and the fixtures do not pretend it is.

import { JSDOM, type DomDocument, type DomElement, type DomNode } from 'jsdom';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** One parsed page. Owns its window so a replaced page can be released. */
export class PageDom {
  private readonly dom: JSDOM;

  constructor(html: string, url: string) {
    // `about:blank` and friends are valid here; a fixture url always is.
    this.dom = new JSDOM(html, { url: isHttpUrl(url) ? url : 'about:blank' });
  }

  get document(): DomDocument {
    return this.dom.window.document;
  }

  /** What `get_page_source` returns: the doctype and the live document, as it
   *  is NOW — an element a script inserted a moment ago is in it, and a value a
   *  person typed is not (a typed value is a property, never an attribute). */
  serialize(): string {
    return this.dom.serialize();
  }

  close(): void {
    this.dom.window.close();
  }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Assemble a whole document from a fixture's parts. */
export function documentHtml(parts: { title: string; head?: string; body: string }): string {
  return (
    '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(parts.title)}</title>${parts.head ?? ''}</head>` +
    `<body>${parts.body}</body></html>`
  );
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class InvalidSelectorError extends Error {
  constructor(selector: string) {
    super(`"${selector}" is not a selector this document can evaluate`);
    this.name = 'InvalidSelectorError';
  }
}

/**
 * `querySelector`, with the one failure a caller must tell apart from "matched
 * nothing": a selector the engine cannot parse. WebDriver reports those two
 * differently (`invalid selector` vs `no such element`) and so must the device —
 * one is a planning fault, the other is page state.
 */
export function queryFirst(document: DomDocument, selector: string): DomElement | null {
  try {
    return document.querySelector(selector);
  } catch {
    throw new InvalidSelectorError(selector);
  }
}

export function queryAll(document: DomDocument, selector: string): DomElement[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    throw new InvalidSelectorError(selector);
  }
}

function isElement(node: DomNode): node is DomElement {
  return node.nodeType === ELEMENT_NODE;
}

const NEVER_RENDERED_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
]);

function inlineStyleHides(element: DomElement): boolean {
  const style = element.getAttribute('style');
  if (style === null) return false;
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

/** Hidden by ITS OWN markup (not by an ancestor's). */
function hidesItself(element: DomElement): boolean {
  if (NEVER_RENDERED_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute('hidden')) return true;
  if (element.tagName === 'INPUT' && element.getAttribute('type')?.toLowerCase() === 'hidden') {
    return true;
  }
  return inlineStyleHides(element);
}

/** Rendered at all: neither it nor any ancestor is hidden by markup. */
export function isRendered(element: DomElement): boolean {
  for (let node: DomElement | null = element; node !== null; node = node.parentElement) {
    if (hidesItself(node)) return false;
  }
  return true;
}

/** Rendered AND enabled — what a tap or a keystroke needs. */
export function isInteractable(element: DomElement): boolean {
  return isRendered(element) && !element.hasAttribute('disabled');
}

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'THEAD',
  'TR',
  'UL',
]);

/**
 * The text a person would read off the page, one line per block.
 *
 * WHO USES IT, AND WHY IT IS NOT THE SOURCE. `get_page_source` hands back
 * markup, which is what the product's page digest and its real answer model
 * consume. The SCRIPTED tier's stand-in answerer is a line rule ("the line that
 * starts with …") and the extraction bound asks "how much of the PAGE came back
 * in the answer" — both are questions about the words on the page, not about
 * its tags. Reading them off this rendering keeps them answering the question
 * they were written to answer after the device started returning real HTML.
 *
 * A source with no markup at all reads as itself, line for line, so a device
 * that returns rendered text is handled by the same function.
 */
export function visibleTextOf(source: string): string {
  if (!/<[a-zA-Z!/]/.test(source)) return source;
  const page = new PageDom(source, 'about:blank');
  try {
    const lines: string[] = [];
    let current = '';
    const flush = (): void => {
      const line = current.replace(/\s+/g, ' ').trim();
      if (line.length > 0) lines.push(line);
      current = '';
    };
    const walk = (node: DomNode): void => {
      if (node.nodeType === TEXT_NODE) {
        current += node.textContent ?? '';
        return;
      }
      if (!isElement(node) || hidesItself(node)) return;
      if (node.tagName === 'BR') {
        flush();
        return;
      }
      const block = BLOCK_TAGS.has(node.tagName);
      if (block) flush();
      // A table cell is not a line of its own, but two cells are not one word.
      if (node.tagName === 'TD' || node.tagName === 'TH') current += ' ';
      for (const child of Array.from(node.childNodes)) walk(child);
      if (block) flush();
    };
    walk(page.document.body);
    flush();
    return lines.join('\n');
  } finally {
    page.close();
  }
}

/** A short, secret-free description of an element, for traces and reports. */
export function describeElement(element: DomElement): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id.length > 0 ? `#${element.id}` : '';
  const name = element.getAttribute('name');
  const href = element.getAttribute('href');
  const label = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return (
    `${tag}${id}` +
    (name !== null ? `[name="${name}"]` : '') +
    (href !== null ? `[href="${href}"]` : '') +
    (label.length > 0 ? ` "${label}"` : '')
  );
}
