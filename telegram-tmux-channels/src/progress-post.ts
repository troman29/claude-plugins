export type ProgressTransport = {
  send: (text: string) => Promise<number | undefined>
  edit: (msgId: number, text: string) => Promise<void>
}

/**
 * Один пост на всю операцию: шаги ДОПИСЫВАЮТСЯ в него, а не сыплются отдельными сообщениями.
 *
 * Зачем не EditablePost: тот держит долгоживущий пост биндинга (статус, фон) с восстановлением
 * id после рестарта. Здесь другое — короткий поток шагов внутри одной операции, переживать
 * рестарт ему незачем, а вот порядок строк важен.
 *
 * step() не ждут: сеть сериализуется внутри, поэтому вызывающему коду не надо тащить await
 * через всю цепочку. Шаги, добавленные пока летит предыдущая правка, схлопываются в одну —
 * Telegram и так отбивает правку тем же текстом. Провалившаяся отправка не роняет операцию:
 * строки копятся и уедут следующей.
 */
const TICK_MS = 5000

export class ProgressPost {
  private lines: string[] = []
  private msgId?: number
  private delivered = ''
  private queue: Promise<void> = Promise.resolve()
  private ticker?: ReturnType<typeof setInterval>
  private runningIdx = -1

  constructor(private readonly transport: ProgressTransport, initial: string[] = []) {
    this.lines = initial.filter(Boolean)
    if (this.lines.length) {
      this.flush()
    }
  }

  step(line: string): void {
    if (!line.trim()) {
      return
    }
    this.stopTicker() // предыдущий долгий шаг кончился — его строка застывает как есть
    this.lines.push(line)
    this.flush()
  }

  /**
   * Долгий шаг, который сам показывает, сколько уже идёт. Строка живёт и перерисовывается
   * раз в TICK_MS, пока не придёт settle() или следующий step(). Нужен там, где операция
   * молчит минутами (хук ворктри в проекте) — без счётчика это неотличимо от зависания.
   */
  running(render: (seconds: number) => string, everyMs: number = TICK_MS): void {
    this.stopTicker()
    const startedAt = Date.now()
    this.runningIdx = this.lines.push(render(0)) - 1
    this.flush()
    this.ticker = setInterval(() => {
      this.lines[this.runningIdx] = render(Math.round((Date.now() - startedAt) / 1000))
      this.flush()
    }, everyMs)
    this.ticker.unref?.() // таймер прогресса не повод держать процесс живым
  }

  /** Долгий шаг закончился: его строка заменяется итоговой. Пустая строка — шаг оказался
   *  мгновенным, и строку убираем совсем, чтобы не мусорить «0 с». */
  settle(line: string): void {
    const idx = this.runningIdx
    this.stopTicker()
    if (idx < 0) {
      return
    }
    if (line.trim()) {
      this.lines[idx] = line
    } else {
      this.lines.splice(idx, 1)
    }
    this.flush()
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
    this.runningIdx = -1
  }

  text(): string {
    return this.lines.join('\n')
  }

  /** Дождаться, пока все шаги доедут — нужен тестам и там, где после операции сразу шлют другое. */
  async settled(): Promise<void> {
    await this.queue
  }

  private flush(): void {
    this.queue = this.queue
      .then(async () => {
        const text = this.text()
        if (text === this.delivered) {
          return
        }
        if (this.msgId === undefined) {
          this.msgId = await this.transport.send(text)
        } else {
          await this.transport.edit(this.msgId, text)
        }
        this.delivered = text
      })
      .catch(() => {}) // сеть моргнула — следующий шаг перерисует пост целиком
  }
}
