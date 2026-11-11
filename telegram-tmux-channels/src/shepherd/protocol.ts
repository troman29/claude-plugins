// Контракт `pr-event` v1 (docs/shepherd.md). Валидация строгая: лишнее поле, неизвестный
// kind или длинная строка — отказ, событие в очередь не попадает.
import { z } from 'zod'

const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const SHA_RE = /^[0-9a-f]{7,64}$/i

const login = z.string().min(1).max(100)
const id = z.union([z.number().int().nonnegative(), z.string().min(1).max(40)])
const url = z.string().max(500).regex(/^https:\/\//)
const association = z.enum([
  'OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE',
])
const body = z.string().max(65_536)

const base = {
  repo: z.string().max(200).regex(REPO_RE),
  pr: z.number().int().positive().max(1_000_000_000),
  prUrl: url,
  prTitle: z.string().max(500),
  prAuthor: login,
  headRef: z.string().min(1).max(250),
  headSha: z.string().regex(SHA_RE),
  baseRef: z.string().min(1).max(250),
  actor: login,
  at: z.string().max(40).datetime({ offset: true }),
}

const plain = <K extends string>(kind: K) => z.object({ ...base, kind: z.literal(kind) }).strict()

const eventSchema = z.discriminatedUnion('kind', [
  plain('pr_opened'),
  plain('pr_reopened'),
  plain('pr_ready'),
  plain('pr_synchronize'),
  z.object({ ...base, kind: z.literal('pr_closed'), merged: z.boolean(), mergedBy: login.optional() }).strict(),
  z.object({
    ...base, kind: z.literal('checks_completed'),
    conclusion: z.string().min(1).max(40), suiteId: id, app: z.string().max(100),
  }).strict(),
  z.object({
    ...base, kind: z.literal('review'),
    state: z.enum(['approved', 'changes_requested', 'commented']), id, body, url, association,
  }).strict(),
  z.object({
    ...base, kind: z.literal('review_comment'),
    id, body, path: z.string().max(500), line: z.number().int().nonnegative().nullable().optional(), url, association,
  }).strict(),
  z.object({ ...base, kind: z.literal('comment'), id, body, url, association }).strict(),
])

const requestSchema = z.object({
  op: z.literal('pr-event'),
  v: z.literal(1),
  deliveryId: z.string().min(1).max(100),
  event: z.unknown(),
}).strict()

const unownedSchema = z.object({
  op: z.literal('pr-unowned'),
  v: z.literal(1),
  deliveryId: z.string().min(1).max(100),
}).strict()

export type ShepherdEvent = z.infer<typeof eventSchema>
export type EventKind = ShepherdEvent['kind']
export type ParsedRequest = { ok: true; deliveryId: string; event: ShepherdEvent } | { ok: false; error: string }

const MAX_ERROR_CHARS = 200

function describeIssue(issue: z.ZodIssue): string {
  return `invalid: ${issue.path.join('.') || '<root>'}: ${issue.message}`.slice(0, MAX_ERROR_CHARS)
}

export function parseRequest(raw: unknown): ParsedRequest {
  const request = requestSchema.safeParse(raw)
  if (!request.success) {
    return { ok: false, error: describeIssue(request.error.issues[0]!) }
  }
  const event = eventSchema.safeParse(request.data.event)
  if (!event.success) {
    const issue = event.error.issues[0]!
    return { ok: false, error: describeIssue({ ...issue, path: ['event', ...issue.path] }) }
  }
  return { ok: true, deliveryId: request.data.deliveryId, event: event.data }
}

/** `pr-unowned`: ни один хаб не ответил `mine` на событие с этим deliveryId. */
export function parseUnowned(raw: unknown): { ok: true; deliveryId: string } | { ok: false; error: string } {
  const request = unownedSchema.safeParse(raw)
  return request.success
    ? { ok: true, deliveryId: request.data.deliveryId }
    : { ok: false, error: describeIssue(request.error.issues[0]!) }
}

export function prKeyOf(event: { repo: string; pr: number }): string {
  return `${event.repo}#${event.pr}`
}

/** Ключ смысла: один и тот же факт GitHub может прийти под разными deliveryId.
 *  У CI ключа нет: новый suite на том же sha — новая информация, его склеивает наблюдатель роутера. */
export function semanticKey(event: ShepherdEvent): string | undefined {
  const pr = prKeyOf(event)
  switch (event.kind) {
    case 'review':
      return `${pr}:review:${event.id}`
    case 'review_comment':
      return `${pr}:review_comment:${event.id}`
    case 'comment':
      return `${pr}:comment:${event.id}`
    case 'pr_closed':
      return `${pr}:closed:${event.at}`
    default:
      return undefined
  }
}
