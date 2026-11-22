import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hubPath = join(import.meta.dir, '../src/hub.ts')

test('native startup scan, idle unload and topic teardown never touch tmux or project files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-lifecycle-'))
  const state = join(directory, 'state')
  const project = join(directory, 'project')
  const bin = join(directory, 'bin')
  mkdirSync(state)
  mkdirSync(project)
  mkdirSync(bin)
  const sentinel = join(project, 'keep.txt')
  const invoked = join(directory, 'unexpected-command')
  writeFileSync(sentinel, 'keep')
  const fakeCommand = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${invoked}'\nexit 1\n`
  for (const name of ['tmux', 'git']) {
    writeFileSync(join(bin, name), fakeCommand, { mode: 0o700 })
  }
  const binding = { dir: project, tmux: 'must-not-touch', mode: 'worktree', hookBranch: 'must-not-delete',
    dsh: { runtime: 'test', profile: 'test', sessionId: 'test', capability: 'a'.repeat(64) } }
  writeFileSync(join(state, 'bindings.json'), JSON.stringify({ '-100/42': binding }))
  const script = `
    const { scanPrestartPanes, maybeIdleUnload, teardownBinding } = await import(${JSON.stringify(hubPath)});
    const binding = ${JSON.stringify(binding)};
    await scanPrestartPanes();
    await maybeIdleUnload({pane:'%1',pid:999999,cwd:binding.dir,bindingKeys:['-100/42']}, false);
    const outcome = await teardownBinding('-100/42', binding);
    if (outcome.failed) throw new Error('detach failed');
  `
  try {
    const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env,
      TELEGRAM_STATE_DIR: state, TELEGRAM_BOT_TOKEN: '123456789:TEST', TELEGRAM_DEBUG_LOG: '0', PATH: bin,
    }, stdout: 'pipe', stderr: 'pipe' })
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    expect(existsSync(invoked)).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
    expect(JSON.parse(readFileSync(join(state, 'bindings.json'), 'utf8'))).toEqual({})
  } finally {
    // directory is the exact mkdtemp fixture root allocated above.
    rmSync(directory, { recursive: true, force: true })
  }
})
