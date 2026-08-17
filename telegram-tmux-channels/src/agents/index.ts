import type { AgentAdapter, AgentKind } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'

export type { AgentAdapter, AgentCapabilities, AgentKind, AgentStatusPanel, LaunchMode, RecentAgentSession } from './types'
export { claudeAdapter, codexAdapter }

const adapters: Record<AgentKind, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

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
