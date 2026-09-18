// A minimal, hand-written declaration for the one DOM library this harness uses.
//
// WHY THIS FILE EXISTS. `jsdom` is already installed for the browser-facing
// workspaces, but its community typings are not, and this workspace compiles
// without the DOM lib on purpose (it is a server). Declaring the handful of
// members the fake device actually calls keeps the eval typed WITHOUT adding a
// dependency or widening the server's global types to a browser's.
//
// ⚠️ ONLY WHAT IS USED IS DECLARED. A member missing here is a compile error at
// the call site, which is the right failure: it forces a look at whether the
// device should be doing that at all.

declare module 'jsdom' {
  export interface DomNode {
    readonly nodeType: number;
    readonly nodeName: string;
    textContent: string | null;
    readonly parentElement: DomElement | null;
    readonly childNodes: ArrayLike<DomNode>;
  }

  export interface DomElement extends DomNode {
    readonly tagName: string;
    readonly id: string;
    readonly outerHTML: string;
    innerHTML: string;
    readonly children: ArrayLike<DomElement>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    querySelector(selector: string): DomElement | null;
    querySelectorAll(selector: string): ArrayLike<DomElement>;
    matches(selector: string): boolean;
    closest(selector: string): DomElement | null;
    contains(other: DomNode | null): boolean;
    remove(): void;
    insertAdjacentHTML(
      position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend',
      html: string,
    ): void;
  }

  export interface DomDocument {
    readonly documentElement: DomElement;
    readonly body: DomElement;
    readonly head: DomElement;
    title: string;
    querySelector(selector: string): DomElement | null;
    querySelectorAll(selector: string): ArrayLike<DomElement>;
  }

  export interface DomWindow {
    readonly document: DomDocument;
    close(): void;
  }

  export class JSDOM {
    constructor(html?: string, options?: { url?: string; contentType?: string });
    readonly window: DomWindow;
    serialize(): string;
  }
}
