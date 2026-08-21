import { describe, expect, test } from 'bun:test'
import { isHeldTooLong, isLivePaneKey, screenPollMs, uniqueByPane } from '../src/screen-poll'

describe('fast screen polling', () => {
  test('defaults to 300ms (5x faster than the legacy 1500ms)', () => {
    expect(screenPollMs(undefined)).toBe(300)
  })

  test('supports a bounded override', () => {
    expect(screenPollMs('500')).toBe(500)
    expect(screenPollMs('20')).toBe(100)
    expect(screenPollMs('oops')).toBe(300)
  })

  test('polls duplicate stub subscriptions for one pane only once', () => {
    const rows = [{ pane: '%1', id: 1 }, { pane: '%1', id: 2 }, { pane: '%2', id: 3 }]
    expect(uniqueByPane(rows).map(row => row.id)).toEqual([1, 3])
  })
})

describe('чистилка тика', () => {
  test('владеет только живыми пейнами, предстартовую цель сессии не трогает', () => {
    expect(isLivePaneKey('%12')).toBe(true)
    expect(isLivePaneKey('=homelab---100-42:')).toBe(false)
  })
})

describe('срок жизни придержанного сообщения', () => {
  const HOURS_6 = 6 * 60 * 60_000
  const now = 1_787_340_000_000

  test('свежее держим, четырёхдневное выбрасываем', () => {
    expect(isHeldTooLong(Math.floor((now - 60_000) / 1000), now, HOURS_6)).toBe(false)
    expect(isHeldTooLong(Math.floor((now - 4 * 24 * 3600_000) / 1000), now, HOURS_6)).toBe(true)
  })

  test('даты нет — не протухшее: «не знаю когда» не повод выбросить молча', () => {
    expect(isHeldTooLong(undefined, now, HOURS_6)).toBe(false)
  })
})
