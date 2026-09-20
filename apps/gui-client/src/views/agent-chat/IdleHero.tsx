// The first screen: nothing has run yet, so this is where the customer finds
// out what the thing does and picks somewhere to start.
//
// Stage 2 of the AI-view rebuild (spec §3.8). What changed, and why:
//
// · It is COMPOSED, not centred. The old empty state was a 48px icon over a
//   centred paragraph over four stacked buttons, floating in the middle of a
//   column — the shape of a "no results" state, on the screen that has to sell
//   the product. It now reads top-down like a page: a label, one large light
//   headline, one sentence, three beats, then the templates.
// · The headline SAYS WHAT HAPPENS: "Describe it. Watch it happen."
// · The three beats answer the three questions a stranger has before pressing a
//   button that drives a real browser — what does it do with my words, can I
//   see it, and will it buy something.
// · Each template carries a mono GUARD TAG naming the one thing it will not do.
//   The tag comes from the template itself (lib/assistant-templates.ts), beside
//   the prompt it is a promise about, so the two cannot drift.
//
// Picking one still fills, focuses and grows the composer — unchanged.

import { DEFAULT_ASSISTANT_TEMPLATES, type AssistantTemplate } from '../../lib/assistant-templates';
import { IconCamera, IconCart, IconGlobe, IconSearch, IconSparkle } from './icons';

function TemplateIcon({ icon }: { icon: AssistantTemplate['icon'] }): JSX.Element {
  switch (icon) {
    case 'globe':
      return <IconGlobe />;
    case 'search':
      return <IconSearch />;
    case 'camera':
      return <IconCamera />;
    case 'cart':
      return <IconCart />;
    default:
      // A custom template (or a built-in added without one) gets the view's own
      // mark rather than a drawing that claims something about what it does.
      return <IconSparkle />;
  }
}

export function IdleHero({
  onPick,
  preview = false,
  gated = false,
}: {
  onPick: (text: string) => void;
  /**
   * The deployment plans steps but does not carry them out on a real iPhone.
   * The promise in the hero has to change with it — "runs them on a real iPhone
   * you can watch" is the whole pitch, and it would be a lie here.
   */
  preview?: boolean;
  /**
   * A gate card stands above the hero (no API key). Spec §3.8: the card TAKES
   * THE BEATS' PLACE, so the first screen still ends at the templates instead
   * of pushing them below the fold — the card already answers "what do I do
   * next", which is the beats' job, and it is the more urgent answer.
   */
  gated?: boolean;
}): JSX.Element {
  return (
    <div
      className="ai-hello mx-auto w-full max-w-3xl"
      /* Valueless-or-absent (the view's rule — `data-x={false}` renders the
         STRING "false", which an attribute selector matches). The short tier
         reads it to take §3.8's trade one step further: the gate card already
         took the beats' place, and in the 600px-tall window it takes the
         EXPLAINER's place too, because its own body — "You can explore
         templates and draft a task now" — is the same orientation sentence for
         this one state, and without that the first row of templates was sliced
         through the middle at a scroll position of 0. */
      data-gated={gated ? '' : undefined}
    >
      <span className="section-label">New task</span>
      <h1 className="ai-voice ai-voice-xl">
        Describe it. <em>Watch it happen.</em>
      </h1>
      <p>
        {preview
          ? 'Say what you want in plain language. Driftstack plans the steps and shows them here. In preview mode they are not carried out on a real iPhone yet.'
          : 'Say what you want in plain language. Driftstack plans the steps and runs them on a real iPhone you can watch — and it pauses for your approval before anything consequential, like a purchase or a payment.'}
      </p>
      {!preview && !gated && (
        <ol className="ai-beats">
          <li>
            <span className="ai-beat-n mono">01</span>
            <b>It plans</b>Your words become a short list of steps.
          </li>
          <li>
            <span className="ai-beat-n mono">02</span>
            <b>It runs, live</b>Every tap and scroll plays out on the iPhone.
          </li>
          <li>
            <span className="ai-beat-n mono">03</span>
            <b>It asks first</b>Nothing is bought, paid or deleted without you.
          </li>
        </ol>
      )}
      <div className="ai-tpl-h">
        <span className="section-label">Start from a template</span>
      </div>
      <div className="ai-tpl">
        {DEFAULT_ASSISTANT_TEMPLATES.map((t) => (
          <button key={t.id} type="button" onClick={() => onPick(t.prompt)}>
            <span className="ai-tpl-ico" aria-hidden="true">
              <TemplateIcon icon={t.icon} />
            </span>
            <span>
              <b>{t.label}</b>
              <span className="ai-tpl-desc">{t.description}</span>
              {t.guard !== undefined && <span className="ai-tpl-guard">{t.guard}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A gate that stands between the customer and a working chat, as a card above
 * the hero (spec §3.8). Two of them exist: "no API key", which is the app's own
 * `role="status"` gate and keeps every string and its `data-component`, and
 * "preview mode", which replaces the strip that used to sit under the header.
 *
 * ⛔ Exactly ONE `role="status"` may render in the idle no-key state
 * (agent-chat-save-recipe reads `getByRole('status')` with no name). The
 * preview card is therefore a plain `<div>`: it is a standing fact about the
 * deployment, not something that just changed.
 */
export function GateCard({
  icon,
  title,
  body,
  action,
  status = false,
  component,
}: {
  icon: JSX.Element;
  title: string;
  body: string;
  action?: JSX.Element;
  status?: boolean;
  component?: string;
}): JSX.Element {
  return (
    <div
      {...(status ? { role: 'status' } : {})}
      data-component={component}
      className="ai-card ai-gate mx-auto w-full max-w-3xl"
    >
      <span className="ai-card-ico" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span className="ai-gate-title">{title}</span>
        <span className="ai-gate-body">{body}</span>
      </span>
      {action}
    </div>
  );
}
