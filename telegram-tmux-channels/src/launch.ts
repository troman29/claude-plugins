import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { shellQuote, type LaunchMode } from './tmux-ops'

export type LaunchRequest = { keys: string[]; mode: LaunchMode; sessionId?: string }

export type EnvFile = { path: string; required: boolean }
export type LaunchPlan = {
  dir: string
  env: Record<string, string>
  envFiles?: EnvFile[]
  unsetEnv?: string[]
  argv: string[]
  pathPrepend?: string
}

export const LAUNCHER = 'tgc-run'
const TOOLS = [LAUNCHER, 'tgc-ctl', 'gh']

/** Папка, куда installLauncher кладёт инструменты (в том числе `gh`-обёртку). */
export const launcherDir = (): string => join(homedir(), '.local', 'bin')
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
  const sourceFile = (path: string) => `set -a; . ${shellQuote([path])}; set +a`
  const envFileLines = (plan.envFiles ?? []).flatMap(file => file.required
    ? [
        `if [ ! -r ${shellQuote([file.path])} ]; then echo 'Required backend configuration is missing' >&2; exit 1; fi`,
        sourceFile(file.path),
      ]
    : [`if [ -r ${shellQuote([file.path])} ]; then ${sourceFile(file.path)}; fi`])
  const lines = [
    `cd ${shellQuote([plan.dir])}`,
    ...Object.entries(plan.env).map(([name, value]) => `export ${name}=${shellQuote([value])}`),
    ...(plan.pathPrepend ? [`export PATH=${shellQuote([plan.pathPrepend])}":$PATH"`] : []),
    ...envFileLines,
    ...(plan.unsetEnv?.length ? [`unset ${plan.unsetEnv.join(' ')}`] : []),
    `exec ${shellQuote(plan.argv)}`,
  ]
  return `${lines.join('\n')}\n`
}

/** Переводит dotenv-файл в settings-слой `<file>.settings.json` (права 600) и возвращает его путь. */
export function writeSettingsLayer(envFile: string): string {
  if (!existsSync(envFile)) {
    throw new Error('Required backend configuration is missing')
  }
  const env: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) {
      env[m[1]!] = m[2]!
    }
  }
  const layer = `${envFile}.settings.json`
  writeFileSync(layer, JSON.stringify({ env }), { mode: 0o600 })
  return layer
}

/** Кладёт `tgc-run`, `tgc-ctl` и обёртку `gh` в `~/.local/bin`: хаб печатает `tgc-run` голым именем, и шелл
 *  пейна ищет его в PATH; `tgc-ctl` — управление хабом с этой машины. */
export function installLauncher(log: (s: string) => void): void {
  for (const tool of TOOLS) {
    const source = join(import.meta.dir, '..', 'bin', tool)
    const link = join(launcherDir(), tool)
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
