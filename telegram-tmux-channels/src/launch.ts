import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { shellQuote, type LaunchMode } from './tmux-ops'

export type LaunchRequest = { keys: string[]; mode: LaunchMode; sessionId?: string }

export type LaunchPlan = { dir: string; env: Record<string, string>; envFile?: string; argv: string[] }

export const LAUNCHER = 'tgc-run'
const LAUNCHER_SOURCE = join(import.meta.dir, '..', 'bin', LAUNCHER)
const LAUNCHER_LINK = join(homedir(), '.local', 'bin', LAUNCHER)
const MODES: readonly LaunchMode[] = ['new', 'resume', 'fork']

/** Что хаб печатает в пейн. Папку, окружение и argv агента `tgc-run` достаёт из биндинга сам. */
export function launchLine(req: LaunchRequest): string {
  return shellQuote([LAUNCHER, req.keys.join(','), req.mode, ...(req.sessionId ? [req.sessionId] : [])])
}

export function parseLaunchArgs(args: string[]): LaunchRequest {
  const [keys, mode, sessionId, ...rest] = args
  if (!keys || !MODES.includes(mode as LaunchMode) || rest.length > 0) {
    throw new Error(`usage: ${LAUNCHER} <key[,key…]> ${MODES.join('|')} [session-id]`)
  }
  return { keys: keys.split(','), mode: mode as LaunchMode, ...(sessionId ? { sessionId } : {}) }
}

/** Shell-скрипт для `eval` в обёртке: последней строкой он заменяет шелл агентом через exec. */
export function launchScript(plan: LaunchPlan): string {
  const lines = [
    `cd ${shellQuote([plan.dir])}`,
    ...Object.entries(plan.env).map(([name, value]) => `export ${name}=${shellQuote([value])}`),
    ...(plan.envFile ? [`if [ -r ${shellQuote([plan.envFile])} ]; then . ${shellQuote([plan.envFile])}; fi`] : []),
    `exec ${shellQuote(plan.argv)}`,
  ]
  return `${lines.join('\n')}\n`
}

/** Кладёт `tgc-run` в `~/.local/bin`: хаб печатает его голым именем, и шелл пейна ищет его в PATH. */
export function installLauncher(log: (s: string) => void): void {
  const current = lstatSync(LAUNCHER_LINK, { throwIfNoEntry: false })
  if (current?.isSymbolicLink() && readlinkSync(LAUNCHER_LINK) === LAUNCHER_SOURCE) {
    return
  }
  if (current) {
    rmSync(LAUNCHER_LINK)
  }
  mkdirSync(dirname(LAUNCHER_LINK), { recursive: true })
  symlinkSync(LAUNCHER_SOURCE, LAUNCHER_LINK)
  log(`launcher: ${LAUNCHER_LINK} → ${LAUNCHER_SOURCE}`)
}
