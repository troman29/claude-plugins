import { createConnection } from 'node:net';

import { ResourceCatalog, ResourceReply } from './types';

const TIMEOUT_MS = 5000;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;

export function readResourceCatalog(socketPath: string): Promise<ResourceCatalog> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    function fail(error: Error) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    }

    function receive(received: Buffer | string) {
      if (settled) {
        return;
      }
      const chunk = Buffer.isBuffer(received) ? received : Buffer.from(received);
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES) {
        fail(new Error('Resource response exceeds limit'));
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) {
        return;
      }
      try {
        const catalog = parseReply(Buffer.concat(chunks).toString('utf8').split('\n')[0]);
        settled = true;
        socket.destroy();
        resolve(catalog);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid resource response'));
      }
    }

    socket.setTimeout(TIMEOUT_MS, () => fail(new Error('Resource service timed out')));
    socket.on('error', fail);
    socket.on('end', () => fail(new Error('Resource service closed before replying')));
    socket.on('connect', () => socket.write(JSON.stringify({ op: 'resources', id: 1, action: 'list' }) + '\n'));
    socket.on('data', receive);
  });
}

function parseReply(line: string): ResourceCatalog {
  const reply = ResourceReply.parse(JSON.parse(line));
  return ResourceCatalog.parse(JSON.parse(reply.result));
}
