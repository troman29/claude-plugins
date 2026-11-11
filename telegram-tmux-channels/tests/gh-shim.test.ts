import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { launchScript } from '../src/launch'
import { tempDir } from './shepherd-helpers'

const SHIM = join(import.meta.dir, '..', 'bin', 'gh')
const URL_ = 'https://github.com/windbit/agentek-deploy/pull/77'

/** Настоящий gh подделан: печатает заданный вывод и выходит с заданным кодом; tgc-ctl пишет аргументы в файл. */
function sandbox(real: { stdout?: string; stderr?: string; code?: number }) {
  const root = tempDir()
  const bin = join(root, 'real')
  const shimDir = join(root, 'shim')
  mkdirSync(bin)
  mkdirSync(shimDir)
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  writeFileSync(join(root, 'out'), real.stdout ?? '')
  writeFileSync(join(root, 'err'), real.stderr ?? '')
  script(join(bin, 'gh'), `printf '%s' "$*" > "${root}/gh.args"\ncat > "${root}/gh.stdin"\ncat "${root}/out"\ncat "${root}/err" >&2\nexit ${real.code ?? 0}`)
  script(join(bin, 'tgc-ctl'), `printf '%s\\n' "$*" >> "${root}/ctl.calls"\nexit \${CTL_EXIT:-0}`)
  script(join(shimDir, 'gh'), readFileSync(SHIM, 'utf8').split('\n').slice(1).join('\n'))
  const run = async (args: string[], env: Record<string, string> = {}, stdin = '') => {
    const proc = Bun.spawn(['sh', join(shimDir, 'gh'), ...args], {
      env: { PATH: `${shimDir}:${bin}:/usr/bin:/bin`, TELEGRAM_BINDING_KEYS: '-100/42', ...env },
      stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { stdout, stderr, code }
  }
  const calls = () => (existsSync(`${root}/ctl.calls`) ? readFileSync(`${root}/ctl.calls`, 'utf8').trim().split('\n') : [])
  return { run, calls, read: (name: string) => readFileSync(`${root}/${name}`, 'utf8') }
}

describe('gh shim', () => {
  test('gh pr create: output untouched, owner registered with the PR url', async () => {
    const box = sandbox({ stdout: `Creating pull request...\n${URL_}\n`, stderr: 'warn: x\n' })
    const result = await box.run(['pr', 'create', '--title', 'a b', '--body', 'x'])
    expect(result).toEqual({ stdout: `Creating pull request...\n${URL_}\n`, stderr: 'warn: x\n', code: 0 })
    expect(box.read('gh.args')).toBe('pr create --title a b --body x')
    expect(box.calls()).toEqual([`pr-own ${URL_}`])
  })

  test('the last PR url wins when gh prints extra lines and links', async () => {
    const box = sandbox({ stdout: `see https://github.com/windbit/agentek-deploy/issues/3 and\nhttps://github.com/windbit/other/pull/1\n\n${URL_}\n` })
    await box.run(['pr', 'create'])
    expect(box.calls()).toEqual([`pr-own ${URL_}`])
  })

  test('a failing gh keeps its exit code and nothing is registered', async () => {
    const box = sandbox({ stdout: URL_ + '\n', stderr: 'boom\n', code: 3 })
    const result = await box.run(['pr', 'create'])
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('boom\n')
    expect(box.calls()).toEqual([])
  })

  test('other subcommands pass through untouched, stdin included', async () => {
    const box = sandbox({ stdout: `${URL_}\n`, code: 1 })
    const result = await box.run(['pr', 'view', '5'], {}, 'input-data')
    expect(result.code).toBe(1)
    expect(result.stdout).toBe(`${URL_}\n`)
    expect(box.read('gh.stdin')).toBe('input-data')
    expect(box.calls()).toEqual([])
  })

  test('a failing registration never changes gh output or exit code', async () => {
    const box = sandbox({ stdout: `${URL_}\n` })
    const result = await box.run(['pr', 'create'], { CTL_EXIT: '1' })
    expect(result).toEqual({ stdout: `${URL_}\n`, stderr: '', code: 0 })
    const debug = await box.run(['pr', 'create'], { CTL_EXIT: '1', TGC_GH_SHIM_DEBUG: '1' })
    expect(debug.stderr).toContain('pr-own failed')
    expect(debug.code).toBe(0)
  })

  test('outside a hub session (no binding keys) nothing is registered', async () => {
    const box = sandbox({ stdout: `${URL_}\n` })
    const result = await box.run(['pr', 'create'], { TELEGRAM_BINDING_KEYS: '' })
    expect(result.code).toBe(0)
    expect(box.calls()).toEqual([])
  })

  test('hub-launched sessions get the launcher dir first on PATH', () => {
    const script = launchScript({ dir: '/w', env: {}, argv: ['claude'], pathPrepend: '/home/u/.local/bin' })
    expect(script).toContain('export PATH=/home/u/.local/bin":$PATH"')
    expect(launchScript({ dir: '/w', env: {}, argv: ['claude'] })).not.toContain('PATH')
  })
})
