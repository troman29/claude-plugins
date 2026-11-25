#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readResourceCatalog } from './client';

if (import.meta.main) {
  const catalog = await readResourceCatalog(join(homedir(), '.claude/channels/telegram/hub.sock'));
  process.stdout.write(`${JSON.stringify(catalog, undefined, 2)}\n`);
}
