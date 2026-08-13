// Сценарии доставки — как наблюдаемое поведение, без привязки к реализации.
// Каждый из трёх сегодняшних багов ловится здесь и падал бы на этих тестах.
//
// Часы виртуальные: сторож ждёт 40 с двумя окнами, на реальном таймере тест шёл бы полторы
// минуты и моргал. Здесь sleep только двигает счётчик, весь набор проходит за миллисекунды.
import { describe, expect, test } from 'bun:test'
import { watchDelivery, type DeliveryDeps } from '../src/delivery'

/** Сессия с поддельным транскриптом.
 *
 * Два момента РАЗНЫЕ, и в этом вся суть третьего бага: `recordAt` — время, записанное
 * в самой записи, `visibleFrom` — когда сторож начинает её находить. В бою запись
 * появилась через 2 секунды, а увидели её сильно позже (первый проход искал не тот тип
 * записи). Проверка от момента переотправки такую запись отбрасывала как «слишком старую».
 */
function scenario(opts: { recordAt: number | null; visibleFrom?: number }) {
  let t = 0
  const sent: number[] = [t] // моменты отправок: первая — сразу
  const warnings: number[] = []
  const visibleFrom = opts.visibleFrom ?? opts.recordAt ?? 0
  const deps: DeliveryDeps = {
    clock: {
      now: () => t,
      sleep: async ms => { t += ms },
    },
    sawIncoming: (_dir, since, _needle) => {
      if (opts.recordAt === null) {
        return false
      }
      return t >= visibleFrom && opts.recordAt >= since
    },
    resend: () => { sent.push(t) },
    warn: async () => { warnings.push(t) },
    log: () => {},
  }
  return { deps, sent, warnings, at: () => sent[0]! }
}

describe('доставка сообщения в сессию', () => {
  test('сессия свободна: доставлено один раз, без предупреждений', async () => {
    const s = scenario({ recordAt: 1000 })
    const out = await watchDelivery(s.deps, 'chat/1', '/dir', 'привет', s.at())
    expect(out).toBe('landed')
    expect(s.sent.length).toBe(1)
    expect(s.warnings).toEqual([])
  })

  // Баг №1: занятая сессия пишет queue-operation, а не user-запись. Раньше сторож её не
  // видел вовсе — и вот этот сценарий давал бы 'lost'.
  test('сессия занята, запись появляется через 20 с: молча доставлено', async () => {
    const s = scenario({ recordAt: 20_000 })
    const out = await watchDelivery(s.deps, 'chat/1', '/dir', 'привет', s.at())
    expect(out).toBe('landed')
    expect(s.sent.length).toBe(1)
    expect(s.warnings).toEqual([])
  })

  // Баг №2: окно было 12 с — свежая сессия не успевала, и сторож бил тревогу по живому.
  test('сессия поднимается 35 с: без дубля и без тревоги', async () => {
    const s = scenario({ recordAt: 35_000 })
    const out = await watchDelivery(s.deps, 'chat/1', '/dir', 'привет', s.at())
    expect(out).toBe('landed')
    expect(s.sent.length).toBe(1)
    expect(s.warnings).toEqual([])
  })

  // Баг №3: повторная проверка считалась от момента переотправки, и запись, появившаяся
  // между попытками, отбрасывалась как «слишком старая» — тревога поверх дошедшего.
  test('запись появилась между попытками: тревоги нет', async () => {
    // запись ранняя (2 с), а увиделась только на 45-й секунде — ровно как в бою
    const s = scenario({ recordAt: 2000, visibleFrom: 45_000 })
    const out = await watchDelivery(s.deps, 'chat/1', '/dir', 'привет', s.at())
    expect(out).toBe('landed-after-retry')
    expect(s.sent.length).toBe(2) // одна переотправка — так и задумано
    expect(s.warnings).toEqual([])
  })

  test('сессия мертва: ровно одна переотправка и ровно одно предупреждение', async () => {
    const s = scenario({ recordAt: null })
    const out = await watchDelivery(s.deps, 'chat/1', '/dir', 'привет', s.at())
    expect(out).toBe('lost')
    expect(s.sent.length).toBe(2)
    expect(s.warnings.length).toBe(1)
  })
})
