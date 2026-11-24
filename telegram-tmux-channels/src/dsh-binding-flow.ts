import { randomBytes, randomUUID } from 'node:crypto'
import type { DshRuntimes, DshSession, DshRuntime } from './dsh-runtimes'
import type { BindingEntry } from './registry'
import type { DshClaim } from './native-dsh'

type Registry = Record<string, BindingEntry>
type Choice = { runtime: DshRuntime; sessionId?: string }
type TopicStorage = Pick<BindingEntry, 'mode' | 'hookBranch'>
type Menu = { key: string; dir: string; choices: Choice[]; previous: string | undefined; storage: TopicStorage }
const MENU_LIFETIME_MS = 10 * 60_000
const MAX_SESSIONS = 30

export class DshBindingFlow<C> {
  private menus = new Map<string, Menu>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private busy = new Set<string>()

  constructor(private options: {
    runtimes: DshRuntimes<C>
    load: () => Registry
    save: (registry: Registry) => void
  }) {}

  async menu(key: string, dir: string, storage: TopicStorage = {}): Promise<{ token: string; labels: string[] }> {
    const runtimes = this.options.runtimes.list()
    if (runtimes.length === 0) {
      throw new Error('No DSH runtime is connected. Enable the Telegram plugin in DSH.')
    }
    const choices: Choice[] = []
    const labels: string[] = []
    for (const runtime of runtimes) {
      choices.push({ runtime })
      labels.push(`＋ ${runtime.label}: new session`)
      const sessions: unknown = JSON.parse(await this.options.runtimes.request(runtime.runtime, { action: 'list', cwd: dir }))
      if (!Array.isArray(sessions)) {
        throw new Error('Invalid DSH session list')
      }
      for (const value of sessions.slice(0, MAX_SESSIONS)) {
        const session = value as DshSession
        if (typeof session?.sessionId !== 'string' || session.cwd !== dir || typeof session.title !== 'string') {
          throw new Error('Invalid DSH session')
        }
        if (this.owner(runtime, session.sessionId, key)) {
          continue
        }
        choices.push({ runtime, sessionId: session.sessionId })
        labels.push(`${runtime.label}: ${session.title.slice(0, 48)}`)
      }
    }
    const token = randomBytes(8).toString('hex')
    this.menus.set(token, { key, dir, choices, previous: JSON.stringify(this.options.load()[key]), storage })
    const timer = setTimeout(() => {
      this.menus.delete(token)
      this.timers.delete(token)
    }, MENU_LIFETIME_MS)
    timer.unref?.()
    this.timers.set(token, timer)
    return { token, labels }
  }

  pending(key: string): boolean {
    return this.busy.has(key) || [...this.menus.values()].some(menu => menu.key === key)
  }

  target(token: string): string | undefined {
    return this.menus.get(token)?.key
  }

  async select(token: string, index: number): Promise<DshClaim> {
    const menu = this.menus.get(token)
    const choice = menu?.choices[index]
    if (!menu || !choice) {
      throw new Error('This DSH menu has expired. Run /bind again.')
    }
    if (this.busy.has(menu.key)) {
      throw new Error('A DSH binding operation is already running')
    }
    const existingBeforeSelection = this.options.load()[menu.key]
    if (JSON.stringify(existingBeforeSelection) !== menu.previous) {
      throw new Error('The topic binding changed. Run /bind again.')
    }
    if (existingBeforeSelection && !existingBeforeSelection.dsh) {
      throw new Error('Unbind the existing CLI session before switching to DSH')
    }
    this.busy.add(menu.key)
    // Consume before any request: a timeout must not create a second session on another click.
    this.menus.delete(token)
    clearTimeout(this.timers.get(token))
    this.timers.delete(token)
    try {
      let sessionId = choice.sessionId
      if (!sessionId) {
        const requestedId = randomUUID()
        const created = JSON.parse(await this.options.runtimes.request(choice.runtime.runtime,
          { action: 'create', cwd: menu.dir, sessionId: requestedId })) as { sessionId?: string }
        if (created.sessionId !== requestedId) {
          throw new Error('DSH did not confirm the requested new session')
        }
        sessionId = requestedId
      } else {
        const sessions = JSON.parse(await this.options.runtimes.request(choice.runtime.runtime,
          { action: 'list', cwd: menu.dir })) as DshSession[]
        if (!sessions.some(session => session.sessionId === sessionId && session.cwd === menu.dir)) {
          throw new Error('The selected DSH session is no longer available')
        }
      }
      if (this.owner(choice.runtime, sessionId, menu.key)) {
        throw new Error('This DSH session belongs to another topic')
      }
      const registry = this.options.load()
      const existing = registry[menu.key]
      if (JSON.stringify(existing) !== menu.previous) {
        throw new Error('The topic binding changed. Run /bind again.')
      }
      if (existing && !existing.dsh) {
        throw new Error('Unbind the existing CLI session before switching to DSH')
      }
      const binding: DshClaim = { key: menu.key, runtime: choice.runtime.runtime,
        profile: choice.runtime.profile, sessionId, capability: randomBytes(32).toString('hex') }
      const { key, ...dsh } = binding
      registry[key] = { ...menu.storage, dir: menu.dir, ...(existing?.allow ? { allow: existing.allow } : {}), dsh }
      this.options.save(registry)
      this.options.runtimes.sync()
      return binding
    } finally {
      this.busy.delete(menu.key)
    }
  }

  private owner(runtime: DshRuntime, sessionId: string, exceptKey: string): string | undefined {
    return Object.entries(this.options.load()).find(([key, entry]) => key !== exceptKey
      && entry.dsh?.runtime === runtime.runtime && entry.dsh.profile === runtime.profile
      && entry.dsh.sessionId === sessionId)?.[0]
  }
}
