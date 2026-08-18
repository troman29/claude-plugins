import { describe, expect, test } from 'bun:test'
import { screenPollMs, uniqueByPane } from '../src/screen-poll'

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
