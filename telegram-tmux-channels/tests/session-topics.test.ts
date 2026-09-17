// Страж 17.09: в списке «какую сессию поднять» было не понять, из какого топика каждая сессия,
// а после /unbind и повторного /bind связь терялась совсем.
import { describe, expect, test } from 'bun:test'
import { originKey, sessionChoices, telegramOrigin } from '../src/session-topics'
import { pickUserSnippet } from '../src/session-id'

describe('telegramOrigin', () => {
  test('тег канала Claude', () => {
    const text = '<channel source="telegram" chat_id="-1004495746357" message_id="3830" user="troman29" topic_id="2336">\nпривет\n</channel>'
    expect(telegramOrigin(text)).toEqual({ chatId: '-1004495746357', threadId: 2336 })
  })

  test('конверт Codex', () => {
    const text = '[Telegram message; delivery_id="d1" chat_id="-1003837420846" message_id="12592" topic_id="12592"]\nпривет'
    expect(telegramOrigin(text)).toEqual({ chatId: '-1003837420846', threadId: 12592 })
  })

  test('личка без топика и текст без конверта', () => {
    expect(originKey(telegramOrigin('<channel source="telegram" chat_id="1220362133" user="troman29">x</channel>')!)).toBe('dm:1220362133')
    expect(telegramOrigin('обычный промпт из терминала')).toBeUndefined()
  })
})

describe('pickUserSnippet', () => {
  test('топик берётся из первого сообщения с конвертом, подпись — из содержательного', () => {
    const user = (content: string) => JSON.stringify({ type: 'user', message: { content } })
    const got = pickUserSnippet([
      user('<channel source="telegram" chat_id="-100" topic_id="7">привет</channel>'),
      user('<channel source="telegram" chat_id="-100" topic_id="7">Разберись, почему воркер памяти молчит</channel>'),
    ])
    expect(got.origin).toEqual({ chatId: '-100', threadId: 7 })
    expect(got.meaningful).toBe('Разберись, почему воркер памяти молчит')
  })
})

describe('sessionChoices', () => {
  const titles: Record<string, string> = { '-100/9': 'Console: Org' }
  const session = (id: string, mtime: number, threadId?: number) => ({
    id, mtime, snippet: `сессия ${id}`, ...(threadId ? { origin: { chatId: '-100', threadId } } : {}),
  })

  test('сессии этого топика первыми, даже если соседние свежее', () => {
    const got = sessionChoices({
      sessions: [session('a', 300, 9), session('b', 200, 7), session('c', 100, 7)],
      key: '-100/7', index: {}, titleOf: key => titles[key], limit: 6,
    })
    expect(got.map(choice => choice.id)).toEqual(['b', 'c', 'a'])
    expect(got[0]!.label).toContain('📍')
    expect(got[2]!.label).toContain('«Console: Org»')
  })

  test('запись хаба сильнее конверта: сессию подняли в другом топике', () => {
    const got = sessionChoices({
      sessions: [session('a', 100, 9)], key: '-100/7', index: { a: '-100/7' }, titleOf: () => undefined, limit: 6,
    })
    expect(got[0]!.label).toContain('📍')
  })

  test('без топика — просто подпись, лимит соблюдается', () => {
    const got = sessionChoices({
      sessions: [session('a', 3), session('b', 2), session('c', 1)], key: '-100/7', index: {}, titleOf: () => undefined, limit: 2,
    })
    expect(got).toHaveLength(2)
    expect(got[0]!.label).not.toContain('«')
  })
})
