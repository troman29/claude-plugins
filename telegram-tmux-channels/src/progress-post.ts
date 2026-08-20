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
export class ProgressPost {
  private lines: string[] = []
  private msgId?: number
  private delivered = ''
  private queue: Promise<void> = Promise.resolve()

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
    this.lines.push(line)
    this.flush()
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
