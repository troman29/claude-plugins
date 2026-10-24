import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { shellQuote, type LaunchMode } from './tmux-ops'

export type LaunchRequest = { keys: string[]; mode: LaunchMode; sessionId?: string }

export type LaunchPlan = { dir: string; env: Record<string, string>; envFile?: string; argv: string[] }

export const LAUNCHER = 'tgc-run'
const TOOLS = [LAUNCHER, 'tgc-ctl']
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

/** Кладёт `tgc-run` и `tgc-ctl` в `~/.local/bin`: хаб печатает `tgc-run` голым именем, и шелл
 *  пейна ищет его в PATH; `tgc-ctl` — управление хабом с этой машины. */
export function installLauncher(log: (s: string) => void): void {
  for (const tool of TOOLS) {
    const source = join(import.meta.dir, '..', 'bin', tool)
    const link = join(homedir(), '.local', 'bin', tool)
    const current = lstatSync(link, { throwIfNoEntry: false })
    if (current?.isSymbolicLink() && readlinkSync(link) === source) {
      continue
    }
    if (current) {
      rmSync(link)
    }
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(source, link)
    log(`launcher: ${link} → ${source}`)
  }
}
