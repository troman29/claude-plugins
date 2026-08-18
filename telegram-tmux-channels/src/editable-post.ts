export type EditableSeed = { msgId: number; turnEnded?: boolean }

export type EditableTransport = {
  send: (key: string, text: string) => Promise<number | undefined>
  edit: (key: string, msgId: number, text: string) => Promise<void>
}

/** Send once, then edit in place; recovered message ids make that contract survive restarts. */
export class EditablePost {
  private msg = new Map<string, number>()
  private turnEnded = new Map<string, boolean>()

  constructor(
    recovered: [string, EditableSeed][],
    private readonly persist: (key: string, msgId: number, turnEnded: boolean) => void,
    private readonly drop: (key: string) => void,
    private readonly transport: EditableTransport,
  ) {
    for (const [key, value] of recovered) {
      this.msg.set(key, value.msgId)
      this.turnEnded.set(key, value.turnEnded ?? false)
    }
  }

  endTurn(key: string): void {
    this.turnEnded.set(key, true)
    const msgId = this.msg.get(key)
    if (msgId != null && msgId > 0) this.persist(key, msgId, true)
  }

  sinceTurnEnd(key: string): boolean { return this.turnEnded.get(key) ?? true }

  forget(key: string): void {
    this.msg.delete(key)
    this.turnEnded.delete(key)
    this.drop(key)
  }

  async update(key: string, fresh: boolean, render: () => string): Promise<void> {
    if (fresh) {
      this.msg.delete(key)
      this.drop(key)
    }
    this.turnEnded.set(key, false)
    const existing = this.msg.get(key)
    if (existing === undefined) {
      this.msg.set(key, -1) // synchronous reservation against overlapping first updates
      const text = render()
      const msgId = await this.transport.send(key, text)
      if (msgId == null) {
        if (this.msg.get(key) === -1) this.msg.delete(key)
        return
      }
      this.msg.set(key, msgId)
      this.persist(key, msgId, false)
      const latest = render()
      if (latest !== text) await this.transport.edit(key, msgId, latest)
      return
    }
    if (existing === -1) return
    await this.transport.edit(key, existing, render())
    this.persist(key, existing, false)
  }
}
