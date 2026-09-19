// The bound for a body of 3-byte characters still upper-bounds its cost.
//
// ASSUMPTION (the provider's tokenizer — the one fact the bound rests on): the
// tokenizer works on the UTF-8 BYTES of the text, and every token stands for at
// least one byte. So a text of N UTF-8 bytes is at most N tokens in any language:
// a CJK character is 3 bytes and at most 3 tokens, an emoji 4 bytes and at most 4.
// The request's own framing adds at most REQUEST_FRAMING_TOKENS on top.
//
// That is why the bound counts BYTES and not characters. The conversation
// history is windowed by CHARACTERS today, and in a CJK conversation one
// character is three bytes: a bound taken from a character count is a third of
// the worst case. The arms below build real request bodies out of multi-byte
// text, bound them from their byte counts, and price the worst case the
// assumption allows — every byte of the text its own token, at its region's
// dearest rate — to show the bound still covers it. They also show the character
// count would not.

import { describe, expect, it } from 'vitest';
import {
  CREDIT_RATE_CARD_V1,
  REQUEST_FRAMING_TOKENS,
  callChargeMicro,
  callUpperBound,
  utf8ByteLength,
} from '../src/ai-credits.js';
import { seededRandom } from './_helpers/seeded-random.js';

const RATES = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
const MAX_TOKENS = 8_192;

/** A request body shaped like a plan call: a 1-hour system block, a 5-minute history, a plain tail. */
function planBody(system: string, history: string[], latest: string) {
  const systemPart = JSON.stringify([
    { type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);
  const historyPart = JSON.stringify(
    history.map((text, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [
        {
          type: 'text',
          text,
          ...(i === history.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
    })),
  );
  const tailPart = JSON.stringify({ role: 'user', content: latest });
  const envelope = `{"model":"claude-sonnet-5","max_tokens":${String(MAX_TOKENS)},"system":,"messages":[,]}`;
  return {
    regions: {
      oneHourRegionBytes: utf8ByteLength(systemPart),
      fiveMinuteRegionBytes: utf8ByteLength(historyPart),
      uncachedRegionBytes: utf8ByteLength(tailPart) + utf8ByteLength(envelope),
    },
    // The TEXT the tokenizer bills, region by region (JSON punctuation and keys
    // are counted in the regions above but are not text, which only loosens the bound).
    textBytes: {
      oneHour: utf8ByteLength(system),
      fiveMinute: history.reduce((n, t) => n + utf8ByteLength(t), 0),
      uncached: utf8ByteLength(latest),
    },
    textChars: system.length + history.reduce((n, t) => n + t.length, 0) + latest.length,
  };
}

/** The dearest the assumption allows: every text byte one token, at its region's dearest rate. */
function worstCaseCost(textBytes: { oneHour: number; fiveMinute: number; uncached: number }) {
  return callChargeMicro(
    {
      cacheWrite1h: textBytes.oneHour + REQUEST_FRAMING_TOKENS,
      cacheWrite5m: textBytes.fiveMinute,
      uncachedInput: textBytes.uncached,
      cacheRead: 0,
      output: MAX_TOKENS,
    },
    RATES,
  );
}

describe('the bound for a body of 3-byte characters still upper-bounds its cost', () => {
  it('byte length is UTF-8 length: 1, 2, 3 and 4 bytes per character, and a lone surrogate as the 3-byte replacement', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('漢')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect('😀'.length).toBe(2);
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('\udc00x')).toBe(4);
    expect(utf8ByteLength('')).toBe(0);
  });

  it('agrees with the platform UTF-8 encoder on generated text of every width', () => {
    const rnd = seededRandom(0x0b17_e5);
    const pools = [
      [0x20, 0x7e],
      [0x80, 0x7ff],
      [0x800, 0xd7ff],
      [0xe000, 0xffff],
      [0x10000, 0x10ffff],
      [0xd800, 0xdfff], // lone surrogates
    ] as const;
    for (let i = 0; i < 2_000; i += 1) {
      let text = '';
      const len = rnd.int(0, 60);
      for (let c = 0; c < len; c += 1) {
        const [lo, hi] = rnd.pick(pools);
        const cp = rnd.int(lo, hi);
        text += cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : String.fromCodePoint(cp);
      }
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, 'utf8'));
    }
  });

  it('a CJK conversation: the byte bound covers every text byte billed as a token', () => {
    const sentence = '請打開設定頁面並點擊儲存按鈕，然後確認變更已經生效。';
    expect(utf8ByteLength(sentence)).toBe(sentence.length * 3);
    const history = Array.from({ length: 40 }, (_, i) => `${sentence.repeat(20)}${String(i)}`);
    const body = planBody(
      'あなたはブラウザを操作するアシスタントです。'.repeat(50),
      history,
      sentence,
    );
    const bound = callUpperBound(body.regions, MAX_TOKENS, RATES);
    const worst = worstCaseCost(body.textBytes);
    expect(bound.boundMicro).toBeGreaterThanOrEqual(worst);
    expect(bound.inputBoundTokens).toBeGreaterThanOrEqual(
      body.textBytes.oneHour +
        body.textBytes.fiveMinute +
        body.textBytes.uncached +
        REQUEST_FRAMING_TOKENS,
    );
  });

  it('a bound taken from the CHARACTER count would fall below that same worst case', () => {
    const sentence = '請打開設定頁面並點擊儲存按鈕，然後確認變更已經生效。';
    const history = Array.from({ length: 40 }, () => sentence.repeat(20));
    const body = planBody('系統提示'.repeat(200), history, sentence);
    // The same shape of bound, fed characters instead of bytes, with every
    // character at the dearest input rate — still too low.
    const byChars = callUpperBound(
      { oneHourRegionBytes: body.textChars, fiveMinuteRegionBytes: 0, uncachedRegionBytes: 0 },
      MAX_TOKENS,
      RATES,
    );
    expect(byChars.boundMicro).toBeLessThan(worstCaseCost(body.textBytes));
    expect(callUpperBound(body.regions, MAX_TOKENS, RATES).boundMicro).toBeGreaterThanOrEqual(
      worstCaseCost(body.textBytes),
    );
  });

  it('emoji (4 bytes, 2 UTF-16 units) and mixed scripts are covered too, for generated conversations', () => {
    const rnd = seededRandom(0x0b17_e6);
    const alphabet = ['a', 'Z', ' ', 'é', 'ß', 'Ж', '漢', 'あ', '한', '😀', '🚀', '\n', '"', '\\'];
    for (let i = 0; i < 300; i += 1) {
      const text = (n: number) => Array.from({ length: n }, () => rnd.pick(alphabet)).join('');
      const history = Array.from({ length: rnd.int(1, 30) }, () => text(rnd.int(0, 2_000)));
      const body = planBody(text(rnd.int(0, 9_000)), history, text(rnd.int(0, 500)));
      const bound = callUpperBound(body.regions, MAX_TOKENS, RATES);
      expect(bound.boundMicro, `case ${String(i)}`).toBeGreaterThanOrEqual(
        worstCaseCost(body.textBytes),
      );
    }
  });
});
