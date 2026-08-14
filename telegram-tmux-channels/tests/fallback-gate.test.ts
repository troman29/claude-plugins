// Досылка ответа — сценариями, как её видит пользователь.
// Баг 2026-08-14 (воспроизведён на стенде): агент ответил через reply, пользователь дописал
// строку, пока ход ещё шёл, — и в конце хода прилетала простыня, пересказывающая отправленное.
import { describe, expect, test } from 'bun:test'
import { FallbackGate } from '../src/fallback-gate'

const KEY = 'chat/1'

describe('досылка финального текста', () => {
  test('агент промолчал в Telegram — досылаем', () => {
    const g = new FallbackGate()
    expect(g.shouldForward(KEY)).toBe(true)
  })

  test('агент ответил — не досылаем', () => {
    const g = new FallbackGate()
    g.noteAnswered(KEY)
    expect(g.shouldForward(KEY)).toBe(false)
  })

  // Собственно баг: второе сообщение внутри хода заново взводило ожидание ответа,
  // и досылка срабатывала поверх уже отправленного.
  test('ответ, затем дописанное в тот же ход — по-прежнему не досылаем', () => {
    const g = new FallbackGate()
    g.noteAnswered(KEY) // агент ответил
    // …пользователь дописал ещё сообщение, ход не кончился — ответа на него уже не будет
    expect(g.shouldForward(KEY)).toBe(false)
  })

  test('следующий ход начинается с чистого листа', () => {
    const g = new FallbackGate()
    g.noteAnswered(KEY)
    g.endTurn(KEY)
    expect(g.shouldForward(KEY)).toBe(true) // в новом ходе агент ещё ничего не сказал
  })

  test('ходы соседних биндингов не влияют друг на друга', () => {
    const g = new FallbackGate()
    g.noteAnswered('chat/1')
    expect(g.shouldForward('chat/2')).toBe(true)
    g.endTurn('chat/2')
    expect(g.shouldForward('chat/1')).toBe(false) // чужой конец хода нашу метку не снимает
  })
})
