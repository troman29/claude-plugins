// Маршрутизация событий PR: владелец, фильтры, агрегация, ожидание CI, доставка с повторами.
// Всё внешнее (часы, gh/git, доставка в сессию, Telegram) приходит через RouterDeps — так
// логику можно гонять в тестах на фальшивых часах.
import type { BindingEntry } from '../registry'
import { modeOf, type ShepherdConfig } from './config'
import { findByBranch, type Exec } from './owner'
import { parseRequest, parseUnowned, prKeyOf, type ShepherdEvent } from './protocol'
import {
  renderDead, renderEscalation, renderForAgent, renderQuietNotice, renderShadow, renderSpawnIntro, renderUnowned,
  type Entry, type FailedCheck,
} from './render'
import type { SpawnResult } from './spawn'
import type { InboxItem, ItemState, OwnerRecord, ShepherdStore } from './store'

export type Clock = { now(): number; after(ms: number, fn: () => void): () => void }
export type DeliveryResult = 'ok' | 'failed'
export type Ownership = 'mine' | 'none'
export type Reply =
  | { ok: true; status: 'persisted' | 'duplicate'; owner: Ownership }
  | { ok: true; status: 'accepted' }
  | { ok: false; error: string }

export type RouterDeps = {
  store: ShepherdStore
  config: () => ShepherdConfig
  bindings: () => Record<string, BindingEntry>
  exec: Exec
  clock: Clock
  /** Завершается, когда стаб подтвердил приём (или сообщение уже не вернуть). */
  deliver: (key: string, text: string) => Promise<DeliveryResult>
  post: (target: string, text: string, options: { silent: boolean }) => Promise<void>
  /** Открыть форум-топик закрытого биндинга; брошенная ошибка — топика уже нет. */
  reopenTopic: (key: string) => Promise<void>
  spawn: (event: ShepherdEvent) => Promise<SpawnResult>
  log: (line: string) => void
}

type HumanEvent = Extract<ShepherdEvent, { kind: 'review' | 'review_comment' | 'comment' }>
// Пачка на владельца: события нескольких PR одной сессии уходят одним сообщением.
type Member = { prKey: string; version: number; id: string; entry: Entry; intro?: string }
type Bucket = { key: string; members: Member[]; cancel: () => void }
type Route = { item: InboxItem; entry: Entry; immediate?: boolean }
type GhCheck = { name: string; state: string; link?: string; bucket: string }

const AGGREGATE_MS = 60_000
const CI_SETTLE_MS = 60_000
const CI_POLL_MS = 60_000
const CI_MAX_WAIT_MS = 40 * 60_000
const DELIVERY_RETRY_MS = [30_000, 120_000, 600_000]
const DELIVERY_TIMEOUT_MS = 6.5 * 3600_000
const ESCALATE_AFTER_FAILURES = 3
const AUTO_MERGE_SETTLE_MS = 3 * 60_000
const FANOUT_WAIT_MS = 2 * 60_000
const SPAWN_QUEUE_RETRY_MS = 5 * 60_000
const SIGNAL_TTL_MS = 3600_000

const IGNORED_LOGINS: ReadonlySet<string> = new Set(['thomas5788', 'agentek-bot[bot]'])
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

function isHumanEvent(event: ShepherdEvent): event is HumanEvent {
  return event.kind === 'review' || event.kind === 'review_comment' || event.kind === 'comment'
}

/** Ответы ботов и самого агента не возвращаем агенту: иначе он спорит сам с собой. */
export function isTrustedHuman(event: HumanEvent, trustedLogins: ReadonlySet<string> = new Set()): boolean {
  const login = event.actor.toLowerCase()
  if (IGNORED_LOGINS.has(login) || login.endsWith('[bot]')) {
    return false
  }
  return TRUSTED_ASSOCIATIONS.has(event.association) || trustedLogins.has(login)
}

export class ShepherdRouter {
  private lanes = new Map<string, Promise<void>>()
  private buckets = new Map<string, Bucket>()
  private cancels = new Set<() => void>()
  private watchers = new Map<string, { touchedAt: number }>()
  // Какие упавшие проверки sha уже ушли владельцу; живёт до рестарта (после него оценка повторится).
  private reported = new Map<string, Set<string>>()
  // События без владельца на главном хабе ждут `pr-unowned` от Cyrus; сигнал мог прийти раньше события (CI ждёт минуты).
  private awaiting = new Map<string, { cancel: () => void; run: () => void }>()
  private unownedSignals = new Map<string, number>()
  private spawnQueue: Route[] = []
  private spawnRetryScheduled = false
  private queuedNotified = new Set<string>()

  constructor(private readonly deps: RouterDeps) {}

  /** Принять запрос из сокета или HTTP: валидация, запись на диск, ответ «мой/ничей», затем асинхронная обработка. */
  async accept(raw: unknown): Promise<Reply> {
    if ((raw as { op?: unknown } | null)?.op === 'pr-unowned') {
      return this.acceptUnowned(raw)
    }
    const { store, log } = this.deps
    const parsed = parseRequest(raw)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error }
    }
    const mode = modeOf(this.deps.config(), parsed.event.repo)
    if (mode === 'off') {
      return { ok: false, error: 'disabled' }
    }
    let result
    try {
      result = store.persist(parsed.deliveryId, parsed.event)
    } catch (e) {
      log(`shepherd: persist failed: ${e instanceof Error ? e.stack : e}`)
      return { ok: false, error: 'io: persist failed' }
    }
    const owner = await this.answerOwner(parsed.event, mode === 'on')
    if (result.status === 'duplicate') {
      return { ok: true, status: 'duplicate', owner }
    }
    void this.ingest(result.item)
    return { ok: true, status: 'persisted', owner }
  }

  /** Cyrus: ни один хаб не взял событие. Сигнал, пришедший раньше события, ждёт его в памяти. */
  private acceptUnowned(raw: unknown): Reply {
    const parsed = parseUnowned(raw)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error }
    }
    const waiting = this.awaiting.get(parsed.deliveryId)
    if (waiting) {
      waiting.cancel()
      waiting.run()
    } else if (this.deps.config().primary) {
      const now = this.deps.clock.now()
      for (const [id, at] of this.unownedSignals) {
        if (now - at > SIGNAL_TTL_MS) {
          this.unownedSignals.delete(id)
        }
      }
      this.unownedSignals.set(parsed.deliveryId, now)
    }
    return { ok: true, status: 'accepted' }
  }

  private async answerOwner(event: ShepherdEvent, register: boolean): Promise<Ownership> {
    try {
      return (await this.resolveOwner(event, register)) ? 'mine' : 'none'
    } catch (e) {
      this.deps.log(`shepherd: owner lookup failed: ${e instanceof Error ? e.stack : e}`)
      return 'none'
    }
  }

  /** После рестарта: недоставленное из inbox.jsonl идёт по тому же пути, что и свежее. */
  replay(): void {
    const items = this.deps.store.undelivered()
    this.deps.log(`shepherd: replaying ${items.length} undelivered event(s)`)
    items.forEach(item => void this.ingest(item))
  }

  ingest(item: InboxItem): Promise<void> {
    return this.lane(prKeyOf(item.event), () => this.handle(item))
  }

  /** `/own`: ручной владелец; версия растёт, ожидающие события прежнего владельца отбрасываются. */
  setOwner(repo: string, pr: number, key: string): OwnerRecord {
    return this.writeOwner(prKeyOf({ repo, pr }), key, 'manual')
  }

  /** Владелец от обёртки `gh pr create`: перезаписывает ветку, но не ручной `/own` другого топика. */
  registerFromGh(repo: string, pr: number, key: string): { owner: OwnerRecord; kept: boolean } {
    const prKey = prKeyOf({ repo, pr })
    const prev = this.deps.store.getOwner(prKey)
    if (prev && prev.key === key) {
      return { owner: prev, kept: false }
    }
    if (prev?.source === 'manual') {
      this.deps.log(`shepherd: ${prKey} keeps manual owner ${prev.key}, ignoring gh registration for ${key}`)
      return { owner: prev, kept: true }
    }
    return { owner: this.writeOwner(prKey, key, 'gh'), kept: false }
  }

  private writeOwner(prKey: string, key: string, source: OwnerRecord['source']): OwnerRecord {
    const prev = this.deps.store.getOwner(prKey)
    const record: OwnerRecord = {
      key, version: (prev?.version ?? 0) + 1, source, at: new Date(this.deps.clock.now()).toISOString(),
    }
    this.deps.store.setOwner(prKey, record)
    this.dropPending(prKey, 'owner changed')
    return record
  }

  status(key: string): string[] {
    return this.deps.store.ownedBy(key).map(([prKey, record]) => {
      const waiting = this.buckets.get(key)?.members.filter(member => member.prKey === prKey).length ?? 0
      return `${prKey} (v${record.version}, ${record.source})${waiting ? `, в очереди: ${waiting}` : ''}`
    })
  }

  stop(): void {
    this.cancels.forEach(cancel => cancel())
    this.cancels.clear()
    this.buckets.clear()
    this.awaiting.clear()
  }

  private lane(prKey: string, work: () => Promise<void>): Promise<void> {
    const previous = this.lanes.get(prKey) ?? Promise.resolve()
    const next = previous.then(work).catch(e => this.deps.log(`shepherd: ${prKey} failed: ${e instanceof Error ? e.stack : e}`))
    this.lanes.set(prKey, next)
    void next.then(() => {
      if (this.lanes.get(prKey) === next) {
        this.lanes.delete(prKey)
      }
    })
    return next
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const cancel = this.deps.clock.after(ms, () => {
        this.cancels.delete(cancel)
        resolve()
      })
      this.cancels.add(cancel)
    })
  }

  private done(item: InboxItem, state: ItemState, note?: string): void {
    this.deps.store.setState(item.id, state, note)
    this.deps.log(`shepherd: ${prKeyOf(item.event)} ${item.event.kind} → ${state}${note ? ` (${note})` : ''}`)
  }

  /** Информационная строка: ошибка Telegram не должна ронять обработку. */
  private async say(target: string | undefined, text: string, silent: boolean): Promise<void> {
    try {
      await this.postRequired(target, text, silent, [])
    } catch (e) {
      this.deps.log(`shepherd: post to ${target} failed: ${e instanceof Error ? e.stack : e}`)
    }
  }

  /** Обязательное уведомление: при ошибке Telegram повторяем, затем бросаем — событие остаётся
   *  открытым и вернётся после рестарта. Не настроенный адресат — не сбой, а конфигурация. */
  private async postRequired(target: string | undefined, text: string, silent: boolean, retryMs = DELIVERY_RETRY_MS): Promise<void> {
    if (!target) {
      this.deps.log(`shepherd: no target for message: ${text.split('\n')[0]}`)
      return
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.post(target, text, { silent })
        return
      } catch (e) {
        const delay = retryMs[attempt]
        if (delay === undefined) {
          throw e
        }
        this.deps.log(`shepherd: post to ${target} failed, retry in ${delay} ms: ${e instanceof Error ? e.message : e}`)
        await this.sleep(delay)
      }
    }
  }

  private async handle(item: InboxItem): Promise<void> {
    const { event } = item
    const mode = modeOf(this.deps.config(), event.repo)
    if (mode === 'off') {
      this.done(item, 'dropped', 'repo is off')
      return
    }
    switch (event.kind) {
      case 'pr_opened':
      case 'pr_reopened':
      case 'pr_ready':
      case 'pr_synchronize':
        await this.resolveOwner(event, mode === 'on')
        this.done(item, 'logged')
        return
      case 'checks_completed':
        // Чужой PR на второстепенном хабе: CI-наблюдение (gh-опрос до 40 минут) не нужно.
        if (!this.deps.config().primary && (await this.answerOwner(event, mode === 'on')) === 'none') {
          this.done(item, 'not-mine')
          return
        }
        this.startCiWatch(item)
        return
      case 'pr_closed':
        await this.route({ item, entry: { event }, immediate: true })
        return
      default:
        await this.handleHuman(item, event)
    }
  }

  private async handleHuman(item: InboxItem, event: ShepherdEvent): Promise<void> {
    if (!isHumanEvent(event) || !isTrustedHuman(event, this.deps.config().trustedLogins)) {
      this.done(item, 'dropped', 'filtered sender')
      return
    }
    if (event.kind === 'review' && event.state === 'approved') {
      const mode = modeOf(this.deps.config(), event.repo)
      const owner = await this.resolveOwner(event, mode === 'on')
      if (mode === 'on' && owner) {
        await this.say(owner.key, renderQuietNotice([{ event }], false), true)
        this.watchAutoMerge(event)
      }
      this.done(item, 'logged', 'approved')
      return
    }
    await this.route({ item, entry: { event } })
  }

  /** Решить, кому идёт событие: shadow — только след, без владельца — служебный топик, иначе в пачку. */
  private async route(route: Route): Promise<void> {
    const { item } = route
    const { event } = item
    const config = this.deps.config()
    const mode = modeOf(config, event.repo)
    const owner = await this.resolveOwner(event, mode === 'on')
    if (mode === 'shadow') {
      await this.say(config.serviceChat, renderShadow(event, owner?.key), true)
      this.done(item, 'shadowed', owner ? `would go to ${owner.key}` : 'no owner')
      return
    }
    if (!owner) {
      await this.noOwner(route)
      return
    }
    this.enqueue(owner, route)
  }

  private enqueue(owner: OwnerRecord, { item, entry, immediate }: Route, intro?: string): void {
    this.addToBucket(owner, { prKey: prKeyOf(item.event), version: owner.version, id: item.id, entry, ...(intro ? { intro } : {}) })
    this.deps.store.setState(item.id, 'routed')
    if (immediate) {
      this.buckets.get(owner.key)?.cancel()
      void this.flush(owner.key)
    }
  }

  /** Владельца нет: второстепенный хаб молчит, главный ждёт `pr-unowned` (или срок) и ведёт политику. */
  private async noOwner(route: Route): Promise<void> {
    const { item } = route
    if (!this.deps.config().primary) {
      this.done(item, 'not-mine')
      return
    }
    if (this.unownedSignals.delete(item.deliveryId)) {
      await this.noOwnerPolicy(route)
      return
    }
    this.deps.store.setState(item.id, 'awaiting-fanout')
    const cancelWait = this.deps.clock.after(FANOUT_WAIT_MS, () => {
      this.cancels.delete(cancelWait)
      this.awaiting.delete(item.deliveryId)
      if (this.deps.config().fanout) {
        this.done(item, 'not-mine', 'no pr-unowned in time')
        return
      }
      void this.lane(prKeyOf(item.event), () => this.noOwnerPolicy(route))
    })
    this.cancels.add(cancelWait)
    this.awaiting.set(item.deliveryId, {
      cancel: () => {
        cancelWait()
        this.cancels.delete(cancelWait)
        this.awaiting.delete(item.deliveryId)
      },
      run: () => void this.lane(prKeyOf(item.event), () => this.noOwnerPolicy(route)),
    })
  }

  /** Тот же топик и та же сессия, если запись владельца осталась; иначе новая сессия под PR. */
  private async noOwnerPolicy(route: Route): Promise<void> {
    const { item } = route
    const { event } = item
    const config = this.deps.config()
    const prKey = prKeyOf(event)
    const owner = await this.resolveOwner(event, true)
    if (owner) {
      this.enqueue(owner, route)
      return
    }
    const record = this.deps.store.getOwner(prKey)
    if (record && this.deps.bindings()[record.key]) {
      await this.reopenAndEnqueue(record, route)
      return
    }
    if (event.kind === 'pr_closed') {
      this.done(item, 'logged', 'closed, no owner')
      return
    }
    if (!config.agentAuthors.has(event.prAuthor.toLowerCase())) {
      await this.unowned(route, 'Сессию сам не завожу: PR не от агента.')
      return
    }
    const result = await this.deps.spawn(event)
    switch (result.kind) {
      case 'spawned':
        this.enqueue(this.writeOwner(prKey, result.key, 'spawn'), { ...route, immediate: true }, renderSpawnIntro(event))
        return
      case 'busy': {
        const holder = Object.entries(this.deps.bindings()).find(([, binding]) => binding.dir === result.dir)
        if (!holder) {
          await this.unowned(route, 'Ветка уже занята другой папкой без топика, сессию не завожу.')
          return
        }
        await this.reopenAndEnqueue(this.writeOwner(prKey, holder[0], 'branch'), route)
        return
      }
      case 'limit':
        this.queueForSpawn(route)
        return
      case 'no-mapping':
        await this.unowned(route, `Репозитория нет в shepherd.json (spawn): добавь "${event.repo}": { "chat": "…", "dir": "…" }.`)
        return
      case 'failed':
        await this.unowned(route, `Не смог завести сессию: ${result.error}.`)
    }
  }

  private async reopenAndEnqueue(owner: OwnerRecord, route: Route): Promise<void> {
    if (this.deps.bindings()[owner.key]?.closed) {
      try {
        await this.deps.reopenTopic(owner.key)
      } catch (e) {
        this.deps.log(`shepherd: reopen ${owner.key} failed: ${e instanceof Error ? e.stack : e}`)
        await this.unowned(route, 'Не смог открыть закрытый топик владельца.')
        return
      }
    }
    this.enqueue(owner, route)
  }

  private async unowned(route: Route, reason: string): Promise<void> {
    await this.postRequired(this.deps.config().serviceChat, renderUnowned(route.item.event, reason), false)
    this.done(route.item, 'unowned')
  }

  /** Лимит живых спавненных сессий: PR ждёт, служебная строка — одна на PR. */
  private queueForSpawn(route: Route): void {
    const { item } = route
    const prKey = prKeyOf(item.event)
    this.deps.store.setState(item.id, 'queued', 'spawn limit')
    this.spawnQueue.push(route)
    if (!this.queuedNotified.has(prKey)) {
      this.queuedNotified.add(prKey)
      void this.say(this.deps.config().serviceChat, renderUnowned(item.event, 'Живых спавненных сессий уже максимум, PR жду в очереди.'), false)
    }
    if (this.spawnRetryScheduled) {
      return
    }
    this.spawnRetryScheduled = true
    const cancel = this.deps.clock.after(SPAWN_QUEUE_RETRY_MS, () => {
      this.cancels.delete(cancel)
      this.spawnRetryScheduled = false
      this.spawnQueue.splice(0).forEach(queued => void this.lane(prKeyOf(queued.item.event), () => this.noOwnerPolicy(queued)))
    })
    this.cancels.add(cancel)
  }

  private addToBucket(owner: OwnerRecord, member: Member): void {
    let bucket = this.buckets.get(owner.key)
    if (!bucket) {
      const cancel = this.deps.clock.after(AGGREGATE_MS, () => void this.flush(owner.key))
      this.cancels.add(cancel)
      bucket = { key: owner.key, members: [], cancel }
      this.buckets.set(owner.key, bucket)
    }
    bucket.members.push(member)
  }

  /** События PR, чей владелец сменился, не доставляем: их ждёт уже не тот адресат. */
  private dropPending(prKey: string, note: string): void {
    for (const [key, bucket] of this.buckets) {
      const dropped = bucket.members.filter(member => member.prKey === prKey)
      bucket.members = bucket.members.filter(member => member.prKey !== prKey)
      dropped.forEach(member => this.deps.store.setState(member.id, 'dropped', note))
      if (!bucket.members.length) {
        bucket.cancel()
        this.buckets.delete(key)
      }
    }
  }

  private async flush(key: string): Promise<void> {
    const bucket = this.buckets.get(key)
    if (!bucket) {
      return
    }
    this.buckets.delete(key)
    await this.deliverWithRetry(bucket)
  }

  private currentOwnerIs(member: Member, key: string): boolean {
    const current = this.deps.store.getOwner(member.prKey)
    return current?.version === member.version && current.key === key
  }

  private async deliverWithRetry(bucket: Bucket): Promise<void> {
    const { store } = this.deps
    const deps = this.deps
    for (let attempt = 0; ; attempt++) {
      const current = bucket.members.filter(member => this.currentOwnerIs(member, bucket.key))
      bucket.members.filter(member => !current.includes(member)).forEach(member => store.setState(member.id, 'dropped', 'owner changed'))
      bucket.members = current
      if (!current.length) {
        return
      }
      const entries = current.map(member => member.entry)
      const intros = [...new Set(current.flatMap(member => member.intro ?? []))]
      if (await this.tryDeliver(bucket.key, [...intros, renderForAgent(entries)].join('\n\n')) === 'ok') {
        current.forEach(member => store.setState(member.id, 'delivered'))
        deps.log(`shepherd: delivered to ${bucket.key} (${current.length} event(s), ${new Set(current.map(member => member.prKey)).size} PR(s))`)
        await this.say(bucket.key, renderQuietNotice(entries, true), true)
        return
      }
      const delay = DELIVERY_RETRY_MS[attempt]
      if (delay === undefined) {
        current.forEach(member => store.setState(member.id, 'dead', 'delivery failed'))
        await this.say(deps.config().serviceChat, renderDead(entries, bucket.key), false)
        return
      }
      await this.sleep(delay)
    }
  }

  private async tryDeliver(key: string, text: string): Promise<DeliveryResult> {
    let cancelTimeout = () => {}
    const timeout = new Promise<DeliveryResult>(resolve => {
      cancelTimeout = this.deps.clock.after(DELIVERY_TIMEOUT_MS, () => resolve('failed'))
    })
    try {
      return await Promise.race([this.deps.deliver(key, text), timeout])
    } catch (e) {
      this.deps.log(`shepherd: deliver to ${key} threw: ${e instanceof Error ? e.stack : e}`)
      return 'failed'
    } finally {
      cancelTimeout()
    }
  }

  /** Владелец: запись в owners.json (с версией), иначе единственный биндинг на ветке PR. */
  private async resolveOwner(event: ShepherdEvent, register: boolean): Promise<OwnerRecord | undefined> {
    const { store } = this.deps
    const deps = this.deps
    const prKey = prKeyOf(event)
    const bindings = deps.bindings()
    const existing = store.getOwner(prKey)
    if (existing && bindings[existing.key] && !bindings[existing.key]!.closed) {
      return existing
    }
    const candidates = await findByBranch(bindings, event.repo, event.headRef, deps.exec)
    if (candidates.length !== 1) {
      deps.log(`shepherd: ${prKey} has ${candidates.length} candidate owner(s) on ${event.headRef}`)
      return undefined
    }
    const record: OwnerRecord = {
      key: candidates[0]!, version: (existing?.version ?? 0) + 1, source: 'branch', at: new Date(deps.clock.now()).toISOString(),
    }
    if (register) {
      store.setOwner(prKey, record)
    }
    return record
  }

  /** GitHub иногда не запускает уже включённый auto-merge после Approve: PR чистый, одобрен и висит. Перевключаем сами. */
  private watchAutoMerge(event: ShepherdEvent): void {
    const cancel = this.deps.clock.after(AUTO_MERGE_SETTLE_MS, () => {
      this.cancels.delete(cancel)
      void this.kickAutoMerge(event).catch(err => this.deps.log(`shepherd: ${prKeyOf(event)} auto-merge kick failed: ${err}`))
    })
    this.cancels.add(cancel)
  }

  private async kickAutoMerge(event: ShepherdEvent): Promise<void> {
    const pr = await this.ghJson<{ state: string; mergeStateStatus: string; autoMergeRequest: { mergeMethod: string } | null }>(
      ['pr', 'view', String(event.pr), '--repo', event.repo, '--json', 'state,mergeStateStatus,autoMergeRequest'],
    )
    if (pr.state !== 'OPEN' || pr.mergeStateStatus !== 'CLEAN' || !pr.autoMergeRequest) {
      return
    }
    const method = `--${pr.autoMergeRequest.mergeMethod.toLowerCase()}`
    await this.deps.exec(['gh', 'pr', 'merge', String(event.pr), '--repo', event.repo, '--disable-auto'])
    await this.deps.exec(['gh', 'pr', 'merge', String(event.pr), '--repo', event.repo, '--auto', method])
    this.deps.log(`shepherd: ${prKeyOf(event)} approved and clean but auto-merge stuck — re-enabled (${method})`)
  }

  private async ghJson<T>(args: string[]): Promise<T> {
    const { stdout } = await this.deps.exec(['gh', ...args])
    return JSON.parse(stdout) as T // gh pr checks шлёт JSON и при кодах 1/8 (упало/ждёт)
  }

  /** Новый suite на sha, который уже наблюдают, продлевает наблюдение: ранний срез мог не видеть его. */
  private startCiWatch(item: InboxItem): void {
    const { event } = item
    const watchKey = `${prKeyOf(event)}:${event.headSha.toLowerCase()}`
    const active = this.watchers.get(watchKey)
    if (active) {
      active.touchedAt = this.deps.clock.now()
      this.done(item, 'logged', 'merged into the running CI watch')
      return
    }
    const watch = { touchedAt: 0 }
    this.watchers.set(watchKey, watch)
    this.done(item, 'routed')
    void this.watchCi(item, watch).finally(() => this.watchers.delete(watchKey))
  }

  /** CI по head sha: ждём, пока всё завершится, и сверяем, что sha ещё голова открытого PR. */
  private async watchCi(item: InboxItem, watch: { touchedAt: number }): Promise<void> {
    const { event } = item
    if (event.kind !== 'checks_completed') {
      return
    }
    let started = this.deps.clock.now()
    const settle = async () => {
      do {
        const sleptFrom = this.deps.clock.now()
        await this.sleep(CI_SETTLE_MS)
        if (watch.touchedAt > sleptFrom) {
          started = watch.touchedAt
        }
      } while (watch.touchedAt > this.deps.clock.now() - CI_SETTLE_MS)
    }
    await settle()
    for (;;) {
      const snapshotAt = this.deps.clock.now()
      const timedOut = snapshotAt - started >= CI_MAX_WAIT_MS
      let checks: GhCheck[]
      try {
        const pr = await this.ghJson<{ headRefOid: string; state: string }>(
          ['pr', 'view', String(event.pr), '--repo', event.repo, '--json', 'headRefOid,state'],
        )
        if (pr.state !== 'OPEN' || pr.headRefOid.toLowerCase() !== event.headSha.toLowerCase()) {
          this.done(item, 'stale', pr.state !== 'OPEN' ? 'pr is not open' : 'head moved')
          return
        }
        checks = await this.ghJson<GhCheck[]>(
          ['pr', 'checks', String(event.pr), '--repo', event.repo, '--json', 'name,state,link,bucket'],
        )
      } catch (e) {
        if (timedOut) {
          this.done(item, 'dead', `gh failed: ${e instanceof Error ? e.message : e}`)
          return
        }
        await this.sleep(CI_POLL_MS)
        continue
      }
      if (watch.touchedAt > snapshotAt) {
        started = watch.touchedAt
        await settle()
        continue
      }
      const pending = checks.some(check => check.bucket === 'pending')
      if (pending && !timedOut) {
        await this.sleep(CI_POLL_MS)
        continue
      }
      const failed = checks.filter(check => check.bucket === 'fail').map(({ name, link }): FailedCheck => ({ name, ...(link ? { link } : {}) }))
      if (pending && !failed.length) {
        this.done(item, 'dead', 'checks still pending after the wait limit')
        return
      }
      await this.lane(prKeyOf(event), () => this.finishCi(item, failed))
      return
    }
  }

  private async finishCi(item: InboxItem, failed: FailedCheck[]): Promise<void> {
    const { event } = item
    const prKey = prKeyOf(event)
    const reportKey = `${prKey}:${event.headSha.toLowerCase()}`
    const reported = this.reported.get(reportKey) ?? new Set<string>()
    const fresh = failed.filter(check => !reported.has(check.name))
    if (failed.length && !fresh.length) {
      this.done(item, 'logged', 'failures already reported for this sha')
      return
    }
    const config = this.deps.config()
    const mode = modeOf(config, event.repo)
    if (mode === 'on') {
      const failures = this.deps.store.recordCi(prKey, event.headSha, failed.length > 0)
      if (failed.length && failures >= ESCALATE_AFTER_FAILURES) {
        const owner = await this.resolveOwner(event, true)
        if (!owner && !config.primary) {
          this.done(item, 'not-mine')
          return
        }
        await this.postRequired(owner?.key ?? config.serviceChat, renderEscalation(event, failures), false)
        fresh.forEach(check => reported.add(check.name))
        this.reported.set(reportKey, reported)
        this.done(item, 'escalated', `${failures} failures in a row`)
        return
      }
    }
    if (!failed.length) {
      this.done(item, 'logged', 'ci green')
      return
    }
    await this.route({ item, entry: { event, failed: fresh } })
    fresh.forEach(check => reported.add(check.name))
    this.reported.set(reportKey, reported)
  }
}
