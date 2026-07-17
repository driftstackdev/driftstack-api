import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const PAGE = resolve(import.meta.dirname, '../../../docs/src/pages/api/archetypes.md');
const page = readFileSync(PAGE, 'utf8');
const block = page.match(
  /## Generate a create payload from the live catalog[\s\S]*?```ts\n([\s\S]*?)\n```/,
)?.[1];

if (block === undefined) throw new Error('archetype generator TypeScript block is missing');

const exampleAt = block.indexOf('\nconst sessionBody =');
if (exampleAt < 0) throw new Error('archetype generator example boundary is missing');

const executableSource = ts.transpileModule(block.slice(0, exampleAt), {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText;

type ArchetypeFilter = {
  id?: string;
  device?: string;
  ios_version?: string;
  safari_version?: string;
};

type Generator = (filter?: ArchetypeFilter) => Promise<Record<string, string>>;

const row = (id: string, safariVersion: string) => ({
  id,
  device: 'iPhone 17',
  ios_version: '18.7',
  safari_version: safariVersion,
});

const catalogFetch = (data: ReturnType<typeof row>[]) =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ default_archetype_id: data[0]?.id ?? '', data }),
    }),
  );

const makeGenerator = (fetch: ReturnType<typeof catalogFetch>): Generator =>
  runInNewContext(`${executableSource}\narchetypeCreatePayload;`, { fetch }) as Generator;

describe('documented archetype create-payload generator', () => {
  it('omits archetype without fetching when the caller wants the server default', async () => {
    const fetch = catalogFetch([row('default', '26.4')]);

    await expect(makeGenerator(fetch)()).resolves.toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the sole exact live-catalog match', async () => {
    const fetch = catalogFetch([
      row('iphone17_ios18_7_safari26_3', '26.3'),
      row('iphone17_ios18_7_safari26_4', '26.4'),
    ]);
    await expect(
      makeGenerator(fetch)({
        device: 'iPhone 17',
        ios_version: '18.7',
        safari_version: '26.4',
      }),
    ).resolves.toEqual({ archetype: 'iphone17_ios18_7_safari26_4' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed for zero or multiple matches instead of using registry order', async () => {
    const noMatchFetch = catalogFetch([row('only', '26.4')]);
    await expect(makeGenerator(noMatchFetch)({ device: 'iPhone 16' })).rejects.toThrow(
      'No currently selectable archetype matches',
    );

    const ambiguousFetch = catalogFetch([
      row('iphone17_ios18_7_safari26_3', '26.3'),
      row('iphone17_ios18_7_safari26_4', '26.4'),
    ]);
    await expect(
      makeGenerator(ambiguousFetch)({ device: 'iPhone 17', ios_version: '18.7' }),
    ).rejects.toThrow('More than one archetype matches');
  });
});
