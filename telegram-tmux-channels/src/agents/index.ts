import type { AgentAdapter, AgentKind } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'

export type { AgentAdapter, AgentCapabilities, AgentKind, AgentStatusPanel, LaunchMode, RecentAgentSession } from './types'
export { claudeAdapter, codexAdapter }

const adapters: Record<AgentKind, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

export function agentAdapter(kind: AgentKind | undefined): AgentAdapter {
  return adapters[kind ?? 'claude']
}
