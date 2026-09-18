// The fictional web the agent eval harness browses.
//
// Every site here is a `.test` TLD (RFC 2606, reserved and unresolvable), never
// a real host and never the product's own marketing domain — the planner prompt
// refuses that domain as a destination, so a fixture using it would be measuring
// the refusal instead of the task.
//
// A PAGE IS REAL HTML PLUS DECLARED BEHAVIOUR. The markup is parsed into a DOM
// the device resolves selectors against with `querySelector` semantics, and
// `get_page_source` serialises that same DOM — so the product's page digest, a
// live model and the device are all looking at one document. What a browser
// would do with script is DECLARED here instead of executed: content that
// renders late, content that renders on scroll, an overlay that intercepts, a
// click that changes the page, a form that accepts or rejects what was typed.
//
// ⛔ WHAT THIS IS NOT. There is no layout, no CSS cascade, no shadow DOM and no
// JS execution. That is enough to measure WHERE a plan dies and why, and it is
// not evidence about any real site. See RISKS in `agent-eval-suite.test.ts`.

/** One declared change to the page or the device. */
export type PageEffect =
  /** Remove the first element matching `target`. */
  | { kind: 'remove'; target: string }
  /** Parse `html` and append it inside the first element matching `into`. */
  | { kind: 'insert'; into: string; html: string }
  | { kind: 'set_attribute'; target: string; name: string; value: string }
  | { kind: 'remove_attribute'; target: string; name: string }
  /** Present → absent, absent → present. A menu toggle is this on `hidden`. */
  | { kind: 'toggle_attribute'; target: string; name: string }
  | { kind: 'set_text'; target: string; text: string }
  /** A durable device flag — how a task asserts "the thing actually happened".
   *  It outlives the page, the way a cart or a cookie does. */
  | { kind: 'set_flag'; flag: string }
  /** The device's session on this host is signed in from now on. */
  | { kind: 'authenticate'; host: string }
  /** Go somewhere (absolute, or relative to the current page). */
  | { kind: 'navigate'; url: string }
  /** Build the url from the submitting form's own `action` and field values, as
   *  a GET form does, and go there. Only meaningful inside a form behaviour. */
  | { kind: 'submit_get' }
  /**
   * Empty every field of the submitting form, as a server does when it rejects
   * a submission and renders the form again. Only meaningful inside a form
   * behaviour.
   *
   * WHY IT EXISTS. `send_keys` APPENDS, as WebDriver's does. A rejected login
   * that kept what was typed therefore made a retry UNWINNABLE — the re-typed
   * password landed after the wrong one — which no real login page does, and
   * which would fail every re-plan for a reason that is not a fact about the
   * agent.
   */
  | { kind: 'clear_fields' };

export interface ClickBehaviour {
  /** Fires when the clicked element matches this selector or sits inside a
   *  match — a tap on the icon inside a button is a tap on the button. */
  target: string;
  effects: ReadonlyArray<PageEffect>;
  /** Suppress the element's own default action (following a link, submitting). */
  preventDefault?: boolean;
}

export interface FormBehaviour {
  /** The `<form>` this describes. */
  form: string;
  /**
   * What the site requires of the submitted values, by field name. Absent means
   * every submission is accepted. A string must equal the value exactly; a
   * pattern must match it.
   */
  accepts?: Readonly<Record<string, string | RegExp>>;
  onAccepted: ReadonlyArray<PageEffect>;
  /** Absent means a rejected submission changes nothing, which is what a form
   *  with client-side validation does. */
  onRejected?: ReadonlyArray<PageEffect>;
}

export interface FixturePage {
  url: string;
  title: string;
  /** Extra `<head>` markup. */
  head?: string;
  /** `<body>` markup AT LOAD. Anything that renders later is declared below,
   *  because a lazily-rendered region genuinely is not in the document yet. */
  body: string;
  /** Simulated ms a navigate to this page costs. */
  loadMs: number;
  /** Simulated ms a `wait:idle` after the load costs before the page is quiet. */
  settleMs: number;
  /** The status the navigate reports. Absent means the device sends no status
   *  at all, which is what a device older than the field does. */
  httpStatus?: number;
  /** Navigate resolves here instead (the plan's later selectors are then simply
   *  for the wrong page — no error, which is what makes redirects expensive). */
  redirectsTo?: string;
  /** Unauthenticated navigation lands on `loginUrl` instead. */
  requiresAuth?: { loginUrl: string };
  /** Navigate SUCCEEDS carrying `loadedAtTimeout: true` — a green step on a dead
   *  page. The scorer must not read that as progress. */
  neverFinishesLoading?: boolean;
  /** The page loads, and then never goes quiet: an idle wait times out. */
  neverSettles?: boolean;
  /** The load itself errors (proxy / DNS / TLS / HTTP). */
  loadFails?: boolean;
  /**
   * A query string on this page's url resolves to another page — how a search
   * page behaves whether it was reached by its form or by a typed address. The
   * first rule whose parameter matches wins; no match lands on `otherwise`.
   */
  queryRoutes?: {
    rules: ReadonlyArray<{ param: string; matches: RegExp; to: string }>;
    otherwise: string;
  };
  /** Applied at load when the device already holds the flag — a dismissed
   *  consent banner stays dismissed, a filled cart stays filled. */
  whenFlag?: ReadonlyArray<{ flag: string; effects: ReadonlyArray<PageEffect> }>;
  /** Rendered this long after the navigation STARTED. */
  lateRenders?: ReadonlyArray<{ afterMs: number; effects: ReadonlyArray<PageEffect> }>;
  /** Rendered once the viewport has scrolled this far — below the fold AND
   *  lazily rendered, so the document does not contain it before then. */
  scrollRenders?: ReadonlyArray<{ atScrollPx: number; effects: ReadonlyArray<PageEffect> }>;
  /** While an element matching one of these is rendered, a tap or a keystroke
   *  aimed OUTSIDE it is intercepted. The target IS present — it is covered, not
   *  absent — and keeping that distinction is the whole point of the F1 task. */
  overlays?: ReadonlyArray<string>;
  /** Elements whose tap point is below the fold: perceive reports it outside
   *  the viewport. A click is unaffected — it scrolls its target into view
   *  before it taps, which is exactly why "outside the viewport" is not
   *  "covered". */
  offViewport?: ReadonlyArray<string>;
  /** Elements whose tap point the hit test finds NOTHING at. A click is
   *  unaffected: the device gives no evidence either way. */
  nothingAtTapPoint?: ReadonlyArray<string>;
  /**
   * Once a click has scrolled `target` into view, `cover` — a sticky bar, a
   * floating button — sits over its tap point. perceive never scrolls, so a
   * look sees only that the target is off-screen (declare it in `offViewport`
   * too); the cover is found only where the tap actually lands. An unchecked
   * tap there ACTIVATES THE COVER, which is what a coordinate tap does on the
   * real device; a click sent with `require_unoccluded` is refused instead.
   */
  coveredAfterScroll?: ReadonlyArray<{ target: string; cover: string }>;
  /**
   * Elements that are REPLACED between the look and the tap (a list that
   * re-renders). A checked click is refused `target_not_resolved`; an unchecked
   * one lands where the element was and activates nothing.
   */
  detachedAtTap?: ReadonlyArray<string>;
  /**
   * Visually hidden inputs — a styled checkbox or radio — whose tap point lands
   * on their OWN `<label>` (wrapping them, or pointing at them with `for`). A tap
   * there toggles the input, as a browser forwards a label's click. A device
   * with the own-label verdict (A3 V-3360, the default) reports the label as a
   * CLEAR hit — `occluded: false`, `hit_via_own_label: true` — and its checked
   * click taps. A device that predates it (`predatesOwnLabelVerdict`) reports
   * the hit as occluded, `hit_is_not_target_or_descendant`, and REFUSES a click
   * sent with `require_unoccluded` with that same reason — wherever the tap
   * lands on the label, on-screen or after the click's scroll (declare
   * `offViewport` too for the latter).
   */
  tapPointOnOwnLabel?: ReadonlyArray<string>;
  /**
   * Like `tapPointOnOwnLabel`, but the tap point lands on `hit`, an element
   * INSIDE one of `target`'s own labels — the span a styled checkbox draws, or
   * a "terms" link written into its label. What that means is the device's
   * own-label rule (A3 V-3360), following HTML's interactive-content set: a
   * non-interactive `hit` forwards the tap to the control like the label does;
   * an interactive one (a link, a button…) takes the tap itself, so the device
   * reads it as covered and an unchecked tap there ACTIVATES IT. A `hit`
   * outside every label of `target` is a fixture bug, and throws.
   */
  tapPointInsideOwnLabel?: ReadonlyArray<{ target: string; hit: string }>;
  onClick?: ReadonlyArray<ClickBehaviour>;
  forms?: ReadonlyArray<FormBehaviour>;
}

/** A named collection of pages, addressed by absolute url. */
export type SiteMap = ReadonlyMap<string, FixturePage>;

export function siteOf(pages: ReadonlyArray<FixturePage>): SiteMap {
  const site = new Map<string, FixturePage>();
  for (const p of pages) {
    if (site.has(p.url)) throw new Error(`fixture site declares ${p.url} twice`);
    site.set(p.url, p);
  }
  return site;
}

// ── the scripted corpus ───────────────────────────────────────────────

const SHOP_DEALS_HEADLINE = 'Autumn sale — 40% off everything in stock';
const SHOP_SOLD_OUT_LINE = 'Cobalt travel mug (out of stock) — 65% off when restocked';
const DOCS_STARTER_PRICE = 'Starter — $29 per month, billed annually';
const SLOW_STATUS_LINE = 'All systems operational — last checked 2 minutes ago';
const SEARCH_FIRST_RESULT = 'Quietkey 7 wireless keyboard, low-profile';
const HELLO_GREETING = 'Good morning, traveller';

export const EVAL_SITES: SiteMap = siteOf([
  // P1 / F5 — a static deals page. The headline is on load; the sold-out line
  // exists only after a control the blind planner cannot know about is clicked.
  {
    url: 'https://shop.test/deals',
    title: 'Deals — shop.test',
    loadMs: 420,
    settleMs: 260,
    body:
      '<header><p class="crumb">Deals</p></header>' +
      '<main>' +
      `<h1 class="deal-headline">${SHOP_DEALS_HEADLINE}</h1>` +
      '<ul class="deals"><li class="deal">Walnut desk lamp — 40% off</li></ul>' +
      '<p><button id="show-sold-out" type="button">Show sold out</button></p>' +
      '<ul class="sold-out-deals"></ul>' +
      '</main>',
    onClick: [
      {
        target: '#show-sold-out',
        effects: [
          {
            kind: 'insert',
            into: 'ul.sold-out-deals',
            html: `<li class="sold-out-deal">${SHOP_SOLD_OUT_LINE}</li>`,
          },
        ],
      },
    ],
  },

  // F1 — the storefront. The add control is present but covered by a consent
  // overlay: an overlay does not make an element absent, and the two failures
  // want opposite handling.
  {
    url: 'https://shop.test/',
    title: 'shop.test',
    loadMs: 380,
    settleMs: 240,
    body:
      '<header><p class="brand">shop.test</p></header>' +
      '<main>' +
      '<article class="product"><h2>Blue mug — £14</h2>' +
      '<button data-add-to-cart="blue-mug" type="button">Add blue mug to cart</button></article>' +
      '<p id="cart-status">Cart: empty</p>' +
      '</main>' +
      '<div id="consent-overlay" role="dialog" aria-label="Cookie consent">' +
      '<p>We value your privacy. Accept cookies?</p>' +
      '<button class="accept" type="button">Accept cookies</button></div>',
    overlays: ['#consent-overlay'],
    whenFlag: [
      { flag: 'consent:shop.test', effects: [{ kind: 'remove', target: '#consent-overlay' }] },
      {
        flag: 'cart:blue-mug',
        effects: [{ kind: 'set_text', target: '#cart-status', text: 'Cart: 1 item' }],
      },
    ],
    onClick: [
      {
        target: '#consent-overlay button.accept',
        effects: [
          { kind: 'remove', target: '#consent-overlay' },
          { kind: 'set_flag', flag: 'consent:shop.test' },
        ],
      },
      {
        target: 'button[data-add-to-cart="blue-mug"]',
        effects: [
          { kind: 'set_flag', flag: 'cart:blue-mug' },
          { kind: 'set_text', target: '#cart-status', text: 'Cart: 1 item' },
        ],
      },
    ],
  },

  // F6 — checkout. Nothing here is ever dispatched: the consequential-action
  // gate halts the plan before the tap reaches the device.
  {
    url: 'https://shop.test/checkout',
    title: 'Checkout — shop.test',
    loadMs: 400,
    settleMs: 200,
    body:
      '<main><h1>Checkout</h1><p class="line-item">Blue mug — £14</p>' +
      '<form id="checkout-form" action="/checkout" method="post">' +
      '<p><button id="buy-now" type="submit">Buy now</button></p></form></main>',
    forms: [
      {
        form: '#checkout-form',
        onAccepted: [{ kind: 'set_flag', flag: 'purchased:blue-mug' }],
      },
    ],
  },

  // P2 — a plain page to screenshot. No read intent in the task, so no read-back.
  {
    url: 'https://news.test/',
    title: 'news.test',
    loadMs: 500,
    settleMs: 300,
    body:
      '<header><p class="brand">news.test</p></header>' +
      '<main><h1>Today</h1><p class="lead">Ferry service resumes on the north route</p></main>',
  },

  // P3 — the price is lazily rendered below the fold. Not a viewport trick: the
  // node is absent from the document until the scroll triggers its render, which
  // is why `get_page_source` cannot see it either.
  {
    url: 'https://docs.test/pricing',
    title: 'Pricing — docs.test',
    loadMs: 460,
    settleMs: 280,
    body: '<main><h1>Pricing</h1><p class="lead">Compare plans</p><div id="plans"></div></main>',
    scrollRenders: [
      {
        atScrollPx: 800,
        effects: [
          {
            kind: 'insert',
            into: '#plans',
            html:
              `<section id="plan-starter"><p class="price">${DOCS_STARTER_PRICE}</p></section>` +
              '<section id="plan-team"><p class="price">Team — $89 per month</p></section>',
          },
        ],
      },
    ],
  },

  // P4 — open-ended. Nothing here can fail; the task measures whether the plan
  // contains human beats at all, or is the navigate+capture shape of giving up.
  {
    url: 'https://blog.test/',
    title: 'blog.test',
    loadMs: 440,
    settleMs: 260,
    body:
      '<header><p class="brand">blog.test</p></header>' +
      '<main><article class="top"><h2>What the tide leaves behind</h2>' +
      '<p>A long piece about coastal erosion, in nine parts.</p></article></main>',
  },

  // P5 — search. A stable input, Enter submits, results land on their own page.
  {
    url: 'https://search.test/',
    title: 'search.test',
    loadMs: 350,
    settleMs: 180,
    body:
      '<header><p class="brand">search.test</p></header>' +
      '<main><form id="search" action="/results" method="get" role="search">' +
      '<p><label for="q">Search the web</label></p>' +
      '<p><input id="q" name="q" type="search" placeholder="Search"></p></form></main>',
    forms: [
      {
        form: '#search',
        onAccepted: [{ kind: 'navigate', url: 'https://search.test/results' }],
      },
    ],
  },
  {
    url: 'https://search.test/results',
    title: 'wireless keyboard — search.test',
    loadMs: 300,
    settleMs: 200,
    body:
      '<main><h1>Results for wireless keyboard</h1><ol class="results">' +
      `<li class="result"><h3>1. ${SEARCH_FIRST_RESULT}</h3></li>` +
      '<li class="result"><h3>2. Slab 60 mechanical keyboard</h3></li></ol></main>',
  },

  // P6 — a genuinely slow page. Measures whether wait:idle actually covers a
  // load that takes seconds rather than milliseconds.
  {
    url: 'https://slow.test/',
    title: 'Status — slow.test',
    loadMs: 4000,
    settleMs: 1200,
    body: `<main><h1>slow.test status</h1><p id="status">${SLOW_STATUS_LINE}</p></main>`,
  },

  // F2 — the login wall. /inbox is authenticated, so the navigate lands on
  // /login and every selector the plan holds is for a page it never reached.
  {
    url: 'https://mail.test/inbox',
    title: 'Inbox — mail.test',
    loadMs: 520,
    settleMs: 300,
    requiresAuth: { loginUrl: 'https://mail.test/login' },
    body: '<main><h1>Inbox</h1><p id="unread-count">4 unread messages</p></main>',
  },
  {
    url: 'https://mail.test/login',
    title: 'Sign in — mail.test',
    loadMs: 300,
    settleMs: 160,
    body:
      '<main><h1>Sign in to mail.test</h1>' +
      '<form id="login" action="/inbox" method="post">' +
      '<div class="field"><label for="email">Email</label>' +
      '<input id="email" name="email" type="email" autocomplete="username"></div>' +
      '<div class="field"><label for="password">Password</label>' +
      '<input id="password" name="password" type="password" autocomplete="current-password"></div>' +
      '<p><button type="submit">Sign in</button></p><p id="login-error" hidden></p></form></main>',
    forms: [
      {
        form: '#login',
        // The scripted corpus threads no credentials, so nothing this site would
        // accept can arrive. A pattern that matches nothing says so outright.
        accepts: { email: /^(?!)$/ },
        onAccepted: [],
        onRejected: [
          { kind: 'set_text', target: '#login-error', text: 'Those details were not recognised.' },
          { kind: 'remove_attribute', target: '#login-error', name: 'hidden' },
        ],
      },
    ],
  },

  // F3 — the control the page renders late. 2500ms against an executor whose
  // whole retry budget used to be two 400ms retries.
  {
    url: 'https://app.test/',
    title: 'app.test',
    loadMs: 300,
    settleMs: 200,
    body:
      '<header><p class="brand">app.test</p></header>' +
      '<main><h1>Setting things up</h1><div id="actions"></div></main>',
    lateRenders: [
      {
        afterMs: 2500,
        effects: [
          {
            kind: 'insert',
            into: '#actions',
            html: '<button id="continue" type="button">Continue</button>',
          },
        ],
      },
    ],
    onClick: [{ target: '#continue', effects: [{ kind: 'set_flag', flag: 'continue:clicked' }] }],
  },

  // F4 — the thread url is discoverable only from the index. A planner that
  // cannot look at the page has to guess it, and a guess lands on the 404.
  {
    url: 'https://forum.test/',
    title: 'forum.test',
    loadMs: 420,
    settleMs: 240,
    body:
      '<header><p class="brand">forum.test</p></header>' +
      '<main><ul class="threads">' +
      '<li><a href="/t/9182">Battery recall — what we know</a></li>' +
      '<li>Ferry timetable 2027</li></ul></main>',
  },
  {
    url: 'https://forum.test/t/9182',
    title: 'Battery recall — forum.test',
    loadMs: 380,
    settleMs: 220,
    body:
      '<main><h1>Battery recall — what we know</h1>' +
      '<section class="reply top"><p class="body">Top reply: Only the 2024 units are affected.</p></section></main>',
  },

  // Controls. Trivially completable, and impossible.
  {
    url: 'https://hello.test/',
    title: 'hello.test',
    loadMs: 100,
    settleMs: 100,
    body:
      '<header><p class="brand">hello.test</p></header>' +
      `<main><p id="greeting">${HELLO_GREETING}</p></main>`,
  },
  {
    url: 'https://void.test/',
    title: 'void.test',
    loadMs: 100,
    settleMs: 100,
    body: '<p>void.test</p>',
  },
  // C-NEG-SCORED — a page that LOADS CLEANLY and simply does not carry the
  // asked-for information. Everything about this navigation is green; the
  // failure has to come out of the answer-scoring path or it does not come at
  // all, which is exactly what this control exists to detect.
  {
    url: 'https://quiet.test/',
    title: 'quiet.test',
    loadMs: 120,
    settleMs: 90,
    body:
      '<header><p class="brand">quiet.test</p></header>' +
      '<main><p>A small page with very little on it.</p>' +
      '<p>No contact details are published here.</p></main>',
  },
]);

/** The strings the task criteria key on, exported so a page edit and a task
 *  expectation cannot drift apart silently. */
export const EVAL_PAGE_TEXT = {
  shopDealsHeadline: SHOP_DEALS_HEADLINE,
  shopSoldOutLine: SHOP_SOLD_OUT_LINE,
  docsStarterPrice: DOCS_STARTER_PRICE,
  slowStatusLine: SLOW_STATUS_LINE,
  searchFirstResult: SEARCH_FIRST_RESULT,
  helloGreeting: HELLO_GREETING,
} as const;

/** How a site answers for an address it does not have. */
export interface NotFoundBehaviour {
  /**
   * The status the navigate reports, or absent for a device that reports none.
   *
   * ⚠️ THE TWO ARE DIFFERENT PRODUCTS. Without a status a 404 LOADS — a green
   * navigate onto a page with nothing on it, so the plan dies later than the
   * mistake. With one, the product turns it into an honest navigation failure a
   * re-plan can follow. The scripted corpus pins the first (its F4 task is the
   * measurement of exactly that cost); the live corpus declares the second.
   */
  httpStatus?: number;
  /** `<body>` markup of the error page. A real one usually links home. */
  body?: string;
}

const DEFAULT_NOT_FOUND_BODY =
  '<main><h1>Not found</h1><p>The page you asked for does not exist.</p></main>';

/** The page a url that is not in the site map resolves to. */
export function notFoundPage(url: string, behaviour: NotFoundBehaviour = {}): FixturePage {
  return {
    url,
    title: 'Not found',
    loadMs: 250,
    settleMs: 120,
    ...(behaviour.httpStatus !== undefined ? { httpStatus: behaviour.httpStatus } : {}),
    body: behaviour.body ?? DEFAULT_NOT_FOUND_BODY,
  };
}
