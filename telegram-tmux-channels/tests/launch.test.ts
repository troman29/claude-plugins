import { readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { launchLine, launchScript, parseLaunchArgs, writeSettingsLayer } from '../src/launch'
import { tempDir } from './shepherd-helpers'

describe('tgc-run', () => {
  test('хаб печатает в пейн одну короткую строку', () => {
    expect(launchLine({ keys: ['-1001234567890/447'], mode: 'resume', sessionId: 'cf3d-1' }))
      .toBe('tgc-run -1001234567890/447 resume cf3d-1')
    expect(launchLine({ keys: ['dm:7', 'dm:8'], mode: 'new' })).toBe('tgc-run dm:7,dm:8 new')
  })

  test('аргументы разбираются обратно в тот же запрос', () => {
    expect(parseLaunchArgs(['dm:7,dm:8', 'fork', 'abc'])).toEqual({ keys: ['dm:7', 'dm:8'], mode: 'fork', sessionId: 'abc' })
    expect(parseLaunchArgs(['dm:7', 'new'])).toEqual({ keys: ['dm:7'], mode: 'new' })
  })

  test('неизвестный режим и лишние аргументы — ошибка, а не запуск наугад', () => {
    expect(() => parseLaunchArgs(['dm:7', 'continue'])).toThrow('usage')
    expect(() => parseLaunchArgs(['dm:7', 'resume', 'a', 'b'])).toThrow('usage')
    expect(() => parseLaunchArgs([])).toThrow('usage')
  })

  test('скрипт: папка, окружение, env-файлы агента и exec последней строкой', () => {
    const script = launchScript({
      dir: '/home/u/my project',
      env: { TELEGRAM_BINDING_KEYS: 'dm:7' },
      envFiles: [
        { path: '/home/u/.claude/claude.env', required: false },
        { path: '/home/u/.claude/backends/chatgpt.env', required: true },
      ],
      argv: ['claude', '--model', 'opus[1m]', '--resume', 'abc'],
    })
    expect(script).toBe([
      "cd '/home/u/my project'",
      'export TELEGRAM_BINDING_KEYS=dm:7',
      'if [ -r /home/u/.claude/claude.env ]; then set -a; . /home/u/.claude/claude.env; set +a; fi',
      'if [ ! -r /home/u/.claude/backends/chatgpt.env ]; then echo \'Required backend configuration is missing\' >&2; exit 1; fi',
      'set -a; . /home/u/.claude/backends/chatgpt.env; set +a',
      "exec claude --model 'opus[1m]' --resume abc",
      '',
    ].join('\n'))
  })

  test('скрипт удаляет переменные другого провайдера после общих env-файлов', () => {
    const script = launchScript({
      dir: '/work',
      env: {},
      envFiles: [{ path: '/home/u/.claude/claude.env', required: false }],
      unsetEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
      argv: ['claude'],
    })

    expect(script).toContain('unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN\nexec claude')
  })

  test('env-файл подключается с allexport для обычных KEY=value', () => {
    const script = launchScript({
      dir: '/work',
      env: {},
      envFiles: [{ path: '/provider.env', required: true }],
      argv: ['sh', '-c', 'test "$PROVIDER_KEY" = secret'],
    })

    expect(script).toContain('set -a; . /provider.env; set +a')
  })
})

describe('writeSettingsLayer', () => {
  test('turns a dotenv backend file into a private settings layer', () => {
    const envFile = join(tempDir(), 'chatgpt.env')
    writeFileSync(envFile, '# sub2api\nANTHROPIC_BASE_URL=http://127.0.0.1:8791\nANTHROPIC_AUTH_TOKEN=sk-test\n')
    const layer = writeSettingsLayer(envFile)
    expect(JSON.parse(readFileSync(layer, 'utf8'))).toEqual({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8791', ANTHROPIC_AUTH_TOKEN: 'sk-test' },
    })
    expect(statSync(layer).mode & 0o777).toBe(0o600)
  })

  test('missing backend file fails the launch', () => {
    expect(() => writeSettingsLayer(join(tempDir(), 'absent.env'))).toThrow('Required backend configuration is missing')
  })
})
