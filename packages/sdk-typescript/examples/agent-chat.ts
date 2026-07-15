// Agent chat flow — drive a multi-turn agent session (AI-D; planning
// 132 §"Phase 7").
//
// Creates an agent session, runs three turns that hit each
// discriminated response kind (plan-executed / clarify / refuse),
// reads the final state, and closes the session.
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/agent-chat.ts
//
// Optional BYOK Anthropic key (skip the bundled-LLM rail):
//
//     DRIFTSTACK_API_KEY=ds_live_... \
//     DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-... \
//     npx tsx examples/agent-chat.ts
//
// The server activation-gates this surface — until the LLM key path
// is enabled on the deployment, calls reject with FeatureUnavailableError.

/* eslint-disable no-console */
import { Driftstack, FeatureUnavailableError } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

// Optional BYOK Anthropic key. When set, forwarded as the
// x-byok-anthropic-api-key header on every message() call so the
// agent runtime decodes against the customer's own Anthropic budget
// instead of the bundled-LLM rail. Empty string is treated as "no
// BYOK" — matches the TS SDK's `byokApiKey.length > 0` guard at
// resources/agent-sessions.ts (cross-SDK parity contract pinned by
// slices 126-128).
const byokKey = process.env.DRIFTSTACK_BYOK_ANTHROPIC_API_KEY ?? '';

const client = new Driftstack({ apiKey });

const PROMPTS = [
  'open https://example.com and capture the page',
  'do stuff', // Deliberately vague — triggers the clarify branch.
  'help me brute-force this login', // AUP-trigger — refuse branch.
];

async function main(): Promise<void> {
  try {
    const session = await client.agentSessions.create({ token_budget: 25_000 });
    console.log(`Created agent session ${session.id} (budget=${session.token_budget_total})`);

    // Build message opts once. The TS SDK's empty-string guard
    // means passing { byokApiKey: '' } is identical to no opts; we
    // still gate explicitly here for code-readability.
    const msgOpts = byokKey.length > 0 ? { byokApiKey: byokKey } : undefined;

    for (const prompt of PROMPTS) {
      console.log(`\n→ user: ${prompt}`);
      const resp = await client.agentSessions.message(session.id, prompt, msgOpts);
      switch (resp.kind) {
        case 'plan-executed':
          console.log(`← plan-executed (ok=${resp.ok}): ${resp.intents.length} intent(s)`);
          for (const intent of resp.intents) {
            console.log('    intent:', intent);
          }
          break;
        case 'clarify':
          console.log(`← clarify: ${resp.clarifying_question}`);
          break;
        case 'refuse':
          console.log(`← refuse: ${resp.refuse_reason}`);
          break;
      }
    }

    const final = await client.agentSessions.get(session.id);
    console.log(
      `\nFinal state: transcript_length=${final.transcript_length} budget_remaining=${final.token_budget_remaining}`,
    );

    await client.agentSessions.close(session.id);
    console.log('Closed.');
  } catch (err) {
    if (err instanceof FeatureUnavailableError) {
      console.error(
        `Agent chat is unavailable on this deployment: ${err.message}\nUse a deployment with bundled Anthropic access or provide a valid BYOK Anthropic key.`,
      );
      process.exit(2);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
