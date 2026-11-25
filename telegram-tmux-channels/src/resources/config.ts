import { isAbsolute } from 'node:path';
import { z } from 'zod';

const MAX_PROJECTS = 100;
const MAX_SITES = 200;
const ResourceId = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const AbsolutePath = z.string().refine(isAbsolute, 'Expected an absolute path');
const ProjectIdentity = z.object({ id: ResourceId, root: AbsolutePath });
const Site = z.object({ id: z.string(), name: z.string(), url: z.string() });

export const ResourceProject = z.discriminatedUnion('adapter', [
  ProjectIdentity.extend({
    adapter: z.literal('console-wt'),
    statePath: AbsolutePath,
  }),
  ProjectIdentity.extend({
    adapter: z.literal('sites'),
    sites: z.array(Site).max(MAX_SITES),
  }),
]);
export type ResourceProject = z.infer<typeof ResourceProject>;

export const ResourceConfig = z
  .object({
    version: z.literal(1),
    projects: z.array(ResourceProject).max(MAX_PROJECTS),
  })
  .superRefine(({ projects }, context) => {
    const ids = new Set<string>();
    projects.forEach((project, index) => {
      if (ids.has(project.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', index, 'id'],
          message: 'Duplicate project ID',
        });
      }
      ids.add(project.id);
    });
  });
export type ResourceConfig = z.infer<typeof ResourceConfig>;
