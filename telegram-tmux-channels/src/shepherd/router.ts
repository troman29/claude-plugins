// Маршрутизация событий PR: владелец, фильтры, агрегация, ожидание CI, доставка с повторами.
// Всё внешнее (часы, gh/git, доставка в сессию, Telegram) приходит через RouterDeps — так
// логику можно гонять в тестах на фальшивых часах.
import type { BindingEntry } from '../registry'
import { modeOf, type ShepherdConfig } from './config'
import { findByBranch, type Exec } from './owner'
import { parseRequest, prKeyOf, type ShepherdEvent } from './protocol'
import {
  renderDead, renderEscalation, renderForAgent, renderQuietNotice, renderShadow, renderUnowned,
  type Entry, type FailedCheck,
} from './render'
import type { InboxItem, ItemState, OwnerRecord, ShepherdStore } from './store'

export type Clock = { now(): number; after(ms: number, fn: () => void): () => void }
export type DeliveryResult = 'ok' | 'failed'
export type Reply = { ok: true; status: 'persisted' | 'duplicate' } | { ok: false; error: string }

export type RouterDeps = {
  store: ShepherdStore
  config: () => ShepherdConfig
  bindings: () => Record<string, BindingEntry>
  exec: Exec
  clock: Clock
  /** Завершается, когда стаб подтвердил приём (или сообщение уже не вернуть). */
  deliver: (key: string, text: string) => Promise<DeliveryResult>
  post: (target: string, text: string, options: { silent: boolean }) => Promise<void>
  log: (line: string) => void
}

type HumanEvent = Extract<ShepherdEvent, { kind: 'review' | 'review_comment' | 'comment' }>
type Bucket = { owner: OwnerRecord; entries: Entry[]; ids: string[]; cancel: () => void }
type Route = { item: InboxItem; entry: Entry; immediate?: boolean }
type GhCheck = { name: string; state: string; link?: string; bucket: string }

const AGGREGATE_MS = 60_000
const CI_SETTLE_MS = 60_000
const CI_POLL_MS = 60_000
const CI_MAX_WAIT_MS = 40 * 60_000
const DELIVERY_RETRY_MS = [30_000, 120_000, 600_000]
const DELIVERY_TIMEOUT_MS = 6.5 * 3600_000
const ESCALATE_AFTER_FAILURES = 3

const IGNORED_LOGINS: ReadonlySet<string> = new Set(['thomas5788', 'agentek-bot[bot]'])
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

function isHumanEvent(event: ShepherdEvent): event is HumanEvent {
  return event.kind === 'review' || event.kind === 'review_comment' || event.kind === 'comment'
}

/** Ответы ботов и самого агента не возвращаем агенту: иначе он спорит сам с собой. */
export function isTrustedHuman(event: HumanEvent): boolean {
  const login = event.actor.toLowerCase()
  return !IGNORED_LOGINS.has(login) && !login.endsWith('[bot]') && TRUSTED_ASSOCIATIONS.has(event.association)
}

export class ShepherdRouter {
  private lanes = new Map<string, Promise<void>>()
  private buckets = new Map<string, Bucket>()
  private cancels = new Set<() => void>()
  private watchers = new Map<string, { touchedAt: number }>()
  // Какие упавшие проверки sha уже ушли владельцу; живёт до рестарта (после него оценка повторится).
  private reported = new Map<string, Set<string>>()

  constructor(private readonly deps: RouterDeps) {}

  /** Принять запрос из сокета: валидация, запись на диск, затем асинхронная обработка. */
  async accept(raw: unknown): Promise<Reply> {
    const { store, log } = this.deps
    const parsed = parseRequest(raw)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error }
    }
    if (modeOf(this.deps.config(), parsed.event.repo) === 'off') {
      return { ok: false, error: 'disabled' }
    }
    let result
    try {
      result = store.persist(parsed.deliveryId, parsed.event)
    } catch (e) {
      log(`shepherd: persist failed: ${e instanceof Error ? e.stack : e}`)
      return { ok: false, error: 'io: persist failed' }
    }
    if (result.status === 'duplicate') {
      return { ok: true, status: 'duplicate' }
    }
    void this.ingest(result.item)
    return { ok: true, status: 'persisted' }
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
    const prKey = prKeyOf({ repo, pr })
    const prev = this.deps.store.getOwner(prKey)
    const record: OwnerRecord = {
      key, version: (prev?.version ?? 0) + 1, source: 'manual', at: new Date(this.deps.clock.now()).toISOString(),
    }
    this.deps.store.setOwner(prKey, record)
    this.dropBucket(prKey, 'owner changed')
    return record
  }

  status(key: string): string[] {
    return this.deps.store.ownedBy(key).map(([prKey, record]) => {
      const waiting = this.buckets.get(prKey)?.entries.length ?? 0
      return `${prKey} (v${record.version}, ${record.source})${waiting ? `, в очереди: ${waiting}` : ''}`
    })
  }

  stop(): void {
    this.cancels.forEach(cancel => cancel())
    this.cancels.clear()
    this.buckets.clear()
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
    if (!isHumanEvent(event) || !isTrustedHuman(event)) {
      this.done(item, 'dropped', 'filtered sender')
      return
    }
    if (event.kind === 'review' && event.state === 'approved') {
      const mode = modeOf(this.deps.config(), event.repo)
      const owner = await this.resolveOwner(event, mode === 'on')
      if (mode === 'on' && owner) {
        await this.say(owner.key, renderQuietNotice([{ event }], false), true)
      }
      this.done(item, 'logged', 'approved')
      return
    }
    await this.route({ item, entry: { event } })
  }

  /** Решить, кому идёт событие: shadow — только след, без владельца — служебный топик, иначе в пачку. */
  private async route({ item, entry, immediate }: Route): Promise<void> {
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
      await this.postRequired(config.serviceChat, renderUnowned(event), false)
      this.done(item, 'unowned')
      return
    }
    this.addToBucket(prKeyOf(event), owner, item.id, entry)
    this.deps.store.setState(item.id, 'routed')
    if (immediate) {
      this.buckets.get(prKeyOf(event))?.cancel()
      void this.flush(prKeyOf(event))
    }
  }

  private addToBucket(prKey: string, owner: OwnerRecord, id: string, entry: Entry): void {
    let bucket = this.buckets.get(prKey)
    if (bucket && bucket.owner.version !== owner.version) {
      this.dropBucket(prKey, 'owner changed')
      bucket = undefined
    }
    if (!bucket) {
      const cancel = this.deps.clock.after(AGGREGATE_MS, () => void this.flush(prKey))
      this.cancels.add(cancel)
      bucket = { owner, entries: [], ids: [], cancel }
      this.buckets.set(prKey, bucket)
    }
    bucket.entries.push(entry)
    bucket.ids.push(id)
  }

  private dropBucket(prKey: string, note: string): void {
    const bucket = this.buckets.get(prKey)
    if (!bucket) {
      return
    }
    bucket.cancel()
    this.buckets.delete(prKey)
    bucket.ids.forEach(id => this.deps.store.setState(id, 'dropped', note))
  }

  private async flush(prKey: string): Promise<void> {
    const bucket = this.buckets.get(prKey)
    if (!bucket) {
      return
    }
    this.buckets.delete(prKey)
    await this.deliverWithRetry(prKey, bucket)
  }

  private currentOwnerIs(prKey: string, owner: OwnerRecord): boolean {
    const current = this.deps.store.getOwner(prKey)
    return current?.version === owner.version && current.key === owner.key
  }

  private async deliverWithRetry(prKey: string, bucket: Bucket): Promise<void> {
    const { store } = this.deps
    const deps = this.deps
    const text = renderForAgent(bucket.entries)
    for (let attempt = 0; ; attempt++) {
      if (!this.currentOwnerIs(prKey, bucket.owner)) {
        bucket.ids.forEach(id => store.setState(id, 'dropped', 'owner changed'))
        return
      }
      if (await this.tryDeliver(bucket.owner.key, text) === 'ok') {
        bucket.ids.forEach(id => store.setState(id, 'delivered'))
        deps.log(`shepherd: ${prKey} delivered to ${bucket.owner.key} (${bucket.ids.length} event(s))`)
        await this.say(bucket.owner.key, renderQuietNotice(bucket.entries, true), true)
        return
      }
      const delay = DELIVERY_RETRY_MS[attempt]
      if (delay === undefined) {
        bucket.ids.forEach(id => store.setState(id, 'dead', 'delivery failed'))
        await this.say(deps.config().serviceChat, renderDead(bucket.entries, bucket.owner.key), false)
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
