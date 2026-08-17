import { closeSync, openSync, readSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentAdapter, AgentStatusPanel, LaunchMode, RecentAgentSession } from './types'
import { shellQuote } from '../tmux-ops'
import { isCodexArgv } from '../proc'

type Rollout = { id: string; path: string; mtime: number; cwd: string; firstUser: string }

export { isCodexArgv }

export function isCodexHeadlessArgv(argv: string[]): boolean {
  const i = argv.findIndex(a => isCodexArgv([a]))
  return i >= 0 && argv.slice(i + 1).some(a => a === 'exec' || a === 'review')
}

function stripLifecycle(argv: string[]): string[] {
  const i = argv.findIndex(a => isCodexArgv([a]))
  const base = i >= 0 ? argv.slice(i) : ['codex']
  if (base[1] === 'resume' || base[1] === 'fork') return [base[0]!]
  return base
}

export function buildCodexLaunch(
  saved: string[] | undefined,
  mode: LaunchMode,
  sessionId?: string,
): string {
  const base = stripLifecycle(saved?.length ? saved : ['codex'])
  if (mode === 'new') return shellQuote(base)
  const command = mode === 'fork' ? 'fork' : 'resume'
  return shellQuote([...base, command, ...(sessionId ? [sessionId] : ['--last'])])
}

function stringsFromContent(content: unknown, field: 'input_text' | 'output_text'): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(v => {
    if (!v || typeof v !== 'object') return []
    const p = v as { type?: string; text?: string }
    return p.type === field && typeof p.text === 'string' ? [p.text] : []
  })
}

function rolloutUserSnippet(content: unknown): string {
  return stringsFromContent(content, 'input_text').join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Codex records its launch envelope as a role=user item before the human's first turn. It is
// useful provenance but a terrible resume label ("cwd … shell …"). Keep scanning until the
// first actual request; old/minimal rollouts still simply have an empty snippet.
function isBootstrapEnvelope(text: string): boolean {
  return text.includes('<environment_context>') || text.includes('<developer_instructions>')
    || text.includes('<skills_instructions>') || text.includes('<app-context>')
}

function displayRolloutSnippet(text: string): string {
  // Telegram routing metadata is needed in the transcript, but repeating chat/topic ids in every
  // resume button hides the actual request. Strip exactly the leading envelope only.
  return text.replace(/^\[Telegram message;[^\n]*\]\s*/u, '').trim()
}

function parseRollout(path: string): Rollout | undefined {
  // Session metadata and the first user turn live at the head of the rollout. Reading a
  // multi-megabyte active transcript on every delivery poll made the watchdog increasingly
  // expensive over the lifetime of a conversation.
  let text = ''
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(size, 262144))
    readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    text = buf.toString('utf8')
  } catch { return undefined }
  let id = ''
  let cwd = ''
  let firstUser = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }
      if (row.type === 'session_meta') {
        id = String(row.payload?.id ?? '')
        cwd = String(row.payload?.cwd ?? '')
      } else if (!firstUser && row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
        const raw = stringsFromContent(row.payload.content, 'input_text').join(' ')
        if (!isBootstrapEnvelope(raw)) firstUser = rolloutUserSnippet(row.payload.content)
      }
    } catch {}
    if (id && cwd && firstUser) break
  }
  if (!id || !cwd) return undefined
  try { return { id, cwd, path, firstUser, mtime: statSync(path).mtimeMs } } catch { return undefined }
}

function walkRollouts(root: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const path = join(root, e.name)
    if (e.isDirectory()) walkRollouts(path, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

function codexSessionsRoot(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions')
}

export function codexRollouts(dir: string, root = codexSessionsRoot()): Rollout[] {
  return walkRollouts(root).map(parseRollout).filter((r): r is Rollout => r?.cwd === dir)
}

function selected(dir: string, sessionId?: string): Rollout | undefined {
  const rows = codexRollouts(dir)
  if (sessionId) return rows.find(r => r.id === sessionId)
  return rows.sort((a, b) => b.mtime - a.mtime)[0]
}

export function codexSessionMtimes(dir: string): Map<string, number> {
  return new Map(codexRollouts(dir).map(r => [r.id, r.mtime]))
}

export function recentCodexSessions(dir: string, limit = 5): RecentAgentSession[] {
  return codexRollouts(dir).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
    .map(r => ({ id: r.id, mtime: r.mtime, snippet: displayRolloutSnippet(r.firstUser) }))
}

export function codexTranscriptSize(dir: string, sessionId?: string): number {
  const row = selected(dir, sessionId)
  if (!row) return 0
  try { return statSync(row.path).size } catch { return 0 }
}

function tail(path: string): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - 262144)
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

export function lastCodexAssistantText(dir: string, sinceMs: number, sessionId?: string): string {
  const row = selected(dir, sessionId)
  if (!row || row.mtime < sinceMs - 2000) return ''
  const lines = tail(row.path).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
      if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'assistant') continue
      if (event.payload.phase && event.payload.phase !== 'final_answer') continue
      const text = stringsFromContent(event.payload.content, 'output_text').join('\n\n').trim()
      if (!text) continue
      return event.timestamp && Date.parse(event.timestamp) < sinceMs ? '' : text
    } catch {}
  }
  return ''
}

export function codexTranscriptSawIncoming(dir: string, sinceMs: number, needle: string): boolean {
  for (const row of codexRollouts(dir)) {
    if (row.mtime < sinceMs - 2000) continue
    for (const line of tail(row.path).split('\n')) {
      try {
        const event = JSON.parse(line) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
        if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'user') continue
        if (!event.timestamp || Date.parse(event.timestamp) < sinceMs - 2000) continue
        const text = stringsFromContent(event.payload.content, 'input_text').join('\n')
        if (!needle || text.includes(needle)) return true
      } catch {}
    }
  }
  return false
}

// A Codex rollout is created lazily, on the first user input.  In a shared cwd there can be
// several brand-new rollouts at once, so mtime alone is not an identity.  The Telegram envelope
// and message text are written into that rollout; use that durable evidence to bind it to its
// originating topic.
export function codexSessionForIncoming(dir: string, sinceMs: number, needle: string): string | undefined {
  if (!needle) return undefined
  const found = codexRollouts(dir).filter(row => {
    if (row.mtime < sinceMs - 2000) return false
    for (const line of tail(row.path).split('\n')) {
      try {
        const event = JSON.parse(line) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
        if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'user') continue
        if (!event.timestamp || Date.parse(event.timestamp) < sinceMs - 2000) continue
        if (stringsFromContent(event.payload.content, 'input_text').join('\n').includes(needle)) return true
      } catch {}
    }
    return false
  }).sort((a, b) => b.mtime - a.mtime)
  return found[0]?.id
}

export function codexPaneReady(pane: string): boolean {
  // tmux capture-pane preserves the terminal's blank bottom rows. The Codex prompt is often
  // visibly above them, so take the last rendered lines rather than the literal last rows.
  const tail = pane.split('\n').map(s => s.trimEnd()).filter(s => s.trim()).slice(-12)
  return tail.some(line => /^›(?:\s|$)/.test(line.trimStart()))
    && !tail.some(line => /Working \(\d+s?\s*[•·]|esc to interrupt/i.test(line))
}

export function codexPaneIsWorking(pane: string): boolean {
  return pane.split('\n').filter(line => line.trim()).slice(-12)
    .some(line => /[•●]\s+Working \(\d+s?\s*[•·].*esc to interrupt/i.test(line.trim()))
}

export function parseCodexError(pane: string): string | undefined {
  const tail = pane.split('\n').map(s => s.trim().replace(/^[•●]\s*/, '')).filter(Boolean).slice(-12)
  return tail.find(line => /^(Error:|Not logged in|Failed to|You've hit your usage limit)/i.test(line))?.slice(0, 300)
}

// Codex 0.147 renders `/status` as a modal panel.  Its values are deliberately parsed only
// from that modal, not from JSONL transcripts (which the official hooks API calls unstable).
// Keep labels verbatim: account plans add or rename quota buckets over time.
export function parseCodexStatusPanel(pane: string): AgentStatusPanel | undefined {
  if (!/OpenAI Codex \(v[\d.]+\)/.test(pane) || !/Weekly limit:/.test(pane)) return undefined
  const panel: AgentStatusPanel = { limits: [] }
  const model = pane.match(/\bModel:\s+([^\n(]+?)(?:\s+\(reasoning|\s*$)/m)?.[1]?.trim()
  if (model) panel.model = model
  const context = pane.match(/\bContext window:\s+(\d+)% left\s+\([^)]*?\)/)
  if (context) {
    panel.contextLeftPct = Number(context[1])
    panel.contextUsedPct = 100 - panel.contextLeftPct
  }
  for (const line of pane.split('\n')) {
    const m = line.match(/^\s*(.+?limit):\s*\[[^\]]*]\s*(\d+)% left\s*\(resets\s+([^)]+)\)/i)
    if (m) panel.limits.push({ label: m[1]!.replace(/^[│|]\s*/, '').trim(), remainingPct: Number(m[2]), resets: m[3]!.trim() })
  }
  panel.stale = /limits may be stale/i.test(pane)
  return panel
}

export function codexCanOpenStatusPanel(pane: string, ansiPane?: string): boolean {
  if (!codexPaneReady(pane)) return false
  // The composer placeholder is dim (SGR 2) while locally typed input is not. Its text rotates
  // between prompts, so this accepts every empty Codex composer without submitting a draft.
  if (ansiPane) {
    const promptLine = [...ansiPane.split('\n')].reverse().find(line => line.includes('›'))
    if (promptLine) return /›(?:\x1b\[[0-9;]*m)?\s*\x1b\[2m/.test(promptLine)
  }
  // Codex displays this placeholder for an empty composer.  Any other text after `›` is a
  // local draft; this conservative no-ANSI fallback is for terminals without styling.
  const lines = pane.split('\n').map(line => line.trim()).filter(Boolean)
  const prompt = [...lines].reverse().find(line => line.startsWith('›'))
  return prompt === '›' || prompt === '› Find and fix a bug in @filename'
}

const noPct = (): undefined => undefined

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  displayName: 'Codex',
  capabilities: {
    nativeInboundTransport: false,
    nativeReplyTool: false,
    permissions: true,
    resume: true,
    liveResumePicker: false,
    fork: true,
    modelPicker: true,
    taskStatus: true,
    subagentStatus: true,
    skillStatus: true,
    backgroundStatus: true,
    captureSessionIdAtLaunch: false,
    hookSessionIdReliable: false,
  },
  isProcessArgv: isCodexArgv,
  isPaneCommand: command => /(^|\/)codex(?:\.exe)?$/i.test(command.trim()),
  isHeadlessArgv: isCodexHeadlessArgv,
  buildLaunch: buildCodexLaunch,
  sessionMtimes: codexSessionMtimes,
  recentSessions: recentCodexSessions,
  transcriptSize: codexTranscriptSize,
  lastAssistantText: lastCodexAssistantText,
  transcriptSawIncoming: codexTranscriptSawIncoming,
  sessionForIncoming: codexSessionForIncoming,
  // Codex TUI parsing is intentionally explicit rather than reusing Claude signatures.
  // These are filled from captured 0.147 fixtures before hub routing is enabled.
  parseCompaction: noPct,
  paneIsWorking: codexPaneIsWorking,
  parseContextPct: noPct,
  parseError: parseCodexError,
  parseWorkflow: () => undefined,
  paneReady: codexPaneReady,
  statusPanelCommand: '/status',
  canOpenStatusPanel: codexCanOpenStatusPanel,
  parseStatusPanel: parseCodexStatusPanel,
  cachedStatusLines: () => [],
  launchEnvPrefix: keys => `TELEGRAM_BINDING_KEYS=${JSON.stringify(keys.join(','))}`,
}
