import { describe, expect, test } from 'bun:test'
import { launchLine, launchScript, parseLaunchArgs } from '../src/launch'

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

  test('скрипт: папка, окружение, env-файл агента и exec последней строкой', () => {
    const script = launchScript({
      dir: '/home/u/my project',
      env: { TELEGRAM_BINDING_KEYS: 'dm:7' },
      envFile: '/home/u/.claude/claude.env',
      argv: ['claude', '--model', 'opus[1m]', '--resume', 'abc'],
    })
    expect(script).toBe([
      "cd '/home/u/my project'",
      'export TELEGRAM_BINDING_KEYS=dm:7',
      'if [ -r /home/u/.claude/claude.env ]; then . /home/u/.claude/claude.env; fi',
      "exec claude --model 'opus[1m]' --resume abc",
      '',
    ].join('\n'))
  })
})
