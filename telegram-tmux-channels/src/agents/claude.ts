import type { AgentAdapter } from './types'
import { isClaudeArgv } from '../proc'
import {
  buildLaunch, isHeadlessArgv, paneIsWorking, parseCompaction, parseContextPct, parseError, parseWorkflow,
} from '../tmux-ops'
import {
  jsonlMtimes, lastAssistantText, newestJsonlSize, recentSessions, transcriptSawIncoming,
} from '../session-id'
import { paneReady } from '../picker'
import { formatLimits, readLimits } from '../limits'

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    nativeInboundTransport: true,
    nativeReplyTool: true,
    permissions: true,
    resume: true,
    liveResumePicker: true,
    fork: true,
    modelPicker: true,
    taskStatus: true,
    subagentStatus: true,
    skillStatus: true,
    backgroundStatus: true,
    captureSessionIdAtLaunch: true,
    hookSessionIdReliable: true,
  },
  isProcessArgv: isClaudeArgv,
  isPaneCommand: command => /(^|\/)claude(?:\.exe)?$/i.test(command.trim()),
  isHeadlessArgv,
  buildLaunch,
  sessionMtimes: jsonlMtimes,
  recentSessions,
  transcriptSize: newestJsonlSize,
  lastAssistantText,
  assistantDraftText: () => '',
  transcriptSawIncoming,
  sessionForIncoming: () => undefined,
  parseCompaction,
  paneIsWorking,
  parseContextPct,
  parseError,
  parseWorkflow,
  paneReady,
  canOpenStatusPanel: () => false,
  parseStatusPanel: () => undefined,
  cachedStatusLines: (dir, nowMs) => {
    const limits = readLimits(dir, nowMs)
    return limits ? formatLimits(limits, nowMs) : []
  },
  // Возобновляя из чата, сессию поднимают целиком и осознанно — предложение «взять саммари
  // вместо истории» тут только блокирует подъём диалогом, отвечать на который некому.
  // Порог по токенам и есть тот вентиль, что показывает этот диалог (CLI, ≥100k по умолчанию).
  launchEnvPrefix: keys =>
    `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999 TELEGRAM_BINDING_KEYS=${JSON.stringify(keys.join(','))}`,
}
