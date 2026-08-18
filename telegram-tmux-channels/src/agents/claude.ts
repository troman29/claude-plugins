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
  launchEnvPrefix: keys => `CLAUDE_CODE_DISABLE_RESUME_PROMPT=1 TELEGRAM_BINDING_KEYS=${JSON.stringify(keys.join(','))}`,
}
