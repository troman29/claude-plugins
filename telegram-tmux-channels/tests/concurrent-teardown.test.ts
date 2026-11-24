import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hubPath = join(import.meta.dir, '../src/hub.ts')

test.each([false, true])('concurrent teardown preserves sibling registry updates (shared directory: %s)', async (shared) => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-teardown-'))
  try {
    const state = join(root, 'state')
    const project = join(root, 'project')
    const bin = join(root, 'bin')
    const first = { dir: join(root, 'first'), mode: 'worktree', hookBranch: 'first', tmux: 'first' }
    const secondDir = shared ? first.dir : join(root, 'second')
    const secondBranch = shared ? 'first' : 'second'
    const second = { dir: secondDir, mode: 'worktree', hookBranch: secondBranch, tmux: 'second' }
    const other = { dir: project }
    for (const dir of new Set([state, project, bin, first.dir, secondDir])) mkdirSync(dir)
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const bindingsFile = join(state, 'bindings.json')
    const cleanupLog = join(root, 'cleaned')
    writeFileSync(bindingsFile, JSON.stringify({ '-100/1': first, '-100/2': second, '-100/3': other }))
    const hook = join(root, 'delete.sh')
    const waitForBoth = shared ? '' : [
      'for i in 1 2 3 4 5 6 7 8 9 10; do',
      '  if [ -f "$TELEGRAM_STATE_DIR/first" ] && [ -f "$TELEGRAM_STATE_DIR/second" ]; then break; fi',
      '  sleep 0.1',
      'done',
      '[ -f "$TELEGRAM_STATE_DIR/first" ] && [ -f "$TELEGRAM_STATE_DIR/second" ] || exit 1',
    ].join('\n')
    writeFileSync(hook, [
      '#!/bin/sh',
      'set -eu',
      'touch "$TELEGRAM_STATE_DIR/$1"',
      waitForBoth,
      'printf "%s\\n" "$1" >> "$TELEGRAM_STATE_DIR/../cleaned"',
    ].join('\n'))
    writeFileSync(join(state, 'trusted-groups.json'), JSON.stringify({
      groups: { '-100': { dir: project, hook: { create: 'true', delete: 'sh ../delete.sh {branch}' } } },
    }))

    const script = 'const { teardownBinding } = await import(' + JSON.stringify(hubPath) + ');'
      + 'const results = await Promise.all([teardownBinding("-100/1", ' + JSON.stringify(first)
      + '), teardownBinding("-100/2", ' + JSON.stringify(second) + ')]);'
      + 'if (results.some(result => result.failed)) throw new Error(JSON.stringify(results));'
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: {
        ...process.env, PATH: bin + ':/usr/bin:/bin', TELEGRAM_STATE_DIR: state,
        TELEGRAM_BOT_TOKEN: '123456789:TEST', TELEGRAM_DEBUG_LOG: '0',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    expect(JSON.parse(readFileSync(bindingsFile, 'utf8'))).toEqual({ '-100/3': other })
    expect(readFileSync(cleanupLog, 'utf8').trim().split('\n').sort()).toEqual(shared ? ['first'] : ['first', 'second'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
