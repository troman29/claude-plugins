// Топик — единственная точка сборки поля Telegram. Раньше эта тернарка была скопирована
// в 19 мест: забыть её в одном вызове = ответ уезжает в General вместо своего топика.
import { describe, expect, test } from 'bun:test'
import { topic } from '../src/chat'

describe('topic()', () => {
  test('топик задан — поле появляется', () => {
    expect(topic(42)).toEqual({ message_thread_id: 42 })
  })
  // General в форуме имеет id 1 — числовое ложное значение тут нет, а 0 не должен теряться
  test('нулевой и первый топик не теряются', () => {
    expect(topic(0)).toEqual({ message_thread_id: 0 })
    expect(topic(1)).toEqual({ message_thread_id: 1 })
  })
  test('топика нет — поля нет вовсе, а не undefined в нём', () => {
    expect(topic(undefined)).toEqual({})
    expect(topic(null)).toEqual({})
    expect('message_thread_id' in topic(undefined)).toBe(false)
  })
  test('результат разворачивается в опции сообщения', () => {
    expect({ ...topic(7), parse_mode: 'HTML' }).toEqual({ message_thread_id: 7, parse_mode: 'HTML' })
    expect({ ...topic(undefined), parse_mode: 'HTML' }).toEqual({ parse_mode: 'HTML' })
  })
})
