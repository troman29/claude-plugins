import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resourceCatalog } from './catalog';
import { ResourceConfig } from './config';

const CONFIG_LIMIT = 256 * 1024;
const DEFAULT_CONFIG = join(homedir(), '.config/agent-workspace/resources.json');

export async function inspectResources(configPath = DEFAULT_CONFIG) {
  const file = await open(configPath, 'r');
  let config: unknown;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > CONFIG_LIMIT) {
      throw new Error('Invalid resource configuration');
    }
    const bytes = Buffer.alloc(CONFIG_LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > CONFIG_LIMIT) {
      throw new Error('Invalid resource configuration');
    }
    config = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
  const parsed = ResourceConfig.parse(config);
  return resourceCatalog(parsed.projects);
}
