export type AgentKind = 'claude' | 'codex'

export type LaunchMode = 'resume' | 'new' | 'fork'

export type AgentCapabilities = {
  nativeInboundTransport: boolean
  nativeReplyTool: boolean
  permissions: boolean
  resume: boolean
  // Whether a connected TUI can open and drive its own interactive history
  // picker.  Agents without one use the hub's Telegram picker instead.
  liveResumePicker: boolean
  fork: boolean
  modelPicker: boolean
  taskStatus: boolean
  subagentStatus: boolean
  skillStatus: boolean
  backgroundStatus: boolean
  // Some CLIs create a transcript only after the first input.  A directory-wide
  // "newest transcript" scan cannot safely identify such a session when topics share cwd.
  captureSessionIdAtLaunch: boolean
  // Whether a hook's session_id is safe to persist without transcript correlation.
  hookSessionIdReliable: boolean
}

export type RecentAgentSession = { id: string; mtime: number; snippet: string }

// A transient agent-owned status panel.  The hub only asks an adapter to parse a panel it
// explicitly opened for a user-requested /status; it never guesses quota data from a
// transcript or from another agent's cache.
export type AgentStatusPanel = {
  model?: string
  contextUsedPct?: number
  contextLeftPct?: number
  limits: { label: string; remainingPct: number; resets?: string }[]
  stale?: boolean
}

// All agent-specific knowledge belongs behind this contract. The Telegram hub may still own
// transport policy and tmux mechanics, but it must not know transcript paths, CLI flags, process
// names, or TUI signatures for a particular agent.
export interface AgentAdapter {
  readonly kind: AgentKind
  readonly displayName: string
  readonly capabilities: AgentCapabilities

  isProcessArgv(argv: string[]): boolean
  // `tmux display-message #{pane_current_command}` is intentionally narrower than
  // argv inspection: use it only to avoid typing a launch into a foreign live TUI.
  isPaneCommand(command: string): boolean
  isHeadlessArgv(argv: string[]): boolean
  buildLaunch(saved: string[] | undefined, mode: LaunchMode, sessionId?: string): string

  sessionMtimes(dir: string): Map<string, number>
  recentSessions(dir: string, limit?: number): RecentAgentSession[]
  transcriptSize(dir: string, sessionId?: string): number
  lastAssistantText(dir: string, sinceMs: number, sessionId?: string): string
  // Safe cumulative assistant snapshot for Telegram drafts. Empty means this provider does not
  // expose a channel that can be distinguished from reasoning/commentary/tool output.
  assistantDraftText(dir: string, sinceMs: number, sessionId?: string): string
  transcriptSawIncoming(dir: string, sinceMs: number, needle: string): boolean
  sessionForIncoming(dir: string, sinceMs: number, needle: string): string | undefined

  parseCompaction(pane: string): { pct: number; elapsed?: string } | undefined
  paneIsWorking(pane: string): boolean
  parseContextPct(pane: string): number | undefined
  parseError(pane: string): string | undefined
  parseWorkflow(pane: string): { name: string; done: number; total: number } | undefined
  paneReady(pane: string): boolean

  // Optional interactive status panel (currently Codex `/status`).  `canOpen…` must be
  // conservative: a local draft in tmux must never be submitted merely to refresh quotas.
  statusPanelCommand?: string
  canOpenStatusPanel(pane: string, ansiPane?: string): boolean
  parseStatusPanel(pane: string): AgentStatusPanel | undefined

  // Agent-owned status sources that do not require poking the live pane (e.g. Claude's
  // statusline cache). The hub only renders the returned lines.
  cachedStatusLines(dir: string, nowMs: number): string[]
  launchEnvPrefix(bindingKeys: string[]): string
}
