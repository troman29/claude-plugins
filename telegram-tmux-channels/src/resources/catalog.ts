import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ResourceCatalog, ResourceProject, WorkspaceResource } from './types';

import { ConsoleStand, ConsoleState } from './console-state';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_RESOURCES = 200;

export async function resourceCatalog(projects: ResourceProject[]): Promise<ResourceCatalog> {
  const catalog: ResourceCatalog = { version: 1, resources: [], warnings: [] };
  for (const project of projects) {
    try {
      const resources = project.adapter === 'console-wt' ? await consoleResources(project) : siteResources(project);
      catalog.resources.push(...resources);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      catalog.warnings.push({
        projectId: project.id,
        code: missing ? 'source-unavailable' : 'invalid-source',
      });
    }
  }
  return catalog;
}

async function consoleResources(
  project: Extract<ResourceProject, { adapter: 'console-wt' }>,
): Promise<WorkspaceResource[]> {
  const state = ConsoleState.parse(await boundedJson(project.statePath));
  const root = resolve(project.root);
  const template = await externalTemplate(root);
  const resources: WorkspaceResource[] = [];
  for (const [slug, rawEntry] of Object.entries(state).slice(0, MAX_RESOURCES)) {
    const parsed = ConsoleStand.safeParse(rawEntry);
    if (!parsed.success) {
      continue;
    }
    const entry = parsed.data;
    if (!inside(root, entry.path)) {
      continue;
    }
    const internalUrl = safeHttpUrl(entry.url);
    const suffix = entry.slot === 0 ? '' : `-${entry.slot}`;
    const browserUrl = template ? safeBrowserUrl(template.replaceAll('{slot}', suffix)) : undefined;
    resources.push({
      id: resourceId(project.id, slug),
      name: slug,
      projectId: project.id,
      kind: 'stand',
      observation: (await pathExists(entry.path)) ? 'workspace-present' : 'workspace-missing',
      observedAt: new Date().toISOString(),
      endpoints: [{ name: 'web', internalUrl, browserUrl }],
      capabilities: ['inspect'],
      workspacePath: entry.path,
      branch: entry.branch,
    });
  }
  return resources;
}

function siteResources(project: Extract<ResourceProject, { adapter: 'sites' }>): WorkspaceResource[] {
  return project.sites.slice(0, MAX_RESOURCES).map((site) => {
    const browserUrl = safeBrowserUrl(site.url);
    if (!browserUrl) {
      throw new Error('Invalid site URL');
    }
    return {
      id: resourceId(project.id, site.id),
      name: site.name,
      projectId: project.id,
      kind: 'site',
      observation: 'configured',
      observedAt: new Date().toISOString(),
      endpoints: [{ name: 'web', browserUrl }],
      capabilities: ['inspect'],
    };
  });
}

export function safeBrowserUrl(input: unknown): string | undefined {
  const url = safeHttpUrl(input);
  if (!url) {
    return undefined;
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname.endsWith('.localhost') ||
    parsed.hostname.startsWith('127.') ||
    ['0.0.0.0', '[::1]', '[::]'].includes(parsed.hostname)
  ) {
    return undefined;
  }
  return url;
}

function safeHttpUrl(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return undefined;
  }
}

function resourceId(projectId: string, localId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([projectId, localId]))
    .digest('hex')
    .slice(0, 24);
}

function inside(root: string, path: string): boolean {
  const child = relative(root, resolve(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function boundedJson(path: string): Promise<unknown> {
  const text = await boundedText(path);
  return JSON.parse(text);
}

async function boundedText(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
      throw new Error('Source exceeds limit');
    }
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_SOURCE_BYTES) {
      throw new Error('Source exceeds limit');
    }
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function externalTemplate(root: string): Promise<string | undefined> {
  try {
    const text = await boundedText(resolve(root, '.env'));
    return text
      .split('\n')
      .find((line) => line.startsWith('EXTERNAL_STAND_URL_TEMPLATE='))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}
