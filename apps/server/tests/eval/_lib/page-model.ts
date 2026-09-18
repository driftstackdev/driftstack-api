// The fictional web the agent eval harness browses.
//
// Every site here is a `.test` TLD (RFC 2606, reserved and unresolvable), never
// a real host and never the product's own marketing domain — the planner prompt
// refuses that domain as a destination, so a fixture using it would be measuring
// the refusal instead of the task.
//
// ⛔ WHAT THIS IS NOT. There is no rendering, no CSS cascade, no shadow DOM and
// no JS execution here. A page is a list of elements with declared availability
// rules. That is enough to measure WHERE a plan dies and why, and it is not
// evidence about any real site — we author both the page and the plan that
// targets it. See RISKS in `agent-eval-suite.test.ts`.

export type ElementKind = 'link' | 'button' | 'input' | 'text';

/** Side effects a click applies to device state. */
export interface ClickEffect {
  /** Navigate the device to this url (client-side route or form submit). */
  navigateTo?: string;
  /** Mark this selector dismissed, unblocking anything `blockedBy` it. */
  dismiss?: string;
  /** Reveal selectors that only exist after this click. */
  reveal?: string[];
  /** Set a durable device flag — how a task asserts "the thing actually happened". */
  setState?: string;
}

export interface ScriptedElement {
  /** CSS, written exactly as a planner would write it. */
  selector: string;
  /** Visible label. Only meaningful to `bodyText`; the device matches on selector. */
  text?: string;
  kind: ElementKind;
  /** Present only once this much simulated time has elapsed (0/absent = at load). */
  appearsAfterMs?: number;
  /** Present only once the viewport has scrolled this far (below the fold, and
   *  lazily rendered — the DOM genuinely does not contain it before then). */
  appearsAfterScrollPx?: number;
  /** Exists only after the named selector has been clicked. */
  revealedBy?: string;
  /** An overlay that must be dismissed first. The element IS present — it is
   *  intercepted, not absent, and keeping that distinction is the whole point of
   *  the F1 task. */
  blockedBy?: string;
  onClick?: ClickEffect;
  onType?: { reveal?: string[] };
}

export interface ScriptedPage {
  url: string;
  title: string;
  /** Simulated ms a navigate to this page costs. */
  loadMs: number;
  /** Simulated ms a `wait:idle` after the load costs before the page is quiet. */
  settleMs: number;
  /** Navigate resolves here instead (the plan's later selectors are then simply
   *  for the wrong page — no error, which is what makes redirects expensive). */
  redirectsTo?: string;
  /** Unauthenticated navigation lands on `loginUrl` instead. */
  requiresAuth?: { loginUrl: string };
  /** Navigate SUCCEEDS carrying `loadedAtTimeout: true` — a green step on a dead
   *  page. The scorer must not read that as progress. */
  neverFinishesLoading?: boolean;
  /** The load itself errors (proxy / DNS / TLS / HTTP). */
  loadFails?: boolean;
  /** Pressing Enter on this page (a focused search box, a form). */
  onEnter?: { navigateTo?: string; reveal?: string[] };
  elements: ScriptedElement[];
  /** What `get_page_source` returns — a function of device state, because a
   *  lazily-rendered region genuinely is not in the DOM until it renders. */
  bodyText: (state: DeviceStateView) => string;
}

/** The read-only projection of device state a page script may consult. */
export interface DeviceStateView {
  currentUrl: string;
  elapsedMs: number;
  scrollPx: number;
  dismissed: ReadonlySet<string>;
  revealed: ReadonlySet<string>;
  typed: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}

/** A named collection of pages, addressed by absolute url. */
export type SiteMap = ReadonlyMap<string, ScriptedPage>;

function page(p: ScriptedPage): [string, ScriptedPage] {
  return [p.url, p];
}

// ── the corpus ────────────────────────────────────────────────────────

const SHOP_DEALS_HEADLINE = 'Autumn sale — 40% off everything in stock';
const SHOP_SOLD_OUT_LINE = 'Cobalt travel mug (out of stock) — 65% off when restocked';
const DOCS_STARTER_PRICE = 'Starter — $29 per month, billed annually';
const SLOW_STATUS_LINE = 'All systems operational — last checked 2 minutes ago';
const SEARCH_FIRST_RESULT = 'Quietkey 7 wireless keyboard, low-profile';
const HELLO_GREETING = 'Good morning, traveller';

export const EVAL_SITES: SiteMap = new Map<string, ScriptedPage>([
  // P1 / F5 — a static deals page. The headline is on load; the sold-out line
  // exists only after a control the blind planner cannot know about is clicked.
  page({
    url: 'https://shop.test/deals',
    title: 'Deals — shop.test',
    loadMs: 420,
    settleMs: 260,
    elements: [
      { selector: 'h1.deal-headline', text: SHOP_DEALS_HEADLINE, kind: 'text' },
      {
        selector: 'button#show-sold-out',
        text: 'Show sold out',
        kind: 'button',
        onClick: { reveal: ['li.sold-out-deal'] },
      },
      {
        selector: 'li.sold-out-deal',
        text: SHOP_SOLD_OUT_LINE,
        kind: 'text',
        revealedBy: 'button#show-sold-out',
      },
    ],
    bodyText: (s) =>
      [
        'Deals',
        SHOP_DEALS_HEADLINE,
        'Walnut desk lamp — 40% off',
        'Show sold out',
        ...(s.revealed.has('li.sold-out-deal') ? [SHOP_SOLD_OUT_LINE] : []),
      ].join('\n'),
  }),

  // F1 — the storefront. The add control is present but intercepted by a consent
  // overlay: an overlay does not make an element absent, and the two failures
  // want opposite handling.
  page({
    url: 'https://shop.test/',
    title: 'shop.test',
    loadMs: 380,
    settleMs: 240,
    elements: [
      {
        selector: '#consent-overlay button.accept',
        text: 'Accept cookies',
        kind: 'button',
        onClick: { dismiss: '#consent-overlay' },
      },
      {
        selector: 'button[data-add-to-cart="blue-mug"]',
        text: 'Add blue mug to cart',
        kind: 'button',
        blockedBy: '#consent-overlay',
        onClick: { setState: 'cart:blue-mug' },
      },
    ],
    bodyText: (s) =>
      [
        'shop.test',
        ...(s.dismissed.has('#consent-overlay') ? [] : ['We value your privacy. Accept cookies?']),
        'Blue mug — £14',
        ...(s.flags.has('cart:blue-mug') ? ['Cart: 1 item'] : ['Cart: empty']),
      ].join('\n'),
  }),

  // F6 — checkout. Nothing here is ever dispatched: the consequential-action
  // gate halts the plan before the tap reaches the device.
  page({
    url: 'https://shop.test/checkout',
    title: 'Checkout — shop.test',
    loadMs: 400,
    settleMs: 200,
    elements: [
      {
        selector: '#buy-now',
        text: 'Buy now',
        kind: 'button',
        onClick: { setState: 'purchased:blue-mug' },
      },
    ],
    bodyText: () => ['Checkout', 'Blue mug — £14', 'Buy now'].join('\n'),
  }),

  // P2 — a plain page to screenshot. No read intent in the task, so no read-back.
  page({
    url: 'https://news.test/',
    title: 'news.test',
    loadMs: 500,
    settleMs: 300,
    elements: [{ selector: 'h1', text: 'Today', kind: 'text' }],
    bodyText: () => ['news.test', 'Today', 'Ferry service resumes on the north route'].join('\n'),
  }),

  // P3 — the price is lazily rendered below the fold. Not a viewport trick: the
  // node is absent from the document until the scroll triggers its render, which
  // is why `get_page_source` cannot see it either.
  page({
    url: 'https://docs.test/pricing',
    title: 'Pricing — docs.test',
    loadMs: 460,
    settleMs: 280,
    elements: [
      { selector: 'h1', text: 'Pricing', kind: 'text' },
      {
        selector: '#plan-starter .price',
        text: DOCS_STARTER_PRICE,
        kind: 'text',
        appearsAfterScrollPx: 800,
      },
    ],
    bodyText: (s) =>
      [
        'Pricing',
        'Compare plans',
        ...(s.scrollPx >= 800 ? [DOCS_STARTER_PRICE, 'Team — $89 per month'] : []),
      ].join('\n'),
  }),

  // P4 — open-ended. Nothing here can fail; the task measures whether the plan
  // contains human beats at all, or is the navigate+capture shape of giving up.
  page({
    url: 'https://blog.test/',
    title: 'blog.test',
    loadMs: 440,
    settleMs: 260,
    elements: [
      { selector: 'article.top h2', text: 'What the tide leaves behind', kind: 'text' },
      { selector: 'article.top p', text: 'A long piece about coastal erosion.', kind: 'text' },
    ],
    bodyText: () =>
      [
        'blog.test',
        'What the tide leaves behind',
        'A long piece about coastal erosion, in nine parts.',
      ].join('\n'),
  }),

  // P5 — search. A stable input, Enter submits, results land on their own page.
  page({
    url: 'https://search.test/',
    title: 'search.test',
    loadMs: 350,
    settleMs: 180,
    onEnter: { navigateTo: 'https://search.test/results' },
    elements: [{ selector: 'input[name="q"]', text: 'Search', kind: 'input' }],
    bodyText: () => ['search.test', 'Search the web'].join('\n'),
  }),
  page({
    url: 'https://search.test/results',
    title: 'wireless keyboard — search.test',
    loadMs: 300,
    settleMs: 200,
    elements: [
      { selector: 'li.result:first-child h3', text: SEARCH_FIRST_RESULT, kind: 'link' },
      { selector: 'li.result:nth-child(2) h3', text: 'Slab 60 mechanical keyboard', kind: 'link' },
    ],
    bodyText: () =>
      [
        'Results for wireless keyboard',
        `1. ${SEARCH_FIRST_RESULT}`,
        '2. Slab 60 mechanical keyboard',
      ].join('\n'),
  }),

  // P6 — a genuinely slow page. Measures whether wait:idle actually covers a
  // load that takes seconds rather than milliseconds.
  page({
    url: 'https://slow.test/',
    title: 'Status — slow.test',
    loadMs: 4000,
    settleMs: 1200,
    elements: [{ selector: '#status', text: SLOW_STATUS_LINE, kind: 'text' }],
    bodyText: () => ['slow.test status', SLOW_STATUS_LINE].join('\n'),
  }),

  // F2 — the login wall. /inbox is authenticated, so the navigate lands on
  // /login and every selector the plan holds is for a page it never reached.
  page({
    url: 'https://mail.test/inbox',
    title: 'Inbox — mail.test',
    loadMs: 520,
    settleMs: 300,
    requiresAuth: { loginUrl: 'https://mail.test/login' },
    elements: [{ selector: '#unread-count', text: '4 unread', kind: 'text' }],
    bodyText: () => ['Inbox', '4 unread messages'].join('\n'),
  }),
  page({
    url: 'https://mail.test/login',
    title: 'Sign in — mail.test',
    loadMs: 300,
    settleMs: 160,
    elements: [
      { selector: 'input[name="email"]', kind: 'input' },
      { selector: 'input[name="password"]', kind: 'input' },
      { selector: 'button[type="submit"]', text: 'Sign in', kind: 'button' },
    ],
    bodyText: () => ['Sign in to mail.test', 'Email', 'Password'].join('\n'),
  }),

  // F3 — the control the page renders late. 2500ms against an executor whose
  // whole patience budget is two 400ms retries.
  page({
    url: 'https://app.test/',
    title: 'app.test',
    loadMs: 300,
    settleMs: 200,
    elements: [
      { selector: 'h1', text: 'Setting things up', kind: 'text' },
      {
        selector: '#continue',
        text: 'Continue',
        kind: 'button',
        appearsAfterMs: 2500,
        onClick: { setState: 'continue:clicked' },
      },
    ],
    bodyText: (s) =>
      ['app.test', 'Setting things up', ...(s.elapsedMs >= 2500 ? ['Continue'] : [])].join('\n'),
  }),

  // F4 — the thread url is discoverable only from the index. A planner that
  // cannot look at the page has to guess it, and a guess lands on the 404.
  page({
    url: 'https://forum.test/',
    title: 'forum.test',
    loadMs: 420,
    settleMs: 240,
    elements: [
      {
        selector: 'a[href="/t/9182"]',
        text: 'Battery recall — what we know',
        kind: 'link',
        onClick: { navigateTo: 'https://forum.test/t/9182' },
      },
    ],
    bodyText: () =>
      ['forum.test', 'Battery recall — what we know', 'Ferry timetable 2027'].join('\n'),
  }),
  page({
    url: 'https://forum.test/t/9182',
    title: 'Battery recall — forum.test',
    loadMs: 380,
    settleMs: 220,
    elements: [
      { selector: '.reply.top .body', text: 'Only the 2024 units are affected.', kind: 'text' },
    ],
    bodyText: () =>
      ['Battery recall — what we know', 'Top reply: Only the 2024 units are affected.'].join('\n'),
  }),

  // Controls. Trivially completable, and impossible.
  page({
    url: 'https://hello.test/',
    title: 'hello.test',
    loadMs: 100,
    settleMs: 100,
    elements: [{ selector: '#greeting', text: HELLO_GREETING, kind: 'text' }],
    bodyText: () => ['hello.test', HELLO_GREETING].join('\n'),
  }),
  page({
    url: 'https://void.test/',
    title: 'void.test',
    loadMs: 100,
    settleMs: 100,
    elements: [],
    bodyText: () => 'void.test',
  }),
  // C-NEG-SCORED — a page that LOADS CLEANLY and simply does not carry the
  // asked-for information. Everything about this navigation is green; the
  // failure has to come out of the answer-scoring path or it does not come at
  // all, which is exactly what this control exists to detect.
  page({
    url: 'https://quiet.test/',
    title: 'quiet.test',
    loadMs: 120,
    settleMs: 90,
    elements: [{ selector: 'h1', text: 'Quiet', kind: 'text' }],
    bodyText: () =>
      [
        'quiet.test',
        'A small page with very little on it.',
        'No contact details are published here.',
      ].join('\n'),
  }),
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

/**
 * The page a url that is not in the site map resolves to.
 *
 * A 404 LOADS — it is a successful navigation to a page with nothing on it —
 * which is exactly why a guessed url is expensive: the plan gets a green
 * navigate and then dies on a selector, several steps from the real mistake.
 */
export function notFoundPage(url: string): ScriptedPage {
  return {
    url,
    title: 'Not found',
    loadMs: 250,
    settleMs: 120,
    elements: [],
    bodyText: () => 'Not found\nThe page you asked for does not exist.',
  };
}
