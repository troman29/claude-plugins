import { z } from 'zod';

export const ConsoleState = z.record(z.unknown());

export const ConsoleStand = z.object({
  path: z.string(),
  slot: z.number().int().nonnegative().safe(),
  url: z.string().optional(),
  branch: z.string().optional(),
});
