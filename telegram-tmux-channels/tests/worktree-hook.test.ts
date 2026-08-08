// The bug this guards: create resolved the hook via worktreeHook() (project config wins) but flagged
// the binding from the raw group hook. A group without `hook` + a project WITH one → worktree created
// by the hook, torn down by plain `git worktree remove` → wt.py rm never ran → claude-mem memory of
// every such worktree stayed stranded under `<repo>/<slug>`.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveModeDir, worktreeHook } from '../src/dir-resolve'

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
    expect(await resolveModeDir('folder', dir, groupHook, 'feat/x')).toEqual({ dir, hook: undefined })
  })
})
