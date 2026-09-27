// Компакцию видят ДВА источника: хук агента (точный старт и финиш, но без процентов) и скрейп
// пейна (проценты, но только пока Claude рисует бар — у Codex его нет вовсе). Какой из них ведёт
// пост, решает хаб по адаптеру; пост в топике один на сеанс: кто пришёл первым, тот его завёл,
// второй дополняет ЕГО, а не шлёт свой.

export type CompactionTarget = { chatId: string; threadId?: number }

export type CompactionPost = CompactionTarget & {
  msgId: number
  bindingKey: string
  bindingDir: string
  pane?: string
  /** Последний показанный процент; -1 — бара ещё не видели (пост завёл хук). */
  lastPct: number
  misses: number
}

export type CompactionDeps = {
  /** Отправить пост в топик; undefined — не ушло (тогда слот освобождается). */
  send(target: CompactionTarget, html: string): Promise<number | undefined>
  edit(post: CompactionPost, html: string): Promise<void>
  render: {
    started(trigger: string): string
    bar(pct: number, elapsed?: string): string
    /** Пейн показывает компакцию без процентов — ведём пост по времени. */
    working(elapsed?: string): string
    done(): string
  }
  persist(post: CompactionPost): void
  forget(bindingKey: string): void
}

/** Слот занят, отправка в полёте — параллельный тик не должен слать второй пост. */
const SENDING = -1
/** Процентов ещё не видели: пост завёл хук, бар пейна его пока не трогал. */
const NO_PCT = -1
/** Пейн ловит кадр без бара на перерисовке — финализируем только со второго промаха. */
const MISS_LIMIT = 2

export class CompactionPosts {
  private readonly posts = new Map<string, CompactionPost>() // ключ — биндинг, не пейн: один сеанс = один пост

  constructor(private readonly deps: CompactionDeps, restored: CompactionPost[] = []) {
    for (const post of restored) {
      this.posts.set(post.bindingKey, post)
    }
  }

  get(bindingKey: string): CompactionPost | undefined {
    return this.posts.get(bindingKey)
  }

  /** Забыть пост, ничего не редактируя, — топик отвязали или переподняли. */
  drop(bindingKey: string): void {
    this.posts.delete(bindingKey)
  }

  /** Хук: компакция началась. */
  async started(opts: { bindingKey: string; bindingDir: string; target: CompactionTarget; trigger: string }): Promise<void> {
    if (this.posts.has(opts.bindingKey)) {
      return // бар пейна успел раньше — он и ведёт пост
    }
    await this.open({ ...opts, lastPct: NO_PCT }, this.deps.render.started(opts.trigger))
  }

  /** Скрейп пейна: очередной кадр живой компакции — с процентом (старый бар) или без (спиннер). */
  async progress(opts: {
    bindingKey: string; bindingDir: string; pane: string; target: CompactionTarget; pct?: number; elapsed?: string
  }): Promise<void> {
    const html = opts.pct != null ? this.deps.render.bar(opts.pct, opts.elapsed) : this.deps.render.working(opts.elapsed)
    // Без процентов версией кадра служит elapsed: он тикает, и пост правится не чаще раза в секунду.
    const version = opts.pct ?? elapsedSeconds(opts.elapsed)
    const post = this.posts.get(opts.bindingKey)
    if (!post) {
      await this.open({ ...opts, lastPct: version }, html)
      return
    }
    post.pane = opts.pane
    post.misses = 0
    if (post.msgId === SENDING || post.lastPct === version) {
      return // ещё отправляется, или кадр не сдвинулся — Telegram лимитирует правки
    }
    post.lastPct = version
    await this.deps.edit(post, html)
    this.deps.persist(post)
  }

  /** Скрейп пейна: бара в кадре нет. Пост, заведённый хуком без бара (Codex), это не трогает. */
  async missed(bindingKey: string): Promise<void> {
    const post = this.posts.get(bindingKey)
    if (!post || post.msgId === SENDING || post.lastPct === NO_PCT) {
      return
    }
    if (++post.misses < MISS_LIMIT) {
      return
    }
    await this.finished(bindingKey)
  }

  /** Хук: компакция закончилась (или бар пропал насовсем). */
  async finished(bindingKey: string): Promise<void> {
    const post = this.posts.get(bindingKey)
    this.posts.delete(bindingKey)
    this.deps.forget(bindingKey)
    if (post && post.msgId !== SENDING) {
      await this.deps.edit(post, this.deps.render.done())
    }
  }

  private async open(
    fields: { bindingKey: string; bindingDir: string; target: CompactionTarget; pane?: string; lastPct: number },
    html: string,
  ): Promise<void> {
    const { bindingKey, bindingDir, target, pane, lastPct } = fields
    const base: CompactionPost = {
      ...target, msgId: SENDING, bindingKey, bindingDir, ...(pane ? { pane } : {}), lastPct, misses: 0,
    }
    this.posts.set(bindingKey, base) // слот занимаем ДО await, иначе соседний тик пришлёт второй пост
    const msgId = await this.deps.send(target, html)
    if (!msgId) {
      if (this.posts.get(bindingKey)?.msgId === SENDING) {
        this.posts.delete(bindingKey)
      }
      return
    }
    const post = { ...base, msgId }
    if (this.posts.get(bindingKey)?.msgId !== SENDING) {
      await this.deps.edit(post, this.deps.render.done()) // сеанс кончился, пока пост летел
      return
    }
    this.posts.set(bindingKey, post)
    this.deps.persist(post)
  }
}

/** Секунды из "2s · ↓ 26 tokens" или "1m 24s"; без них кадр считаем нулевым. */
function elapsedSeconds(elapsed?: string): number {
  if (!elapsed) {
    return 0
  }
  const m = elapsed.match(/(?:(\d+)m\s*)?(\d+)s/)
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : 0
}
