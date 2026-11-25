import { expect, test } from 'bun:test';

import { ResourceConfig } from '../src/resources/config';

const consoleProject = { id: 'console', root: '/project', adapter: 'console-wt', statePath: '/state.json' };

for (const [scenario, projects] of [
  ['duplicate project IDs', [consoleProject, consoleProject]],
  ['relative project root', [{ ...consoleProject, root: 'relative' }]],
  ['missing Console state path', [{ id: 'console', root: '/project', adapter: 'console-wt' }]],
  ['missing site collection', [{ id: 'sites', root: '/project', adapter: 'sites' }]],
  ['unknown adapter', [{ ...consoleProject, adapter: 'shell' }]],
] as const) {
  test(`configuration rejects ${scenario}`, () => {
    expect(ResourceConfig.safeParse({ version: 1, projects }).success).toBe(false);
  });
}

test('duplicate project diagnostic identifies the conflicting field', () => {
  const parsed = ResourceConfig.safeParse({ version: 1, projects: [consoleProject, consoleProject] });
  if (parsed.success) {
    throw new Error('Expected duplicate project rejection');
  }
  expect(parsed.error.issues[0].path).toEqual(['projects', 1, 'id']);
});
