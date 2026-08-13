// Хаб обязан импортироваться, ничего не запуская. Пока он при импорте занимал сокет, убивал
// чужой поллер и уходил в getUpdates, логику хаба нельзя было позвать из теста — отсюда 53 из 59
// fix-коммитов в один файл и пустая графа «гвард» в чек-листе регрессий.
// Проверяем в отдельном процессе: модульные эффекты кэшируются, вторым импортом их не поймать.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HUB = join(import.meta.dir, '..', 'src', 'hub.ts')

describe('hub.ts', () => {
  test('импорт ничего не запускает и процесс сам завершается', async () => {
    const state = mkdtempSync(join(tmpdir(), 'hub-import-'))
    const proc = Bun.spawn(['bun', '-e', `await import(${JSON.stringify(HUB)})`], {
      env: { ...process.env, TELEGRAM_STATE_DIR: state, TELEGRAM_BOT_TOKEN: '', TELEGRAM_ADMINS: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // висящий setInterval или открытый сокет не дали бы процессу закончиться
    const code = await Promise.race([
      proc.exited,
      new Promise<number>(r => setTimeout(() => { proc.kill(); r(-1) }, 20_000)),
    ])
    expect(code).toBe(0)
    expect(existsSync(join(state, 'hub.sock'))).toBe(false)
    expect(existsSync(join(state, 'bot.pid'))).toBe(false)
  }, 30_000)
})
