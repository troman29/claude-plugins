import { describe, expect, test } from 'bun:test'
import { selectRestartTargets, summarizeRestarts } from '../src/restart-all'

const live = (pane: string, key?: string) => ({ pane, pid: 100, ...(key ? { bindingKeys: [key] } : {}) })

describe('/restart_all: выбор целей', () => {
  const bound = new Set(['a', 'b', 'c'])
  const isBound = (key: string) => bound.has(key)

  test('берёт сессии с биндингом, по одной на пейн', () => {
    const { targets } = selectRestartTargets([live('%1', 'a'), live('%1', 'a'), live('%2', 'b')], isBound, () => false)
    expect(targets.map(target => target.key)).toEqual(['a', 'b'])
  })

  test('сессии без биндинга не трогает и в итог не пишет', () => {
    const { targets, skipped } = selectRestartTargets([live('%1'), live('%2', 'gone')], isBound, () => false)
    expect(targets).toEqual([])
    expect(skipped).toEqual([])
  })

  test('поднимающийся биндинг и неопознанный процесс уходят в пропущенные', () => {
    const unknownProc = { pane: '%3', bindingKeys: ['c'] }
    const { targets, skipped } = selectRestartTargets([live('%1', 'a'), live('%2', 'b'), unknownProc], isBound, key => key === 'a')
    expect(targets.map(target => target.key)).toEqual(['b'])
    expect(skipped).toEqual(['a', 'c'])
  })
})

test('итог раскладывает исходы по корзинам', () => {
  const summary = summarizeRestarts(
    [
      { key: 'a', outcome: { kind: 'ready' } },
      { key: 'b', outcome: { kind: 'not-ready' } },
      { key: 'c', outcome: { kind: 'failed', error: new Error('boom') } },
    ],
    ['d'],
  )
  expect(summary).toEqual({ ready: ['a'], notReady: ['b'], failed: ['c'], skipped: ['d'] })
})
