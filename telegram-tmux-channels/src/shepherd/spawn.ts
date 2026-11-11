// Автоспавн сессии под PR без владельца: worktree на head-ветке PR, топик, биндинг.
// Саму сессию поднимает обычная доставка (revive по входящему): здесь только заготовка.
import { basename, dirname, join } from 'path'
import type { BindingEntry } from '../registry'
import type { ShepherdConfig, SpawnTarget } from './config'
import { findBranchHolder, normalizeRemote, type Exec } from './owner'
import type { ShepherdEvent } from './protocol'

export type SpawnResult =
  | { kind: 'spawned'; key: string }
  | { kind: 'busy'; dir: string }
  | { kind: 'limit' }
  | { kind: 'no-mapping' }
  | { kind: 'failed'; error: string }

export type SpawnDeps = {
  exec: Exec
  config: () => ShepherdConfig
  bindings: () => Record<string, BindingEntry>
  /** Доверенные группы хаба: chat id → папка проекта. */
  groups: () => Record<string, { dir?: string }>
  createTopic: (chat: string, title: string) => Promise<{ key: string }>
  /** Хаб дописывает tmux-имя, агента и cmdline группы. */
  saveBinding: (key: string, binding: BindingEntry) => Promise<void>
  log: (line: string) => void
}

export const MAX_LIVE_SPAWNED = 3
const TOPIC_TITLE_MAX_CHARS = 60

export function topicTitleFor(event: Pick<ShepherdEvent, 'repo' | 'pr' | 'prTitle'>): string {
  const prefix = `${event.repo.split('/')[1]} #${event.pr} `
  const room = TOPIC_TITLE_MAX_CHARS - prefix.length
  return prefix + (event.prTitle.length > room ? `${event.prTitle.slice(0, Math.max(room - 1, 0))}…` : event.prTitle)
}

// Папка как у хаба для голого worktree (dir-resolve.worktreeDirFor): сосед `<проект>--<ветка>`,
// иначе снос топика не опознает её как свою.
function worktreePath(baseDir: string, branch: string): string {
  return join(dirname(baseDir), `${basename(baseDir)}--${branch.replace(/\//g, '+')}`)
}

export async function findTarget(deps: SpawnDeps, repo: string): Promise<SpawnTarget | undefined> {
  const configured = deps.config().spawn[repo.toLowerCase()]
  if (configured) {
    return configured
  }
  for (const [chat, group] of Object.entries(deps.groups())) {
    if (!group.dir) {
      continue
    }
    const remote = await deps.exec(['git', '-C', group.dir, 'remote', 'get-url', 'origin']).catch(() => undefined)
    if (remote?.code === 0 && normalizeRemote(remote.stdout) === repo.toLowerCase()) {
      return { chat, dir: group.dir }
    }
  }
  return undefined
}

async function git(deps: SpawnDeps, dir: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return deps.exec(['git', '-C', dir, ...args])
}

async function addWorktree(deps: SpawnDeps, dir: string, headRef: string, path: string): Promise<void> {
  const fetched = await git(deps, dir, ['fetch', 'origin', headRef])
  if (fetched.code !== 0) {
    throw new Error(`git fetch origin ${headRef} failed`)
  }
  const local = await git(deps, dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${headRef}`])
  // Существующую локальную ветку не двигаем (-B/reset), только догоняем fast-forward'ом.
  const added = local.code === 0
    ? await git(deps, dir, ['worktree', 'add', path, headRef])
    : await git(deps, dir, ['worktree', 'add', '--track', '-b', headRef, path, `origin/${headRef}`])
  if (added.code !== 0) {
    throw new Error('git worktree add failed')
  }
  if (local.code === 0) {
    const merged = await git(deps, path, ['merge', '--ff-only', `origin/${headRef}`])
    if (merged.code !== 0) {
      deps.log(`shepherd: ${headRef} is not fast-forwardable to origin, left as is`)
    }
  }
}

export async function spawnForPr(deps: SpawnDeps, event: ShepherdEvent): Promise<SpawnResult> {
  const target = await findTarget(deps, event.repo)
  if (!target) {
    return { kind: 'no-mapping' }
  }
  try {
    const busy = await findBranchHolder(deps.exec, target.dir, event.headRef)
    if (busy) {
      return { kind: 'busy', dir: busy }
    }
    const live = Object.values(deps.bindings()).filter(binding => binding.spawned && !binding.closed).length
    if (live >= MAX_LIVE_SPAWNED) {
      return { kind: 'limit' }
    }
    const path = worktreePath(target.dir, event.headRef)
    await addWorktree(deps, target.dir, event.headRef, path)
    try {
      const { key } = await deps.createTopic(target.chat, topicTitleFor(event))
      await deps.saveBinding(key, { dir: path, mode: 'worktree-plain', spawned: true })
      return { kind: 'spawned', key }
    } catch (e) {
      await git(deps, target.dir, ['worktree', 'remove', '--force', path]).catch(() => undefined)
      throw e
    }
  } catch (e) {
    deps.log(`shepherd: spawn for ${event.repo}#${event.pr} failed: ${e instanceof Error ? e.stack : e}`)
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
