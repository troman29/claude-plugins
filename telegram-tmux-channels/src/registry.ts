// bindings.json — the hub's key → project map: {"-100.../42": {dir, allow?, cmdline?}}.
// Driven by /bind,/unbind,/allow from Telegram; also hand-editable (hot-reloaded).
import { readFileSync, writeFileSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const BINDINGS_FILE = join(STATE_DIR, 'bindings.json')

export type BindingEntry = {
  dir: string
  allow?: string[]
  cmdline?: string[]
  sessionId?: string // claude conversation id — --resume target when this binding's dir is shared
  hookBranch?: string // set for auto-topic worktree bindings created via a group hook — /unbind runs hook.delete on this
  pinned?: boolean // /pin — never idle-unload this binding (see TELEGRAM_IDLE_UNLOAD_MINUTES)
  unloaded?: boolean // suspended by idle-unload — survives a reboot so boot-revive leaves it asleep
}

export function loadBindings(): Record<string, BindingEntry> {
  let raw: string
  try {
    raw = readFileSync(BINDINGS_FILE, 'utf8')
  } catch {
    return {} // no bindings file yet
  }
  return safeJsonParse<Record<string, BindingEntry>>(raw) ?? {}
}

export function saveBindings(reg: Record<string, BindingEntry>): void {
  writeFileSync(BINDINGS_FILE + '.tmp', JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(BINDINGS_FILE + '.tmp', BINDINGS_FILE)
}

// Свежий разговор угадывается по новому jsonl в папке — при параллельных стартах в ОДНОЙ
// папке (два /fork подряд) оба видят один файл и забирают чужой id. Чужой не берём: пусть
// биндинг постоит без id, его пришлёт сама сессия (sessionId sync из хука).
export function sessionIdTaken(
  reg: Record<string, BindingEntry>, key: string, sessionId: string,
): boolean {
  return Object.entries(reg).some(([k, v]) => k !== key && v.sessionId === sessionId)
}

// Присвоить id ключам, которые ЗАЯВИЛА сама сессия, и снять его с остальных: два биндинга
// на один разговор — это перезапуск в чужую историю. Чистая — тестируется юнитом.
export function claimSessionId(
  reg: Record<string, BindingEntry>, bindingKeys: string[], sessionId: string,
): boolean {
  let changed = false
  for (const key of bindingKeys) {
    const b = reg[key]
    if (b && b.sessionId !== sessionId) {
      b.sessionId = sessionId
      changed = true
    }
  }
  if (!changed) {
    return false
  }
  for (const [k, v] of Object.entries(reg)) {
    if (!bindingKeys.includes(k) && v.sessionId === sessionId) {
      delete v.sessionId
    }
  }
  return true
}

export function keysForDir(reg: Record<string, BindingEntry>, dir: string): string[] {
  return Object.keys(reg).filter(k => reg[k].dir === dir)
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
