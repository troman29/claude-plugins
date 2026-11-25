import { ResourceRequest } from './types';

import { inspectResources } from './service';

export async function resourceReply(request: unknown, inspect = inspectResources) {
  const parsed = ResourceRequest.safeParse(request);

  if (!parsed.success) {
    return { op: 'result' as const, id: 0, ok: false, error: 'Resource request rejected' };
  }

  return {
    op: 'result' as const,
    id: parsed.data.id,
    ok: true,
    result: JSON.stringify(await inspect()),
  };
}
