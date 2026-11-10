// Долговечное состояние шеперда под $TELEGRAM_STATE_DIR/shepherd/. Событие становится
// «принятым» только после fsync строки в inbox.jsonl: ACK GitHub'у уходит позже.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'fs'
import { join } from 'path'
import { safeJsonParse, writeFileAtomic } from '../util'
import { semanticKey, type ShepherdEvent } from './protocol'

export type ItemState =
  | 'received' | 'routed'
  | 'delivered' | 'shadowed' | 'unowned' | 'escalated' | 'dead' | 'logged' | 'dropped' | 'stale'

export type InboxItem = { id: string; deliveryId: string; semKey?: string; receivedAt: string; event: ShepherdEvent }
export type OwnerRecord = { key: string; version: number; source: 'branch' | 'manual'; at: string }
export type PersistResult = { status: 'persisted'; item: InboxItem } | { status: 'duplicate' }

type StateLine = { id: string; at: string; state: ItemState; note?: string }
type CiRecord = { failures: number; lastSha: string }

const OPEN_STATES: ReadonlySet<ItemState> = new Set(['received', 'routed'])
const RETENTION_MS = 7 * 24 * 3600_000
const MAX_RETAINED_ITEMS = 5000

export class ShepherdStore {
  private readonly inboxFile: string
  private readonly eventsFile: string
  private readonly ownersFile: string
  private readonly ciFile: string
  private items: InboxItem[] = []
  private states = new Map<string, ItemState>()
  private deliveryIds = new Set<string>()
  private semKeys = new Set<string>()
  private owners: Record<string, OwnerRecord> = {}
  private ci: Record<string, CiRecord> = {}
  private seq = 0

  constructor(dir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.inboxFile = join(dir, 'inbox.jsonl')
    this.eventsFile = join(dir, 'events.jsonl')
    this.ownersFile = join(dir, 'owners.json')
    this.ciFile = join(dir, 'ci.json')
    this.load()
  }

  /** Записать событие на диск до ACK. Повтор по deliveryId или по смыслу — `duplicate`. */
  persist(deliveryId: string, event: ShepherdEvent): PersistResult {
    const semKey = semanticKey(event)
    if (this.deliveryIds.has(deliveryId) || (semKey && this.semKeys.has(semKey))) {
      return { status: 'duplicate' }
    }
    const item: InboxItem = {
      id: `${this.now()}-${++this.seq}`, deliveryId, ...(semKey ? { semKey } : {}),
      receivedAt: new Date(this.now()).toISOString(), event,
    }
    appendDurable(this.inboxFile, JSON.stringify(item))
    this.track(item)
    this.setState(item.id, 'received')
    return { status: 'persisted', item }
  }

  setState(id: string, state: ItemState, note?: string): void {
    const line: StateLine = { id, at: new Date(this.now()).toISOString(), state, ...(note ? { note } : {}) }
    appendDurable(this.eventsFile, JSON.stringify(line))
    this.states.set(id, state)
  }

  stateOf(id: string): ItemState | undefined {
    return this.states.get(id)
  }

  /** Принятое, но не доведённое до конечного состояния: после рестарта хаб гонит их заново. */
  undelivered(): InboxItem[] {
    return this.items.filter(item => OPEN_STATES.has(this.states.get(item.id) ?? 'received'))
  }

  getOwner(prKey: string): OwnerRecord | undefined {
    return this.owners[prKey]
  }

  setOwner(prKey: string, record: OwnerRecord): void {
    this.owners[prKey] = record
    writeFileAtomic(this.ownersFile, JSON.stringify(this.owners, null, 2) + '\n')
  }

  ownedBy(key: string): [string, OwnerRecord][] {
    return Object.entries(this.owners).filter(([, record]) => record.key === key)
  }

  /** Результат CI для sha; возвращает число подряд упавших разных sha. */
  recordCi(prKey: string, sha: string, failed: boolean): number {
    const prev = this.ci[prKey]
    const lowerSha = sha.toLowerCase()
    const failures = !failed ? 0 : prev?.lastSha === lowerSha ? prev.failures : (prev?.failures ?? 0) + 1
    this.ci[prKey] = { failures, lastSha: lowerSha }
    writeFileAtomic(this.ciFile, JSON.stringify(this.ci) + '\n')
    return failures
  }

  private track(item: InboxItem): void {
    this.items.push(item)
    this.deliveryIds.add(item.deliveryId)
    if (item.semKey) {
      this.semKeys.add(item.semKey)
    }
  }

  private load(): void {
    this.owners = readJson<Record<string, OwnerRecord>>(this.ownersFile) ?? {}
    this.ci = readJson<Record<string, CiRecord>>(this.ciFile) ?? {}
    const stateLines = readLines<StateLine>(this.eventsFile)
    for (const line of stateLines) {
      this.states.set(line.id, line.state)
    }
    const cutoff = this.now() - RETENTION_MS
    const kept = readLines<InboxItem>(this.inboxFile)
      .filter(item => OPEN_STATES.has(this.states.get(item.id) ?? 'received') || Date.parse(item.receivedAt) >= cutoff)
      .slice(-MAX_RETAINED_ITEMS)
    kept.forEach(item => this.track(item))
    this.seq = kept.length
    const ids = new Set(kept.map(item => item.id))
    writeFileAtomic(this.inboxFile, kept.map(item => JSON.stringify(item) + '\n').join(''))
    writeFileAtomic(this.eventsFile, stateLines.filter(line => ids.has(line.id)).map(line => JSON.stringify(line) + '\n').join(''))
  }
}

function appendDurable(file: string, line: string): void {
  const fd = openSync(file, 'a', 0o600)
  try {
    writeSync(fd, line + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? safeJsonParse<T>(readFileSync(file, 'utf8')) : undefined
}

// Строка, оборванная крэшем посреди записи, пропускается: остальные живы.
function readLines<T>(file: string): T[] {
  if (!existsSync(file)) {
    return []
  }
  const parsed: T[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const value = line.trim() ? safeJsonParse<T>(line) : undefined
    if (value !== undefined) {
      parsed.push(value)
    }
  }
  return parsed
}
