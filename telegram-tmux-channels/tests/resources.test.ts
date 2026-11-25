import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';

import { resourceCatalog, safeBrowserUrl } from '../src/resources/catalog';

for (const url of [
  'http://example.com',
  'https://localhost',
  'https://127.0.0.1',
  'https://user:secret@example.com',
  'javascript:alert(1)',
]) {
  test(`browser URL rejects inaccessible or unsafe target: ${url}`, () => {
    expect(safeBrowserUrl(url)).toBeUndefined();
  });
}

test('Console adapter keeps browser addresses separate and never claims runtime health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-catalog-'));
  if (!resolve(root).startsWith(resolve(tmpdir()) + '/resource-catalog-')) {
    throw new Error('Unexpected cleanup path');
  }
  try {
    const worktree = join(root, '.claude/worktrees/topic');
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(root, '.env'),
      'SECRET=must-not-appear\nEXTERNAL_STAND_URL_TEMPLATE=https://console{slot}.example.com\n',
    );
    const statePath = join(root, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        topic: { path: worktree, slot: 2, url: 'http://localhost:5182' },
        foreign: { path: '/outside/project', slot: 3 },
      }),
    );
    const catalog = await resourceCatalog([{ id: 'console', root, adapter: 'console-wt', statePath }]);
    expect(catalog.resources).toHaveLength(1);
    expect(catalog.resources[0].observation).toBe('workspace-present');
    expect(catalog.resources[0].endpoints[0].browserUrl).toBe('https://console-2.example.com/');
    expect(JSON.stringify(catalog)).not.toContain('must-not-appear');
    expect(catalog.resources[0].capabilities).toEqual(['inspect']);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('one invalid adapter does not hide configured sites', async () => {
  const catalog = await resourceCatalog([
    { id: 'missing', root: '/missing', adapter: 'console-wt', statePath: '/missing/state.json' },
    {
      id: 'sites',
      root: '/project',
      adapter: 'sites',
      sites: [{ id: 'docs', name: 'Docs', url: 'https://example.com' }],
    },
  ]);
  expect(catalog.warnings).toEqual([{ projectId: 'missing', code: 'source-unavailable' }]);
  expect(catalog.resources).toHaveLength(1);
});
