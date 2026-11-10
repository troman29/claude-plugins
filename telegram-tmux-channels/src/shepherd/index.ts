// Точка входа шеперда для хаба: собирает хранилище, роутер и сокет; хаб даёт только доставку,
// публикацию в Telegram и биндинги.
import { join } from 'path'
import type { BindingEntry } from '../registry'
import { loadConfig, type ShepherdConfig } from './config'
import type { Exec } from './owner'
import { ShepherdRouter, type Clock, type DeliveryResult } from './router'
import { startShepherdServer } from './server'
import { ShepherdStore } from './store'

export type ShepherdOptions = {
  stateDir: string
  bindings: () => Record<string, BindingEntry>
  deliver: (key: string, text: string) => Promise<DeliveryResult>
  post: (target: string, text: string, options: { silent: boolean }) => Promise<void>
  log: (line: string) => void
  exec?: Exec
  clock?: Clock
  config?: () => ShepherdConfig
}

export type Shepherd = {
  router: ShepherdRouter
  socketPath: string
  start(): void
  stop(): void
}

const GH_TIMEOUT_MS = 20_000
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/

export function parsePrUrl(text: string): { repo: string; pr: number } | undefined {
  const match = PR_URL_RE.exec(text.trim())
  return match ? { repo: match[1]!, pr: Number(match[2]) } : undefined
}

/** `/own <ссылка на PR>` и `/shepherd` — команды топика. */
export function parseShepherdCommand(text: string): { cmd: 'own' | 'shepherd'; arg?: string } | undefined {
  const match = /^\/(own|shepherd)(?:@\w+)?(?:\s+(\S.*?))?\s*$/.exec(text.trim())
  return match ? { cmd: match[1] as 'own' | 'shepherd', ...(match[2] ? { arg: match[2] } : {}) } : undefined
}

const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

const realExec: Exec = async cmd => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: GH_TIMEOUT_MS })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout }
}

export function createShepherd(options: ShepherdOptions): Shepherd {
  const clock = options.clock ?? realClock
  const store = new ShepherdStore(join(options.stateDir, 'shepherd'), clock.now)
  const router = new ShepherdRouter({
    store,
    config: options.config ?? (() => loadConfig(options.stateDir)),
    bindings: options.bindings,
    exec: options.exec ?? realExec,
    clock,
    deliver: options.deliver,
    post: options.post,
    log: options.log,
  })
  const socketPath = join(options.stateDir, 'shepherd.sock')
  let stopServer: (() => void) | undefined
  return {
    router,
    socketPath,
    start() {
      stopServer = startShepherdServer(socketPath, raw => router.accept(raw), options.log)
      router.replay()
    },
    stop() {
      stopServer?.()
      router.stop()
    },
  }
}
