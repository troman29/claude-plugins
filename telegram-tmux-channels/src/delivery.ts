// Сторож доставки: убедиться, что отправленное сообщение действительно попало в сессию,
// один раз переотправить, и только потом сказать вслух, что оно потеряно.
//
// Живёт отдельно от hub.ts и общается с миром через порты, потому что именно этот узел
// ломался трижды за сутки, и каждый раз — на границе с чужой системой (когда Claude Code
// пишет в транскрипт, как быстро поднимается сессия, от какого момента считать окно).
// Проверить такое на живых tmux и Telegram нельзя: тест ждал бы реальные 40 секунд и моргал.
// С портами часы виртуальные, и весь сценарий проходит за миллисекунды.

export type Clock = {
  now(): number
  sleep(ms: number): Promise<void>
}

export type DeliveryDeps = {
  clock: Clock
  /** Видел ли транскрипт сессии это входящее после момента `since`. */
  sawIncoming(dir: string, since: number, needle: string): boolean
  /** Отправить payload в сессию ещё раз (в бою — запись в сокеты стаба). */
  resend(): void
  /** Сказать пользователю, что сообщение не дошло. */
  warn(): Promise<void>
  log(s: string): void
}

/** ~40 с: свежая сессия ещё дорисовывает баннер и крутит SessionStart-хуки. */
export const ACK_TRIES = 40
const ACK_STEP_MS = 1000

export type DeliveryOutcome = 'landed' | 'landed-after-retry' | 'lost'

async function landed(d: DeliveryDeps, dir: string, since: number, needle: string): Promise<boolean> {
  for (let i = 0; i < ACK_TRIES; i++) {
    await d.clock.sleep(ACK_STEP_MS)
    if (d.sawIncoming(dir, since, needle)) {
      return true
    }
  }
  return false
}

export async function watchDelivery(
  d: DeliveryDeps, key: string, dir: string, needle: string, at: number,
): Promise<DeliveryOutcome> {
  if (await landed(d, dir, at, needle)) {
    return 'landed'
  }
  d.log(`delivery: ${key} — сообщения нет в транскрипте, переотправляю`)
  d.resend()
  // Считаем от ПЕРВОЙ отправки, а не от повторной: запись, появившаяся между попытками,
  // — это доставка, а не потеря. Окно от момента переотправки её отбрасывало (запись
  // оказывалась «слишком старой») и рождало ложную тревогу поверх дошедшего сообщения.
  if (await landed(d, dir, at, needle)) {
    return 'landed-after-retry'
  }
  d.log(`delivery: ${key} — сообщение так и не дошло до сессии`)
  await d.warn()
  return 'lost'
}
