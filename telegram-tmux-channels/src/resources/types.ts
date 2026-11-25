import { z } from 'zod';

export const ResourceEndpoint = z.object({
  name: z.string(),
  browserUrl: z.string().url().optional(),
  internalUrl: z.string().url().optional(),
});
export type ResourceEndpoint = z.infer<typeof ResourceEndpoint>;

export const WorkspaceResource = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  kind: z.enum(['site', 'application', 'stand']),
  observation: z.enum(['configured', 'workspace-present', 'workspace-missing']),
  observedAt: z.string().datetime(),
  endpoints: z.array(ResourceEndpoint).max(20),
  capabilities: z.tuple([z.literal('inspect')]),
  workspacePath: z.string().optional(),
  branch: z.string().optional(),
});
export type WorkspaceResource = z.infer<typeof WorkspaceResource>;

export const ResourceCatalog = z.object({
  version: z.literal(1),
  resources: z.array(WorkspaceResource).max(20000),
  warnings: z
    .array(z.object({ projectId: z.string(), code: z.enum(['source-unavailable', 'invalid-source']) }))
    .max(100),
});
export type ResourceCatalog = z.infer<typeof ResourceCatalog>;

export const ResourceRequest = z
  .object({
    op: z.literal('resources'),
    id: z.number().int().safe(),
    action: z.literal('list'),
  })
  .strict();

export const ResourceReply = z.object({
  op: z.literal('result'),
  id: z.literal(1),
  ok: z.literal(true),
  result: z.string(),
});

export type { ResourceProject } from './config';
