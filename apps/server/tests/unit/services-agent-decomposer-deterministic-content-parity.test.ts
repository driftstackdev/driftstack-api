// Drift guard for apps/server/src/services/agent-decomposer-deterministic.ts.
// Pins the AI-B1 deterministic AgentDecomposer impl — keyword-heuristic
// AUP refusal corpus + ambiguity detector + budget-vs-tokens-consumed
// short-circuit + URL→navigate intent synthesis.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-decomposer-deterministic.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-decomposer-deterministic content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-B1 module-level framing pinned: 'deterministic AgentDecomposer implementation.' — pinned so the AI-B1 anchor stays explicit (AI-B1.b is the Claude-wired follow-up that replaces the heuristic guts)", () => {
    expect(body).toMatch(/\/\/ AI-B1 — deterministic AgentDecomposer implementation\./);
  });

  it("3-reason 'why deterministic before Claude wire' framing pinned: 1. interface-contract invariants (token-budget = refuse / AUP = refuse / only upstream-5xx + cred-decryption escape as exceptions) 2. dashboard chat-UI can wire immediately (BYOK-vs-bundled Tier-3 verdict still pending) 3. executor (B2) tests need predictable intents without mocking the Anthropic SDK. — pinned so the 3-reason justification + invariant-locking purpose + dashboard-unblock + test-fixture role all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Why deterministic before the Anthropic Claude wire \(AI-B1\.b\):\s*\/\/ {3}1\. The AgentDecomposer interface contract has subtle invariants\s*\/\/ {6}\(token-budget exhaustion = refuse, NOT throw; AUP violations =\s*\/\/ {6}refuse, NOT throw; only upstream 5xx \/ credential decryption\s*\/\/ {6}errors escape as exceptions\)\. Locking the contract via a fully\s*\/\/ {6}tested deterministic impl prevents the LLM-wired version from\s*\/\/ {6}drifting on these edge cases\./,
    );
    expect(body).toMatch(
      /\/\/ {3}2\. Dashboard chat-UI work can wire against this immediately —\s*\/\/ {6}consumers don't have to wait on Anthropic key path decisions\s*\/\/ {6}\(BYOK vs bundled is itself a Tier-3 founder question still\s*\/\/ {6}pending\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}3\. Tests of the executor \(B2 follow-up slice\) need a decomposer\s*\/\/ {6}that returns predictable intents; a deterministic impl gives\s*\/\/ {6}that without mocking the entire Anthropic SDK\./,
    );
  });

  it("'NOT meant to be the product' framing pinned: 'simple keyword heuristics — NOT meant to be the product. AI-B1.b replaces the heuristic guts with a real Claude Opus 4.7 call against the documented prompt template; the interface surface stays identical.' — pinned so the keyword-heuristics-not-product + AI-B1.b-replaces-the-guts + interface-surface-stays-identical contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ This impl uses simple keyword heuristics — NOT meant to be the\s*\/\/ product\. AI-B1\.b replaces the heuristic guts with a real Claude\s*\/\/ Opus 4\.7 call against the documented prompt template; the interface\s*\/\/ surface stays identical\./,
    );
  });

  it('AUP_REFUSAL_PATTERNS 5-pattern corpus pinned: CSAM + non-consensual-deepfake + swatting + captcha-bypass/rate-limit-evade/account-ban-evade/moderation-evade + brute-force/credential-stuff/password-spray. Drift to dropping a pattern would let v1.0 launch with abuse-category gaps; drift to softening would invite refusal-corpus-test failures', () => {
    expect(body).toMatch(/AUP_REFUSAL_PATTERNS: ReadonlyArray</);
    expect(body).toMatch(
      /pattern: \/\\b\(child sexual abuse material\|csam\|child pornography\)\\b\/i,/,
    );
    expect(body).toMatch(
      /pattern: \/\\b\(create\|generate\|make\)\.\{0,30\}\(deepfake\|synthetic media of a real person\)\\b\/i,/,
    );
    expect(body).toMatch(/pattern: \/\\b\(swat\|swatting\|fake \.\{0,15\}emergency call\)\\b\/i,/);
    expect(body).toMatch(
      /pattern: \/\\b\(bypass\|circumvent\|evade\)\.\{0,30\}\(captcha\|rate limit\|account ban\|moderation\)\\b\/i,/,
    );
    expect(body).toMatch(
      /pattern: \/\\b\(brute\.\?force\|credential\.\?stuff\|password spray\)\\b\/i,/,
    );
  });

  it('AUP-refusal reason strings pinned — these are the customer-facing copy that ships in the refuse-discriminant body. Drift would let off-brand or legally-risky reason text reach customers', () => {
    expect(body).toMatch(/'This task involves content categorically prohibited by our AUP\.',/);
    expect(body).toMatch(
      /'Creating non-consensual synthetic media of real people is prohibited\.',/,
    );
    expect(body).toMatch(/'Tasks that endanger people in the physical world are prohibited\.',/);
    expect(body).toMatch(
      /'Driftstack does not orchestrate captcha bypass or evasion of platform safety controls\. ' \+\s*'See https:\/\/driftstack\.dev\/legal\/aup\/',/,
    );
    expect(body).toMatch(/'Credential-attack tasks are prohibited by our AUP\.',/);
  });

  it('detectAmbiguity 3-rule framing pinned: empty-task → "I need a task description…" + length<12 → "very short — can you describe…" + do/something/stuff/try without verb-vocabulary → "Can you tell me what action you want…". Drift would let underspecified tasks flow through to plan synthesis + invite hallucinated intents', () => {
    expect(body).toMatch(/function detectAmbiguity\(task: string\): string \| null \{/);
    expect(body).toMatch(
      /if \(trimmed\.length === 0\) \{\s*return 'I need a task description to plan\. What would you like me to do\?';\s*\}/,
    );
    expect(body).toMatch(
      /if \(trimmed\.length < 12\) \{\s*return `"\$\{trimmed\}" is very short — can you describe what you want me to do in a sentence\?`;\s*\}/,
    );
    expect(body).toMatch(
      /if \(\s*\/\^\(do\|something\|stuff\|try\)\\b\/i\.test\(trimmed\) &&\s*!\/\(open\|visit\|go to\|click\|tap\|type\|fill\|search\|extract\|capture\)\/i\.test\(trimmed\)\s*\) \{/,
    );
  });

  it('estimateTokens char-by-4 heuristic + 600-token system-prompt overhead pinned: taskTokens + historyTokens + 600. Drift to dropping the 600 overhead would undercount the actual prompt cost when the AI-B1.b LLM wire lands + lets customers exhaust their tier budget on smaller-looking tasks than they were charged for', () => {
    expect(body).toMatch(
      /function estimateTokens\(task: string, history: readonly \{ body: string \}\[\]\): number \{\s*const taskTokens = Math\.ceil\(task\.length \/ 4\);\s*const historyTokens = history\.reduce\(\(acc, h\) => acc \+ Math\.ceil\(h\.body\.length \/ 4\), 0\);/,
    );
    expect(body).toMatch(
      /\/\/ System-prompt overhead \(intent vocabulary, formatting rules\) is\s*\/\/ ~600 tokens against the AI-B1\.b prompt template; charge it\.\s*return 600 \+ taskTokens \+ historyTokens;/,
    );
  });

  it("synthesizePlan URL-extraction framing pinned: match https?:// then strip a SINGLE trailing punctuation char + cap at 3 URLs + 'Match greedily then strip a SINGLE trailing punctuation char that's almost always grammatical rather than part of the URL. We don't strip all trailing punctuation because .example has a meaningful dot — only the very last char is suspect.' — pinned so the single-char-strip rationale (vs. greedy strip) + the .example-meaningful-dot edge case all stay documented", () => {
    expect(body).toMatch(/const rawMatches = task\.match\(\/https\?:\\\/\\\/\[\^\\s\)\]\+\/g\);/);
    expect(body).toMatch(
      /const urlMatches = rawMatches\?\.map\(\(u\) => u\.replace\(\/\[,\.;:!\?\]\+\$\/, ''\)\);/,
    );
    expect(body).toMatch(/for \(const url of urlMatches\.slice\(0, 3\)\) \{/);
    expect(body).toMatch(
      /\/\/ Match greedily then strip a SINGLE trailing punctuation char that's\s*\/\/ almost always grammatical rather than part of the URL\. We don't\s*\/\/ strip all trailing punctuation because `\.example` has a meaningful\s*\/\/ dot — only the very last char is suspect\./,
    );
  });

  it("No-URL fallback to https://duckduckgo.com/ + 3-intent pinned plan: navigate + wait(idle) + capture(dom_snapshot). Drift to a different fallback URL would diverge from the deterministic-test fixture expectations; drift to a different intent sequence would break the executor's stub-success run-result test fixtures", () => {
    expect(body).toMatch(
      /\/\/ No URL — assume the user wants a generic web search via the\s*\/\/ archetype's default search engine\. AI-B1\.b's LLM will pick a\s*\/\/ real start URL based on task semantics\./,
    );
    expect(body).toMatch(
      /intents\.push\(\{ kind: 'navigate', url: 'https:\/\/duckduckgo\.com\/' \}\);/,
    );
    expect(body).toMatch(/intents\.push\(\{ kind: 'wait', condition: 'idle' \}\);/);
    expect(body).toMatch(/intents\.push\(\{ kind: 'capture', capture: 'dom_snapshot' \}\);/);
  });

  it("v2-#4 Q.1.e DETERMINISTIC_USAGE constant pinned: { decomposerKind: 'deterministic' as const }. + 'uniform usage block so AgentRuntime records a row for deterministic turns too. Zero anthropic tokens + zero cost; the audit trail just shows we ran a deterministic plan.' framing — pinned so the AgentRuntime-records-usage-for-deterministic contract + zero-cost-but-tracked rationale stay documented", () => {
    expect(body).toMatch(
      /\/\/ v2-#4 Q\.1\.e — uniform usage block so AgentRuntime records a row for\s*\/\/ deterministic turns too\. Zero anthropic tokens \+ zero cost; the\s*\/\/ audit trail just shows "we ran a deterministic plan"\./,
    );
    expect(body).toMatch(
      /const DETERMINISTIC_USAGE = \{ decomposerKind: 'deterministic' as const \};/,
    );
  });

  it("decompose() 4-branch dispatch pinned: 1. budget-exhausted → refuse w/ 'token budget exhausted; start a new session' + tokensConsumed=0 2. AUP → refuse w/ pattern-matched reason 3. ambiguous → clarify 4. default → plan w/ synthesizePlan. Drift to re-ordering would let AUP-violating-but-budget-exhausted requests refuse on the wrong reason (the budget-vs-AUP order is significant — exhausted budget is a system-state refuse; AUP is a customer-content refuse). Drift to dropping tokensConsumed=0 on budget-exhausted would force the runtime to debit tokens for a refused turn", () => {
    expect(body).toMatch(
      /if \(args\.budgetTokensRemaining < tokensConsumed\) \{\s*return Promise\.resolve\(\{\s*kind: 'refuse',\s*refuseReason: 'token budget exhausted; start a new session',\s*tokensConsumed: 0,\s*usage: DETERMINISTIC_USAGE,\s*\}\);\s*\}/,
    );
    expect(body).toMatch(/const aupRefusal = checkAupRefusal\(args\.task\);/);
    expect(body).toMatch(/const ambiguity = detectAmbiguity\(args\.task\);/);
    expect(body).toMatch(
      /return Promise\.resolve\(\{\s*kind: 'plan',\s*intents: synthesizePlan\(args\.task\),\s*tokensConsumed,\s*usage: DETERMINISTIC_USAGE,\s*\}\);/,
    );
  });
});
