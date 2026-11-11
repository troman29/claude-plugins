// shepherd.json: { "repos": { "owner/name": "on" | "shadow" | "off" }, "serviceChat": "<chat>/<thread>",
//   "primary": true, "fanout": false, "http": { "listen": "host:port" }, "token": "…",
//   "spawn": { "owner/name": { "chat": "<chat>", "dir": "<checkout>" } } }.
// Читается при каждом событии, как bindings.json: правка вступает в силу без рестарта
// (кроме http.listen — адрес слушателя читается при старте хаба).
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { safeJsonParse } from '../util'

export type RepoMode = 'on' | 'shadow' | 'off'
export type SpawnTarget = { chat: string; dir: string }
export type ShepherdConfig = {
  repos: Record<string, RepoMode>
  serviceChat?: string
  trustedLogins: ReadonlySet<string>
  /** Главный хаб ведёт политику «владельца нет»; второстепенный про чужие PR молчит. */
  primary: boolean
  /** Cyrus рассылает событие всем хабам: нет `pr-unowned` за срок ожидания — PR чужой, а не «Cyrus молчит». */
  fanout: boolean
  http?: { host: string; port: number }
  token?: string
  spawn: Record<string, SpawnTarget>
  agentAuthors: ReadonlySet<string>
}

const MODES: ReadonlySet<string> = new Set(['on', 'shadow', 'off'])
const DEFAULT_AGENT_AUTHORS = ['thomas5788']
const TOKEN_FILE = 'shepherd.token'

export function configPath(stateDir: string): string {
  return join(stateDir, 'shepherd.json')
}

export function tokenPath(stateDir: string): string {
  return join(stateDir, TOKEN_FILE)
}

/** `host:port`: хост обязателен — без него HTTP не поднимаем, а не слушаем все интерфейсы. */
export function parseListen(listen: unknown): { host: string; port: number } | undefined {
  const match = typeof listen === 'string' ? /^([^:\s]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(listen) : null
  return match ? { host: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]) } : undefined
}

/** Токен берём из файла (права 0600), `token` в shepherd.json — запасной путь. */
function loadToken(stateDir: string, inline: unknown): string | undefined {
  const file = tokenPath(stateDir)
  const fromFile = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  const token = fromFile || (typeof inline === 'string' ? inline.trim() : '')
  return token || undefined
}

function parseSpawn(raw: unknown): Record<string, SpawnTarget> {
  const out: Record<string, SpawnTarget> = {}
  for (const [repo, target] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const { chat, dir } = (target ?? {}) as { chat?: unknown; dir?: unknown }
    if (typeof chat === 'string' && /^-?\d+$/.test(chat) && typeof dir === 'string' && dir) {
      out[repo.toLowerCase()] = { chat, dir }
    }
  }
  return out
}

/** Репозиторий вне списка — `off`: шеперд работает только там, где его включили явно. */
export function loadConfig(stateDir: string): ShepherdConfig {
  const file = configPath(stateDir)
  const parsed = existsSync(file) ? safeJsonParse<{
    repos?: Record<string, unknown>; serviceChat?: unknown; trustedLogins?: unknown
    primary?: unknown; fanout?: unknown; http?: { listen?: unknown }; token?: unknown; spawn?: unknown; agentAuthors?: unknown
  }>(readFileSync(file, 'utf8')) : undefined
  const repos: Record<string, RepoMode> = {}
  for (const [repo, mode] of Object.entries(parsed?.repos ?? {})) {
    if (typeof mode === 'string' && MODES.has(mode)) {
      repos[repo.toLowerCase()] = mode as RepoMode
    }
  }
  const serviceChat = typeof parsed?.serviceChat === 'string' && /^-?\d+(\/\d+)?$/.test(parsed.serviceChat) ? parsed.serviceChat : undefined
  // Вебхук отдаёт association NONE участнику организации со скрытым членством — таким людям доверяем по логину.
  const trustedLogins = new Set(
    Array.isArray(parsed?.trustedLogins)
      ? parsed.trustedLogins.filter((login): login is string => typeof login === 'string').map(login => login.toLowerCase())
      : [],
  )
  const http = parseListen(parsed?.http?.listen)
  const token = loadToken(stateDir, parsed?.token)
  const lowered = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((login): login is string => typeof login === 'string').map(login => login.toLowerCase()) : []
  return {
    repos, trustedLogins, spawn: parseSpawn(parsed?.spawn),
    primary: parsed?.primary !== false,
    fanout: parsed?.fanout === true,
    agentAuthors: new Set(Array.isArray(parsed?.agentAuthors) ? lowered(parsed.agentAuthors) : DEFAULT_AGENT_AUTHORS),
    ...(serviceChat ? { serviceChat } : {}),
    ...(http ? { http } : {}),
    ...(token ? { token } : {}),
  }
}

export function modeOf(config: ShepherdConfig, repo: string): RepoMode {
  return config.repos[repo.toLowerCase()] ?? 'off'
}
