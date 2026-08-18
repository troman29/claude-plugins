import { z } from 'zod'
import type { TrustedGroupConfig } from './trusted-groups'

const messageRef = z.object({
  chatId: z.string().min(1),
  threadId: z.number().int().optional(),
  msgId: z.number().int().positive(),
})

const statusState = z.object({
  agents: z.array(z.tuple([z.string(), z.object({ name: z.string(), done: z.boolean() })])),
  tasks: z.array(z.tuple([z.string(), z.object({ subject: z.string(), status: z.string() })])),
  todos: z.array(z.object({ content: z.string(), status: z.string() })),
  skills: z.array(z.object({ skill: z.string(), args: z.string().optional() })),
})
const trustedGroupConfig = z.custom<TrustedGroupConfig>(value => {
  if (!value || typeof value !== 'object') return false
  const cfg = value as { modes?: unknown }
  return Array.isArray(cfg.modes) && cfg.modes.every(mode => mode === 'folder' || mode === 'worktree')
})

const envelope = <K extends string, S extends z.ZodTypeAny>(kind: K, data: S) => z.object({
  kind: z.literal(kind),
  key: z.string().min(1),
  updatedAt: z.number().finite(),
  expiresAt: z.number().finite().optional(),
  data,
})

const schemas = {
  status: envelope('status', messageRef.extend({ bindingDir: z.string().min(1), turnEnded: z.boolean(), state: statusState })),
  background: envelope('background', messageRef.extend({ bindingDir: z.string().min(1), tasks: z.array(z.object({
    command: z.string(), description: z.string().optional(), done: z.boolean().optional(),
  })) })),
  'skill-menu': envelope('skill-menu', z.object({
    bindingKey: z.string().min(1), dir: z.string().min(1), names: z.array(z.string().min(1)).max(100),
  })),
  'custom-answer': envelope('custom-answer', z.object({
    chatId: z.string().min(1), threadId: z.number().int().optional(), bindingKey: z.string().min(1), at: z.number().finite(), multi: z.boolean(),
  })),
  'live-screen': envelope('live-screen', messageRef.extend({
    pane: z.string().min(1), bindingKey: z.string().min(1), lastText: z.string(), viewKind: z.enum(['png', 'text']), refreshUntil: z.number().finite(),
  })),
  compaction: envelope('compaction', messageRef.extend({ bindingKey: z.string().min(1), lastPct: z.number(), misses: z.number().int().nonnegative() })),
  workflow: envelope('workflow', messageRef.extend({
    bindingKey: z.string().min(1), last: z.string(), name: z.string(), total: z.number().int().nonnegative(), misses: z.number().int().nonnegative(),
  })),
  'hook-compaction': envelope('hook-compaction', messageRef.extend({ bindingDir: z.string().min(1) })),
  'answer-stream': envelope('answer-stream', z.object({
    chatId: z.string().min(1), threadId: z.number().int().optional(), bindingDir: z.string().min(1),
    turnAt: z.number().finite(), draftId: z.number().int().positive(), text: z.string(), updatedAt: z.number().finite(),
  })),
  'pending-topic': envelope('pending-topic', z.object({
    cfg: trustedGroupConfig, mode: z.enum(['folder', 'worktree', 'worktree-plain']), topicName: z.string(),
    chatId: z.string().min(1), threadId: z.number().int(), base: z.string().optional(), agent: z.enum(['claude', 'codex']).optional(),
  })),
} as const

export type InteractionKind = keyof typeof schemas
type Parsed<K extends InteractionKind> = z.infer<(typeof schemas)[K]>
export type PersistedInteraction = { [K in InteractionKind]: Parsed<K> }[InteractionKind]
export type InteractionData<K extends InteractionKind> = Parsed<K>['data']

export const interactionKey = (kind: InteractionKind, key: string): string => `${kind}\u0000${key}`

/**
 * Typed, TTL-aware persistence boundary for Telegram UI state.
 * Invalid JSON never reaches feature code; a record can only be read through its own kind/key.
 */
export class InteractionRegistry {
  private records: Record<string, PersistedInteraction> = {}

  constructor(
    raw: Record<string, unknown>,
    private readonly save: (snapshot: Record<string, PersistedInteraction>) => void,
    private readonly now = Date.now(),
  ) {
    for (const value of Object.values(raw)) {
      if (!value || typeof value !== 'object') continue
      const kind = (value as { kind?: unknown }).kind
      if (typeof kind !== 'string' || !(kind in schemas)) continue
      const parsed = schemas[kind as InteractionKind].safeParse(value)
      if (!parsed.success) continue
      const record = parsed.data as PersistedInteraction
      if (record.expiresAt != null && record.expiresAt <= now) continue
      this.records[interactionKey(record.kind, record.key)] = record
    }
  }

  get<K extends InteractionKind>(kind: K, key: string): InteractionData<K> | undefined {
    return this.records[interactionKey(kind, key)]?.data as InteractionData<K> | undefined
  }

  record<K extends InteractionKind>(kind: K, key: string): Parsed<K> | undefined {
    return this.records[interactionKey(kind, key)] as Parsed<K> | undefined
  }

  entries<K extends InteractionKind>(kind?: K): [string, InteractionData<K>][] {
    return Object.values(this.records)
      .filter(record => kind == null || record.kind === kind)
      .map(record => [record.key, record.data as InteractionData<K>])
  }

  set<K extends InteractionKind>(record: Parsed<K>): void {
    const parsed = schemas[record.kind].parse(record) as PersistedInteraction
    this.records[interactionKey(parsed.kind, parsed.key)] = parsed
    this.commit()
  }

  delete(kind: InteractionKind, key: string): void {
    if (delete this.records[interactionKey(kind, key)]) this.commit()
  }

  /** Remove every callback/edit target owned by a binding before that binding can be reused. */
  deleteBinding(bindingKey: string): void {
    let changed = false
    for (const [storageKey, record] of Object.entries(this.records)) {
      const nested = record.data as { bindingKey?: unknown }
      const keyOwned = (record.kind === 'status' || record.kind === 'background' ||
        record.kind === 'hook-compaction' || record.kind === 'answer-stream' || record.kind === 'pending-topic') && record.key === bindingKey
      if (keyOwned || nested.bindingKey === bindingKey) {
        delete this.records[storageKey]
        changed = true
      }
    }
    if (changed) this.commit()
  }

  private commit(): void {
    this.save({ ...this.records })
  }
}
