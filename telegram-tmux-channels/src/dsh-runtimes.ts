import { randomBytes } from 'node:crypto'
import type { DshClaim } from './native-dsh'

export type DshRuntime = { runtime: string; profile: string; label: string }
export type DshSession = { sessionId: string; cwd: string; title: string }
export type DshRuntimeCommand =
  | { action: 'list'; cwd: string }
  | { action: 'create'; cwd: string; sessionId: string }
export type DshRuntimeMessage =
  | { op: 'dsh-bindings'; bindings: DshClaim[] }
  | { op: 'dsh-runtime-command'; id: string; command: DshRuntimeCommand }

const REQUEST_TIMEOUT_MS = 15_000

/** Runtime discovery is local to the private hub socket; topic authority remains in the registry. */
export class DshRuntimes<C> {
  private connections = new Map<C, DshRuntime>()
  private pending = new Map<string, { conn: C; resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private options: {
    bindings: () => DshClaim[]
    send: (conn: C, message: DshRuntimeMessage) => void
    timeoutMs?: number
  }) {}

  register(conn: C, value: DshRuntime): void {
    if (!value || !['runtime', 'profile', 'label'].every(field => typeof value[field as keyof DshRuntime] === 'string' && value[field as keyof DshRuntime].length > 0)) {
      throw new Error('Invalid DSH runtime registration')
    }
    if ([...this.connections].some(([other, runtime]) => other !== conn && runtime.runtime === value.runtime)) {
      throw new Error('DSH runtime already connected')
    }
    this.connections.set(conn, { ...value })
    this.sync(conn)
  }

  has(conn: C): boolean {
    return this.connections.has(conn)
  }

  list(): DshRuntime[] {
    return [...this.connections.values()]
  }

  sync(conn?: C): void {
    for (const [candidate, runtime] of this.connections) {
      if (conn !== undefined && candidate !== conn) {
        continue
      }
      this.options.send(candidate, { op: 'dsh-bindings', bindings: this.options.bindings().filter(binding => binding.runtime === runtime.runtime && binding.profile === runtime.profile) })
    }
  }

  request(runtimeId: string, command: DshRuntimeCommand): Promise<string> {
    const conn = [...this.connections].find(([, runtime]) => runtime.runtime === runtimeId)?.[0]
    if (conn === undefined) {
      return Promise.reject(new Error('DSH runtime is unavailable'))
    }
    const id = randomBytes(12).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('DSH runtime request timed out; outcome is unknown'))
      }, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      this.pending.set(id, { conn, resolve, reject, timer })
      try {
        this.options.send(conn, { op: 'dsh-runtime-command', id, command })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  result(conn: C, message: { id: string; ok: boolean; result?: string }): void {
    const pending = this.pending.get(message.id)
    if (!pending || pending.conn !== conn) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok && typeof message.result === 'string') {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error('DSH runtime operation failed'))
    }
  }

  disconnect(conn: C): void {
    this.connections.delete(conn)
    for (const [id, pending] of this.pending) {
      if (pending.conn !== conn) {
        continue
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error('DSH runtime disconnected; outcome is unknown'))
    }
  }
}
