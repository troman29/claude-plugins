// Resolve a working directory for an auto-topic binding, per trusted-group mode.
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import type { HookConfig, TrustedGroupMode } from './trusted-groups'
import { loadProjectConfig } from './project-config'

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: 'ignore' | 'inherit' } = {},
) {
  const proc = Bun.spawn(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { ok: (await proc.exited) === 0, out, err }
}

export async function gitBranch(dir: string): Promise<string | undefined> {
  const res = await run(['git', '-C', dir, 'branch', '--show-current'])
  const branch = res.ok ? res.out.trim() : ''
  return branch || undefined
}

export function worktreeDirFor(baseDir: string, branch: string): string {
  return join(dirname(baseDir), `${basename(baseDir)}--${branch.replace(/\//g, '+')}`)
}

/** Свободно ли имя: нет такой ветки И нет папки ворктри под неё. */
export async function branchNameTaken(baseDir: string, branch: string): Promise<boolean> {
  const ref = await run(['git', '-C', baseDir, 'rev-parse', '--verify', '--quiet', branch])
  return ref.ok || existsSync(worktreeDirFor(baseDir, branch))
}

/** Свободное имя ветки: занято — добавляем -2, -3, … (первое имя без суффикса).
 *
 * Имя топика уникальным не бывает: назвал новый топик как давно закрытый — и ветка та же.
 * Раньше ворктри молча вставал на СТАРУЮ ветку, и работа ложилась поверх её состояния —
 * так PR #773 уехал на базу месячной давности (703 коммита позади dev). Молчаливое
 * переиспользование чужой истории хуже лишней цифры в имени.
 */
export async function freeBranchName(baseDir: string, branch: string, limit = 50): Promise<string> {
  for (let n = 1; n <= limit; n++) {
    const candidate = n === 1 ? branch : `${branch}-${n}`
    if (!(await branchNameTaken(baseDir, candidate))) {
      return candidate
    }
  }
  throw new Error(`no free branch name for "${branch}" after ${limit} tries`)
}

export async function resolveWorktreeDir(baseDir: string, branch: string): Promise<string> {
  const dir = worktreeDirFor(baseDir, branch)
  // Всегда НОВАЯ ветка: имя сюда приходит уже свободным (freeBranchName), а вставать на
  // существующую — это и есть тот самый баг с чужой историей.
  const res = await run(['git', '-C', baseDir, 'worktree', 'add', '-b', branch, dir])
  if (!res.ok) {
    throw new Error(`git worktree add failed: ${(res.err || res.out).trim()}`)
  }
  return dir
}

function fillTemplate(template: string, branch: string, dir: string): string {
  return template.replaceAll('{branch}', branch).replaceAll('{dir}', dir)
}

async function runHookCommand(template: string, branch: string, groupDir: string) {
  const cmd = fillTemplate(template, branch, groupDir)
  return run(['sh', '-c', cmd], {
    cwd: groupDir,
    stdin: 'ignore', // forces non-interactive defaults (isatty()===false) — no hang on a prompt
    env: { ...process.env, TELEGRAM_TOPIC_BRANCH: branch, TELEGRAM_GROUP_DIR: groupDir },
  })
}

export async function resolveHookDir(hook: HookConfig, branch: string, groupDir: string): Promise<string> {
  const res = await runHookCommand(hook.create, branch, groupDir)
  if (!res.ok) {
    throw new Error(`hook create failed: ${(res.err || res.out).trim()}`)
  }
  const lines = res.out.trim().split('\n').filter(Boolean)
  const dir = lines[lines.length - 1]?.trim()
  if (!dir) {
    throw new Error('hook create printed no path')
  }
  return dir
}

export async function runHookDelete(hook: HookConfig, branch: string, groupDir: string): Promise<void> {
  if (!hook.delete) {
    return
  }
  const res = await runHookCommand(hook.delete, branch, groupDir)
  if (!res.ok) {
    throw new Error(`hook delete failed: ${(res.err || res.out).trim()}`)
  }
}

// True only for a linked worktree (its git-dir lives under <main>/.git/worktrees/…) — false for the
// main checkout and for a plain folder binding. Gates every destructive teardown: a folder binding
// points at the main repo, and running a worktree-removal hook there would tear down the real work.
export async function isLinkedWorktree(dir: string): Promise<boolean> {
  const gd = await run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir'])
  return gd.ok && gd.out.includes('/worktrees/')
}

// Remove a plain `git worktree add` worktree (the no-hook case). Runs from the main repo so git won't
// refuse "current worktree". --force drops uncommitted changes (the topic/worktree is being deleted anyway).
export async function removePlainWorktree(dir: string): Promise<boolean> {
  if (!(await isLinkedWorktree(dir))) {
    return false // not a linked worktree — nothing to remove
  }
  const common = await run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const mainRepo = common.ok ? dirname(common.out.trim()) : dir
  const res = await run(['git', '-C', mainRepo, 'worktree', 'remove', '--force', dir])
  if (!res.ok) {
    throw new Error(`git worktree remove failed: ${(res.err || res.out).trim()}`)
  }
  return true
}

// Take the worktree hook from the project's `.tmux-channels.json` if present: config next to the
// repo wins over the group's (one group — many folders, each with its own commands).
// THE ONLY place that decides which hook applies — never read `group.hook` directly, or create and
// delete disagree: a group without `hook` but a project WITH one created via the project hook and
// then tore down with a plain `git worktree remove`, silently skipping the hook's cleanup.
export function worktreeHook(baseDir: string, groupHook: HookConfig | undefined): HookConfig | undefined {
  return loadProjectConfig(baseDir)?.worktree ?? groupHook
}

// Returns the resolved dir AND the hook that produced it, so the caller records teardown state from
// the same decision instead of re-deriving it.
export async function resolveModeDir(
  mode: TrustedGroupMode,
  baseDir: string,
  hook: HookConfig | undefined,
  branch: string,
): Promise<{ dir: string; hook: HookConfig | undefined; branch: string }> {
  if (mode === 'folder') {
    return { dir: baseDir, hook: undefined, branch }
  }
  // Развод имён — здесь, а не у вызывающего: точка одна, обойти её нельзя. Хук тоже получает
  // уже свободное имя — он режет ветку сам и про занятость знать не обязан.
  const free = await freeBranchName(baseDir, branch)
  // worktree mode: a configured hook replaces plain `git worktree add` (e.g. a wrapper
  // that also provisions a per-branch DB) — no hook, no customization needed, just git.
  const h = worktreeHook(baseDir, hook)
  return {
    dir: h ? await resolveHookDir(h, free, baseDir) : await resolveWorktreeDir(baseDir, free),
    hook: h,
    branch: free,
  }
}

// Stand command from the binding folder's `.tmux-channels.json`. Returns the run result or undefined
// if the project has no such command (in which case there should be no chat buttons/commands either).
export async function runStandCommand(
  dir: string,
  kind: 'up' | 'down' | 'status',
): Promise<{ ok: boolean; out: string; err: string } | undefined> {
  const cmd = loadProjectConfig(dir)?.stand?.[kind]
  if (!cmd) {
    return undefined
  }
  const branch = (await gitBranch(dir)) ?? ''
  return run(['sh', '-c', fillTemplate(cmd, branch, dir)], {
    cwd: dir,
    stdin: 'ignore',
    env: { ...process.env, TELEGRAM_TOPIC_BRANCH: branch, TELEGRAM_PROJECT_DIR: dir },
  })
}
