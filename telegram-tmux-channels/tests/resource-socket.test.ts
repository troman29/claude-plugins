import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';

import { readResourceCatalog } from '../src/resources/client';
import { resourceReply } from '../src/resources/dispatch';
import { inspectResources } from '../src/resources/service';

test('CLI socket client reads the same real configured catalog as hub dispatcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-socket-'));
  if (!resolve(root).startsWith(resolve(tmpdir()) + '/resource-socket-')) {
    throw new Error('Unexpected cleanup path');
  }
  const socketPath = join(root, 'hub.sock');
  const configPath = join(root, 'resources.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      projects: [
        { id: 'sites', root, adapter: 'sites', sites: [{ id: 'demo', name: 'Demo', url: 'https://example.com' }] },
      ],
    }),
  );
  const server = createServer((socket) => {
    let input = '';
    socket.on('data', async (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) {
        return;
      }
      const reply = await resourceReply(JSON.parse(input.split('\n')[0]), () => inspectResources(configPath));
      socket.end(JSON.stringify(reply) + '\n');
    });
  });
  try {
    await new Promise<void>((ready) => server.listen(socketPath, ready));
    const catalog = await readResourceCatalog(socketPath);
    expect(catalog.resources[0].name).toBe('Demo');
    expect(catalog.resources[0].endpoints[0].browserUrl).toBe('https://example.com/');
    expect(catalog.warnings).toEqual([]);
    expect((await resourceReply({ op: 'resources', id: 1, action: 'list', command: 'rm' })).ok).toBe(false);
  } finally {
    await new Promise<void>((closed, reject) => server.close((error) => (error ? reject(error) : closed())));
    await rm(root, { recursive: true });
  }
});
