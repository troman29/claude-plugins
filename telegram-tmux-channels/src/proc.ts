// Cross-platform process introspection: Linux — /proc, macOS — ps/lsof.
// All functions are synchronous (the stub calls them at startup, before the event loop).
import { readFileSync, readlinkSync, readdirSync } from 'fs'
import type { AgentKind } from './agents/types'

const isLinux = process.platform === 'linux'

function ps(args: string[]): string {
  try {
    return Bun.spawnSync(['ps', ...args]).stdout.toString()
  } catch {
    return ''
  }
}

/** Process argv (not word-split when the OS hands back a single string). */
export function cmdlineOf(pid: number): string[] {
  if (isLinux) {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  }
  // macOS: ps returns the whole command line; split on spaces — good enough to
  // recognise claude and its flags (paths with spaces are rare here).
  const out = ps(['-o', 'command=', '-p', String(pid)]).trim()
  return out ? out.split(/\s+/) : []
}

/** Process ppid; 0/NaN if not found. */
export function parentPid(pid: number): number {
  if (isLinux) {
    // field 4 after the last ')' — comm may contain spaces/parens
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  }
  return Number(ps(['-o', 'ppid=', '-p', String(pid)]).trim())
}

/** Process cwd, or undefined. */
export function cwdOf(pid: number): string | undefined {
  try {
    if (isLinux) {
      return readlinkSync(`/proc/${pid}/cwd`)
    }
    // macOS: lsof -a -d cwd — "n<path>" line in -F format
    const out = Bun.spawnSync(['lsof', '-a', '-d', 'cwd', '-p', String(pid), '-Fn']).stdout.toString()
    const line = out.split('\n').find(l => l.startsWith('n'))
    return line ? line.slice(1) : undefined
  } catch {
    return undefined
  }
}

/** Read one inherited environment value. Codex sanitises MCP subprocess environments, so its
 * session stub falls back to the interactive Codex parent's environment. */
export function envOf(pid: number, key: string): string | undefined {
  if (!isLinux) {
    return undefined
  }
  try {
    const prefix = `${key}=`
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(v => v.startsWith(prefix))?.slice(prefix.length)
  } catch {
    return undefined
  }
}

/** All pids whose command is claude (system-wide). */
export function claudePids(): number[] {
  if (isLinux) {
    let entries: string[]
    try {
      entries = readdirSync('/proc')
    } catch {
      return []
    }
    const out: number[] = []
    for (const name of entries) {
      if (!/^\d+$/.test(name)) {
        continue
      }
      try {
        if (isClaudeArgv(cmdlineOf(Number(name)))) {
          out.push(Number(name))
        }
      } catch {} // process vanished mid-scan
    }
    return out
  }
  // macOS: pgrep by binary name
  const out = Bun.spawnSync(['pgrep', '-x', 'claude']).stdout.toString().trim()
  return out ? out.split('\n').map(Number).filter(Boolean) : []
}

// npm-installed claude runs as `node .../@anthropic-ai/claude-code/cli.js`, so cli.js has to
// count — but only when its own package dir is claude's. Plain `/cli.js` matched half the npm
// ecosystem (@playwright/test/cli.js among them) and got Playwright mistaken for a live session.
const CLAUDE_CLI_JS = /\/claude[^/]*\/cli\.js$/

export function isClaudeArgv(argv: string[]): boolean {
  return argv.some(
    a => a === 'claude' || a.endsWith('/claude') || CLAUDE_CLI_JS.test(a) || a.endsWith('\\claude.exe'),
  )
}

/** claude pids whose cwd == dir. Catches foreign sessions without channels too. */
export function claudePidsInDir(dir: string): number[] {
  return claudePids().filter(pid => cwdOf(pid) === dir)
}

/** Supported-agent processes in a directory, selected by the adapter's argv recognizer. */
export function agentPidsInDir(dir: string, matches: (argv: string[]) => boolean): number[] {
  if (!isLinux) {
    const out = Bun.spawnSync(['ps', '-axo', 'pid=']).stdout.toString()
    return out.split('\n').map(Number).filter(Boolean).filter(pid => {
      try { return matches(cmdlineOf(pid)) && cwdOf(pid) === dir } catch { return false }
    })
  }
  let entries: string[]
  try { entries = readdirSync('/proc') } catch { return [] }
  return entries.filter(v => /^\d+$/.test(v)).map(Number).filter(pid => {
    try { return matches(cmdlineOf(pid)) && cwdOf(pid) === dir } catch { return false }
  })
}

/** Walk up the process tree from the stub to the claude process. */
export function findClaudeAncestor(startPid: number): { pid: number; cmdline: string[] } | undefined {
  const found = findAgentAncestor(startPid)
  return found?.agent === 'claude' ? { pid: found.pid, cmdline: found.cmdline } : undefined
}

const CODEX_BIN_RE = /(?:^|[\\/])codex(?:\.exe)?$/

export function isCodexArgv(argv: string[]): boolean {
  return argv.some(a => a === 'codex' || CODEX_BIN_RE.test(a))
}

/** Walk from an MCP child to either supported interactive agent process. */
export function findAgentAncestor(
  startPid: number,
): { agent: AgentKind; pid: number; cmdline: string[] } | undefined {
  let pid = startPid
  for (let hops = 0; hops < 10 && pid > 1; hops++) {
    let cmdline: string[]
    try {
      cmdline = cmdlineOf(pid)
    } catch {
      return undefined
    }
    if (isClaudeArgv(cmdline)) return { agent: 'claude', pid, cmdline }
    if (isCodexArgv(cmdline)) return { agent: 'codex', pid, cmdline }
    const parent = parentPid(pid)
    if (!parent || parent === pid) {
      return undefined
    }
    pid = parent
  }
  return undefined
}
