import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentAdapter, AgentKind } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'

export type { AgentAdapter, AgentCapabilities, AgentKind, AgentStatusPanel, LaunchMode, RecentAgentSession } from './types'
export { claudeAdapter, codexAdapter }

const adapters: Record<AgentKind, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

// Обычные места установки обоих CLI. Смотрим их, а не только PATH: у user-юнита systemd PATH
// свой и БЕЗ ~/.local/bin, где оба и лежат — по одному `Bun.which` хаб решал, что на машине нет
// ни одного харнесса, и переключатель не показывал вообще нигде.
const HARNESS_DIRS = [join(homedir(), '.local/bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']

/** Харнессы, реально стоящие на машине. Дороже `Bun.which` на несколько stat — считается на
 *  отрисовку пикера, зато поставленный после старта хаба CLI виден без рестарта. */
export function installedAgents(dirs: string[] = HARNESS_DIRS): AgentKind[] {
  return (Object.keys(adapters) as AgentKind[])
    .filter(kind => !!Bun.which(kind) || dirs.some(dir => existsSync(join(dir, kind))))
}

export function agentAdapter(kind: AgentKind | undefined): AgentAdapter {
  return adapters[kind ?? 'claude']
}

/** Что позволено «выучить» из живой сессии в биндинг.
 *
 * `owned` — сессия несёт ключ биндинга, то есть её поднял хаб: ей верим полностью.
 * Посторонний процесс в том же каталоге (руками запущенный агент, зонд, соседний топик) может
 * уточнить только argv и только для СВОЕГО харнесса: 2026-08-17 пробный codex в папке claude-топика
 * переписал биндингу агента, и доставка в тот топик встала намертво.
 */
export function mayLearn(
  owned: boolean, sessionAgent: AgentKind, bindingAgent: AgentKind | undefined,
): { argv: boolean; agent: boolean } {
  const same = (bindingAgent ?? 'claude') === sessionAgent
  return { argv: owned || same, agent: owned && !same }
}
