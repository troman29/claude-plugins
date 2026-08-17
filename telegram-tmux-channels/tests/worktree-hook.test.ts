// The bug this guards: create resolved the hook via worktreeHook() (project config wins) but flagged
// the binding from the raw group hook. A group without `hook` + a project WITH one → worktree created
// by the hook, torn down by plain `git worktree remove` → wt.py rm never ran → claude-mem memory of
// every such worktree stayed stranded under `<repo>/<slug>`.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveModeDir, worktreeHook, freeBranchName, worktreeDirFor } from '../src/dir-resolve'

const projectHook = { create: 'echo project-create', delete: 'echo project-delete' }
const groupHook = { create: 'echo group-create', delete: 'echo group-delete' }

function projectDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-hook-'))
  if (config) {
    writeFileSync(join(dir, '.tmux-channels.json'), JSON.stringify(config))
  }
  return dir
}

describe('worktreeHook', () => {
  test('project config wins over the group hook', () => {
    expect(worktreeHook(projectDir({ worktree: projectHook }), groupHook)).toEqual(projectHook)
  })
  test('falls back to the group hook when the project has none', () => {
    expect(worktreeHook(projectDir(), groupHook)).toEqual(groupHook)
  })
  test('project hook applies even when the group has NO hook — the case that broke teardown', () => {
    expect(worktreeHook(projectDir({ worktree: projectHook }), undefined)).toEqual(projectHook)
  })
})

describe('resolveModeDir returns the hook it actually used', () => {
  test('group without a hook + project with one → hook returned, so the binding gets flagged', async () => {
    const dir = projectDir({ worktree: { create: 'echo /tmp/made-by-project-hook', delete: 'true' } })
    const res = await resolveModeDir('worktree', dir, undefined, 'feat/x')
    expect(res.dir).toBe('/tmp/made-by-project-hook')
    expect(res.hook).toBeDefined() // ← was undefined at the call site before the fix
  })

  test('folder mode never reports a hook — teardown must not run one on the main repo', async () => {
    const dir = projectDir({ worktree: projectHook })
    expect(await resolveModeDir('folder', dir, groupHook, 'feat/x')).toEqual({
      dir, hook: undefined, branch: 'feat/x',
    })
  })
})

// Баг 2026-08-17: топик назвали как давно закрытый, ворктри встал на СТАРУЮ ветку того имени,
// и работа легла поверх её состояния — PR уехал на базу месячной давности (703 коммита позади).
describe('имя ветки при совпадении топиков', () => {
  const git = (dir: string, ...args: string[]) =>
    Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wt-branch-'))
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'user.email', 't@t')
    git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'f.txt'), 'x')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
    return dir
  }

  test('свободное имя берём как есть', async () => {
    expect(await freeBranchName(repo(), 'feat-x')).toBe('feat-x')
  })

  test('занятое ветками — уходим в -2, -3', async () => {
    const dir = repo()
    git(dir, 'branch', 'feat-x')
    expect(await freeBranchName(dir, 'feat-x')).toBe('feat-x-2')
    git(dir, 'branch', 'feat-x-2')
    expect(await freeBranchName(dir, 'feat-x')).toBe('feat-x-3')
  })

  test('ветки нет, но папка ворктри осталась — тоже занято', async () => {
    const dir = repo()
    mkdirSync(worktreeDirFor(dir, 'feat-x'), { recursive: true })
    expect(await freeBranchName(dir, 'feat-x')).toBe('feat-x-2')
  })

  test('resolveModeDir отдаёт РЕАЛЬНО созданную ветку, а не запрошенную', async () => {
    const dir = repo()
    git(dir, 'branch', 'feat-x') // имя занято прошлым топиком
    const res = await resolveModeDir('worktree', dir, undefined, 'feat-x')
    expect(res.branch).toBe('feat-x-2')
    // и это НОВАЯ ветка от текущей базы, а не переиспользованная старая
    expect(git(res.dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.toString().trim()).toBe('feat-x-2')
  })
})
