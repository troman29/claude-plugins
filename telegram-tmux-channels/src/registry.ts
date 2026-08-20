// bindings.json — the hub's key → project map: {"-100.../42": {dir, allow?, cmdline?}}.
// Driven by /bind,/unbind,/allow from Telegram; also hand-editable (hot-reloaded).
import { readFileSync, writeFileSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'
import { keyToTarget } from './bindings'
import type { AgentKind } from './agents/types'

export const BINDINGS_FILE = join(STATE_DIR, 'bindings.json')
// Polling calls loadBindings often. Remember the malformed version so one
// operator-visible fault does not turn into an unbounded error-log flood.
let lastReportedRegistryFault: string | undefined

export type BindingEntry = {
  dir: string
  // Missing means Claude for backwards compatibility with every binding written before
  // the multi-agent adapter existed. New bindings persist the choice explicitly.
  agent?: AgentKind
  allow?: string[]
  cmdline?: string[]
  sessionId?: string // claude conversation id — --resume target when this binding's dir is shared
  hookBranch?: string // set for auto-topic worktree bindings created via a group hook — /unbind runs hook.delete on this
  tmux?: string // имя tmux-сессии. Пишется при создании биндинга: имя собрано из проекта и слага
  // топика, а раньше выводилось из id чата и топика — те в имени никому не нужны. Старые
  // биндинги поля не имеют и продолжают жить под прежним именем.
  pinned?: boolean // /pin — never idle-unload this binding (see TELEGRAM_IDLE_UNLOAD_MINUTES)
  unloaded?: boolean // suspended by idle-unload — survives a reboot so boot-revive leaves it asleep
}

/** Keep one hand-edited bad row from crashing every routing/revive call site. */
export function validBindings(parsed: unknown): { bindings: Record<string, BindingEntry>; rejected: string[] } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { bindings: {}, rejected: ['registry root is not an object'] }
  }
  const bindings: Record<string, BindingEntry> = {}
  const rejected: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    try {
      keyToTarget(key)
    } catch {
      rejected.push(`bad key ${JSON.stringify(key)}`)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as BindingEntry).dir !== 'string' || !(value as BindingEntry).dir) {
      rejected.push(`bad entry for ${JSON.stringify(key)}`)
      continue
    }
    const agent = (value as BindingEntry).agent
    if (agent != null && agent !== 'claude' && agent !== 'codex') {
      rejected.push(`bad agent for ${JSON.stringify(key)}`)
      continue
    }
    bindings[key] = value as BindingEntry // unknown fields remain forward-compatible
  }
  return { bindings, rejected }
}

export function loadBindings(): Record<string, BindingEntry> {
  let raw: string
  try {
    raw = readFileSync(BINDINGS_FILE, 'utf8')
  } catch {
    return {} // no bindings file yet
  }
  const parsed = safeJsonParse<unknown>(raw)
  if (parsed == null) {
    // Do not silently turn a hand-edited/corrupted registry into an apparently
    // empty installation: that drops every live session claim on hub restart.
    // Keep the file untouched so the operator can repair it or restore a backup.
    if (raw !== lastReportedRegistryFault) {
      console.error(`telegram registry: ERROR invalid JSON in ${BINDINGS_FILE}; treating bindings as unavailable`)
      lastReportedRegistryFault = raw
    }
    return {}
  }
  const { bindings, rejected } = validBindings(parsed)
  if (rejected.length) {
    if (raw !== lastReportedRegistryFault) {
      console.error(`telegram registry: ERROR ignored malformed binding entries in ${BINDINGS_FILE}: ${rejected.join('; ')}`)
      lastReportedRegistryFault = raw
    }
  } else {
    lastReportedRegistryFault = undefined
  }
  return bindings
}

export function saveBindings(reg: Record<string, BindingEntry>): void {
  writeFileSync(BINDINGS_FILE + '.tmp', JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(BINDINGS_FILE + '.tmp', BINDINGS_FILE)
}

export function keysForDir(reg: Record<string, BindingEntry>, dir: string): string[] {
  return Object.keys(reg).filter(k => reg[k].dir === dir)
}

/** A conversation can belong to one topic only, even when topics deliberately share a folder. */
export function sessionOwner(
  reg: Record<string, BindingEntry>,
  dir: string,
  sessionId: string,
  exceptKey?: string,
): string | undefined {
  return Object.entries(reg).find(([key, binding]) =>
    key !== exceptKey && binding.dir === dir && binding.sessionId === sessionId,
  )?.[0]
}

/** Update exactly one binding in a freshly loaded registry; sibling updates survive. */
export function setSessionId(reg: Record<string, BindingEntry>, key: string, sessionId: string): BindingEntry | undefined {
  const binding = reg[key]
  if (!binding) return undefined
  binding.sessionId = sessionId
  return binding
}

// "/bind myapp" → ~/projects/myapp; also accepts an absolute path or ~/…
export function resolveProjectDir(arg: string, projectsRoot = join(homedir(), 'projects')): string {
  const p = arg.startsWith('~/') ? join(homedir(), arg.slice(2)) : arg
  const full = p.startsWith('/') ? p : join(projectsRoot, p)
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`not a directory: ${full}`)
  }
  return full
}

/** `/bind codex path` selects an adapter; legacy `/bind path` remains Claude. */
export function parseBindSpec(arg: string): { agent: AgentKind; path: string } {
  const m = /^(claude|codex)\s+([\s\S]+)$/i.exec(arg.trim())
  return m
    ? { agent: m[1]!.toLowerCase() as AgentKind, path: m[2]!.trim() }
    : { agent: 'claude', path: arg.trim() }
}
