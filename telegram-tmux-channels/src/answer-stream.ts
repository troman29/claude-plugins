export type AnswerStreamOwner = {
  key: string
  chatId: string
  threadId?: number
  bindingDir: string
  turnAt: number
}

export type AnswerStreamRecord = AnswerStreamOwner & {
  draftId: number
  text: string
  updatedAt: number
}

export type AnswerStreamDeps = {
  load: (key: string) => AnswerStreamRecord | undefined
  save: (value: AnswerStreamRecord) => void
  clear: (key: string) => void
  publishDraft: (value: AnswerStreamRecord) => Promise<void>
  now?: () => number
  nextDraftId?: () => number
}

// One serialized lane per binding. Draft updates and the persistent final message can therefore
// never overtake each other, including when a transcript poll races an explicit reply tool call.
export class AnswerStream {
  private lanes = new Map<string, Promise<unknown>>()
  private closed = new Set<string>()

  constructor(private readonly deps: AnswerStreamDeps) {}

  has(key: string): boolean { return !this.closed.has(key) && (!!this.deps.load(key) || this.lanes.has(key)) }

  begin(key: string): void {
    this.closed.delete(key)
    this.deps.clear(key)
  }

  update(owner: AnswerStreamOwner, text: string): Promise<void> {
    if (!text.trim() || this.closed.has(owner.key)) return Promise.resolve()
    return this.enqueue(owner.key, async () => {
      let record = this.deps.load(owner.key)
      if (!record || record.bindingDir !== owner.bindingDir || record.turnAt !== owner.turnAt || record.chatId !== owner.chatId || record.threadId !== owner.threadId) {
        if (record) this.deps.clear(owner.key)
        record = {
          ...owner,
          draftId: this.deps.nextDraftId?.() ?? Math.floor(Math.random() * 2_147_483_646) + 1,
          text: '', updatedAt: this.deps.now?.() ?? Date.now(),
        }
      }
      if (record.text === text) return
      const next = { ...record, text, updatedAt: this.deps.now?.() ?? Date.now() }
      // Persist before I/O: after a crash, the same draft id is resumed rather than duplicated.
      this.deps.save(next)
      await this.deps.publishDraft(next)
    })
  }

  finalize(key: string, sendFinal: () => Promise<unknown>): Promise<boolean> {
    if (this.closed.has(key) || (!this.deps.load(key) && !this.lanes.has(key))) return Promise.resolve(false)
    this.closed.add(key)
    return this.enqueue(key, async () => {
      await sendFinal()
      this.deps.clear(key)
      return true
    }).then(Boolean, error => {
      this.closed.delete(key) // a failed send remains retryable and recoverable
      throw error
    })
  }

  discard(key: string): void {
    this.closed.add(key)
    this.deps.clear(key)
  }

  private enqueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    this.lanes.set(key, current)
    void current.finally(() => { if (this.lanes.get(key) === current) this.lanes.delete(key) }).catch(() => {})
    return current
  }
}
