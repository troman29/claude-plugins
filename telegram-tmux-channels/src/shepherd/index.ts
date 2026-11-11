// Точка входа шеперда для хаба: собирает хранилище, роутер и сокет; хаб даёт только доставку,
// публикацию в Telegram и биндинги.
import { join } from 'path'
import type { BindingEntry } from '../registry'
import { loadConfig, type ShepherdConfig } from './config'
import type { Exec } from './owner'
import { ShepherdRouter, type Clock, type DeliveryResult } from './router'
import { startShepherdHttp, startShepherdServer } from './server'
import { spawnForPr, type SpawnDeps } from './spawn'
import { ShepherdStore } from './store'

export type ShepherdOptions = {
  stateDir: string
  bindings: () => Record<string, BindingEntry>
  deliver: (key: string, text: string) => Promise<DeliveryResult>
  post: (target: string, text: string, options: { silent: boolean }) => Promise<void>
  reopenTopic: (key: string) => Promise<void>
  spawn: Pick<SpawnDeps, 'groups' | 'createTopic' | 'saveBinding'>
  log: (line: string) => void
  exec?: Exec
  clock?: Clock
  config?: () => ShepherdConfig
}

export type Shepherd = {
  router: ShepherdRouter
  socketPath: string
  /** Порт HTTP-приёмника; нет секции `http` — undefined. */
  httpPort(): number | undefined
  start(): void
  stop(): void
}

/** Только положительный ACK стаба — доставка; молчание старого или зависшего стаба — нет. */
export function ackToOutcome(ack: 'ok' | 'failed' | 'silent'): DeliveryResult {
  return ack === 'ok' ? 'ok' : 'failed'
}

/** Сторож доставки шлёт повтор при отказе стаба; когда итог ждёт шеперд, повторы только у него. */
export function watchdogApplies(outcomeRequested: boolean, nativeTransport: boolean): boolean {
  return !(outcomeRequested && nativeTransport)
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
  const config = options.config ?? (() => loadConfig(options.stateDir))
  const exec = options.exec ?? realExec
  const spawnDeps: SpawnDeps = { ...options.spawn, exec, config, bindings: options.bindings, log: options.log }
  const router = new ShepherdRouter({
    store,
    config,
    bindings: options.bindings,
    exec,
    clock,
    deliver: options.deliver,
    post: options.post,
    reopenTopic: options.reopenTopic,
    spawn: event => spawnForPr(spawnDeps, event),
    log: options.log,
  })
  const socketPath = join(options.stateDir, 'shepherd.sock')
  let stopServer: (() => void) | undefined
  let http: ReturnType<typeof startShepherdHttp> | undefined
  return {
    router,
    socketPath,
    httpPort: () => http?.port,
    start() {
      stopServer = startShepherdServer(socketPath, raw => router.accept(raw), options.log)
      const listen = config().http
      if (listen) {
        if (!config().token) {
          options.log('shepherd: http is configured but there is no token — every request gets 401')
        }
        http = startShepherdHttp({ ...listen, token: () => config().token, handle: raw => router.accept(raw), log: options.log })
      }
      router.replay()
    },
    stop() {
      stopServer?.()
      http?.stop()
      router.stop()
    },
  }
}
