// shepherd.json: { "repos": { "owner/name": "on" | "shadow" | "off" }, "serviceChat": "<chat>/<thread>" }.
// Читается при каждом событии, как bindings.json: правка вступает в силу без рестарта.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { safeJsonParse } from '../util'

export type RepoMode = 'on' | 'shadow' | 'off'
export type ShepherdConfig = { repos: Record<string, RepoMode>; serviceChat?: string }

const MODES: ReadonlySet<string> = new Set(['on', 'shadow', 'off'])

export function configPath(stateDir: string): string {
  return join(stateDir, 'shepherd.json')
}

/** Репозиторий вне списка — `off`: шеперд работает только там, где его включили явно. */
export function loadConfig(stateDir: string): ShepherdConfig {
  const file = configPath(stateDir)
  const parsed = existsSync(file) ? safeJsonParse<{ repos?: Record<string, unknown>; serviceChat?: unknown }>(readFileSync(file, 'utf8')) : undefined
  const repos: Record<string, RepoMode> = {}
  for (const [repo, mode] of Object.entries(parsed?.repos ?? {})) {
    if (typeof mode === 'string' && MODES.has(mode)) {
      repos[repo.toLowerCase()] = mode as RepoMode
    }
  }
  const serviceChat = typeof parsed?.serviceChat === 'string' && /^-?\d+(\/\d+)?$/.test(parsed.serviceChat) ? parsed.serviceChat : undefined
  return { repos, ...(serviceChat ? { serviceChat } : {}) }
}

export function modeOf(config: ShepherdConfig, repo: string): RepoMode {
  return config.repos[repo.toLowerCase()] ?? 'off'
}
