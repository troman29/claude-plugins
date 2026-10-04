import { homedir } from 'os'
import { join } from 'path'
import type { AgentAdapter } from './types'
import { isClaudeArgv } from '../proc'
import {
  buildLaunch, hasQueuedInput, isHeadlessArgv, paneIsWorking, parseCompaction, parseContextPct, parseError,
  parseWorkflow,
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
    resumeInPlace: true,
    fork: true,
    modelPicker: true,
    taskStatus: true,
    subagentStatus: true,
    skillStatus: true,
    backgroundStatus: true,
    captureSessionIdAtLaunch: true,
    hookSessionIdReliable: true,
    compactionProgressInPane: true,
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
  hasQueuedInput,
  paneIsWorking,
  parseContextPct,
  parseError,
  parseWorkflow,
  paneReady,
  inboundReady: paneReady,
  inboundState: () => undefined,
  canOpenStatusPanel: () => false,
  parseStatusPanel: () => undefined,
  cachedStatusLines: (dir, nowMs) => {
    const limits = readLimits(dir, nowMs)
    return limits ? formatLimits(limits, nowMs) : []
  },
  // Возобновляя из чата, сессию поднимают целиком и осознанно — диалог «взять саммари вместо
  // истории?» тут только блокирует подъём, отвечать на него некому. Его открывают два порога
  // CLI — по токенам (≥100k) и по возрасту (>70 мин); гасим оба, только для наших сессий.
  launchEnv: keys => ({
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '999999999',
    CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '999999999',
    TELEGRAM_BINDING_KEYS: keys.join(','),
  }),
  envFile: join(homedir(), '.claude', 'claude.env'),
}
