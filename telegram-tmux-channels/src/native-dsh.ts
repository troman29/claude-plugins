import { timingSafeEqual } from 'node:crypto'

export type DshBinding = {
  runtime: string
  profile: string
  sessionId: string
  capability: string
}

export type DshClaim = DshBinding & { key: string }
export type DshCommand =
  | { action: 'prompt'; requestId: string; mode: 'queue' | 'steer'; text: string }
  | { action: 'status' | 'resume' | 'fork' }

export function validDshBinding(value: unknown): value is DshBinding {
  if (!value || typeof value !== 'object') {
    return false
  }
  const binding = value as Record<string, unknown>
  return ['runtime', 'profile', 'sessionId'].every(field => typeof binding[field] === 'string' && (binding[field] as string).length > 0)
    && typeof binding.capability === 'string' && /^[a-f0-9]{64}$/.test(binding.capability)
}

export function matchesDshBinding(binding: DshBinding | undefined, claim: DshClaim): boolean {
  if (!validDshBinding(binding) || !validDshBinding(claim)) {
    return false
  }
  return binding.runtime === claim.runtime && binding.profile === claim.profile
    && binding.sessionId === claim.sessionId
    && timingSafeEqual(Buffer.from(binding.capability), Buffer.from(claim.capability))
}

const NATIVE_TIMEOUT_MS = 10_000

/** Native requests never fall back to cwd routing, tmux, or another connection. */
export class NativeDshHub<C> {
  private claims = new Map<C, DshClaim>()
  private pending = new Map<string, { conn: C; resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private sequence = 0

  constructor(private options: {
    binding: (key: string) => DshBinding | undefined
    send: (conn: C, message: { op: 'dsh-command'; id: string; command: DshCommand }) => void
    timeoutMs?: number
  }) {}

  subscribe(conn: C, claim: DshClaim): void {
    if (!matchesDshBinding(this.options.binding(claim.key), claim)) {
      throw new Error('Native binding authorization failed')
    }
    if ([...this.claims].some(([other]) => other !== conn && this.key(other) === claim.key)) {
      throw new Error('Native binding already connected')
    }
    this.claims.set(conn, { ...claim })
  }

  subscribed(conn: C): boolean {
    return this.claims.has(conn)
  }

  key(conn: C): string | undefined {
    const claim = this.claims.get(conn)
    return claim && matchesDshBinding(this.options.binding(claim.key), claim) ? claim.key : undefined
  }

  disconnect(conn: C): void {
    this.claims.delete(conn)
    for (const [id, pending] of this.pending) {
      if (pending.conn === conn) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new Error('Native bridge disconnected; delivery outcome is unknown'))
      }
    }
  }

  result(conn: C, message: { id: string; ok: boolean; result?: string }): void {
    const pending = this.pending.get(message.id)
    if (!pending || pending.conn !== conn) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok === true && typeof message.result === 'string' && this.key(conn)) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error('Native operation failed'))
    }
  }

  request(key: string, command: DshCommand): Promise<string> {
    const conn = [...this.claims.keys()].find(candidate => this.key(candidate) === key)
    if (conn === undefined) {
      return Promise.reject(new Error('Native bridge is unavailable'))
    }
    const id = `native-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Native operation timed out; delivery outcome is unknown'))
      }, this.options.timeoutMs ?? NATIVE_TIMEOUT_MS)
      this.pending.set(id, { conn, resolve, reject, timer })
      try {
        this.options.send(conn, { op: 'dsh-command', id, command })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
}
