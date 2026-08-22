import { rmSync } from 'fs'

export function rmQuiet(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {} // best-effort cleanup
}

export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch (e) {
    if (e instanceof SyntaxError) {
      return undefined
    }
    throw e
  }
}

/** Порядок доставки — по времени ОТПРАВКИ (секунды Telegram), а не по тому, как сообщения
 *  попали обратно в очередь: неотданное возвращается туда позже пришедшего следом. Даты нет —
 *  считаем самым старым: оно уже лежало в очереди. Сортировка стабильная, ровесники не меняются
 *  местами. */
export function bySendTime<T>(messages: T[], dateOf: (m: T) => number | undefined): T[] {
  return [...messages].sort((a, b) => (dateOf(a) ?? 0) - (dateOf(b) ?? 0))
}
