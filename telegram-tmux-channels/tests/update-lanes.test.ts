// Страж 15.09: `/delete` с хуком очистки 70 с держал весь бот — новый топик и сообщения в другие
// чаты приходили только после его конца.
import { describe, expect, test } from 'bun:test'
import { laneOf, Lanes } from '../src/update-lanes'

const gate = () => {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { open, opened }
}

describe('Lanes', () => {
  test('долгая задача одного топика не держит другой', async () => {
    const lanes = new Lanes()
    const slow = gate()
    const done: string[] = []
    void lanes.run('A', async () => { await slow.opened; done.push('A') })
    await lanes.run('B', async () => { done.push('B') })
    expect(done).toEqual(['B'])
    slow.open()
  })

  test('внутри топика — строго по порядку', async () => {
    const lanes = new Lanes()
    const first = gate()
    const done: string[] = []
    void lanes.run('A', async () => { await first.opened; done.push('1') })
    const second = lanes.run('A', async () => { done.push('2') })
    first.open()
    await second
    expect(done).toEqual(['1', '2'])
  })

  test('упавшая задача не рвёт полосу', async () => {
    const lanes = new Lanes()
    const failed = lanes.run('A', async () => { throw new Error('boom') })
    await expect(failed).rejects.toThrow('boom')
    let ran = false
    await lanes.run('A', async () => { ran = true })
    expect(ran).toBe(true)
  })

  test('отработавшая полоса не копится', async () => {
    const lanes = new Lanes()
    await lanes.run('A', async () => {})
    await Promise.resolve()
    expect(lanes.busyLanes).toBe(0)
  })
})

describe('laneOf', () => {
  const group = { id: -100, type: 'supergroup' }

  test('тап по кнопке — своя полоса топика, не за спиной у сообщений', () => {
    // пока /close ждёт выхода, на вопрос о фоновых задачах надо успеть ответить кнопкой
    const message = { chat: group, message_thread_id: 7 }
    expect(laneOf({ message })).toBe('-100/7')
    expect(laneOf({ callback_query: { message, from: { id: 1 } } })).toBe('tap:-100/7')
  })

  test('ответ на создание топика без thread id — всё равно этот топик', () => {
    const message = { chat: group, reply_to_message: { message_id: 7, forum_topic_created: {} } }
    expect(laneOf({ message })).toBe('-100/7')
  })

  test('личка — своя полоса на собеседника', () => {
    expect(laneOf({ message: { chat: { id: 42, type: 'private' } } })).toBe('dm:42')
  })
})
