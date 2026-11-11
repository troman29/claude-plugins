import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BindingEntry } from '../src/registry'
import type { ShepherdConfig } from '../src/shepherd/config'
import type { Exec } from '../src/shepherd/owner'
import type { ShepherdEvent } from '../src/shepherd/protocol'
import { ShepherdRouter, type Clock, type DeliveryResult } from '../src/shepherd/router'
import type { SpawnResult } from '../src/shepherd/spawn'
import { ShepherdStore } from '../src/shepherd/store'

export const START_MS = Date.parse('2026-11-11T00:00:00Z')
export const SHA = 'a'.repeat(40)
export const SHA2 = 'b'.repeat(40)
export const SHA3 = 'c'.repeat(40)
export const SHA4 = 'd'.repeat(40)
export const SERVICE = '-100/1'
export const OWNER_KEY = '-100/42'

export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'shepherd-'))

export class FakeClock implements Clock {
  private ms = START_MS
  private timers: { at: number; fn: () => void }[] = []

  now(): number {
    return this.ms
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.ms + ms, fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter(other => other !== timer)
    }
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  async advance(ms: number): Promise<void> {
    const target = this.ms + ms
    await this.settle()
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) {
        break
      }
      this.timers = this.timers.filter(timer => timer !== due)
      this.ms = Math.max(this.ms, due.at)
      due.fn()
      await this.settle()
    }
    this.ms = target
  }
}

export function event(kind: ShepherdEvent['kind'], extra: Record<string, unknown> = {}): ShepherdEvent {
  const base = {
    repo: 'windbit/agentek-console', pr: 1687, prUrl: 'https://github.com/windbit/agentek-console/pull/1687',
    prTitle: 'feat: shepherd', prAuthor: 'thomas5788', headRef: 'feat/x', headSha: SHA, baseRef: 'dev',
    actor: 'troman29', at: '2026-11-11T00:00:00Z',
  }
  const byKind: Record<string, Record<string, unknown>> = {
    pr_closed: { merged: true, mergedBy: 'troman29' },
    checks_completed: { conclusion: 'failure', suiteId: 1, app: 'GitHub Actions' },
    review: { state: 'changes_requested', id: 11, body: 'please fix', url: 'https://github.com/x/y/pull/1#r11', association: 'OWNER' },
    review_comment: { id: 12, body: 'nit', path: 'a.ts', line: 3, url: 'https://github.com/x/y/pull/1#c12', association: 'MEMBER' },
    comment: { id: 13, body: 'hello', url: 'https://github.com/x/y/pull/1#c13', association: 'COLLABORATOR' },
  }
  return { ...base, kind, ...byKind[kind], ...extra } as ShepherdEvent
}

export const request = (deliveryId: string, ev: ShepherdEvent) => ({ op: 'pr-event', v: 1, deliveryId, event: ev })

export type GhCheck = { name: string; state: string; link?: string; bucket: string }

export type Harness = ReturnType<typeof harness>

export function harness(options: { dir?: string; mode?: 'on' | 'shadow' | 'off'; clock?: FakeClock } = {}) {
  const dir = options.dir ?? tempDir()
  const clock = options.clock ?? new FakeClock()
  const store = new ShepherdStore(join(dir, 'shepherd'), () => clock.now())
  const state = {
    config: {
      repos: { 'windbit/agentek-console': options.mode ?? 'on' }, serviceChat: SERVICE, trustedLogins: new Set<string>(),
      primary: true, fanout: false, spawn: {}, agentAuthors: new Set(['thomas5788']),
    } as ShepherdConfig,
    spawnResult: { kind: 'no-mapping' } as SpawnResult,
    spawnCalls: [] as string[],
    reopened: [] as string[],
    reopenFails: false,
    bindings: { [OWNER_KEY]: { dir: '/w/one' } } as Record<string, BindingEntry>,
    git: { '/w/one': { branch: 'feat/x', remote: 'git@github.com:windbit/agentek-console.git' } } as Record<string, { branch: string; remote: string }>,
    head: { headRefOid: SHA, state: 'OPEN' },
    checks: [] as GhCheck[],
    deliverResults: [] as DeliveryResult[],
    ghCalls: 0,
    ghCommands: [] as string[][],
  }
  const delivered: { key: string; text: string }[] = []
  const posts: { target: string; text: string; silent: boolean }[] = []
  const exec: Exec = async cmd => {
    if (cmd[0] === 'git') {
      const info = state.git[cmd[2]!]
      const out = cmd[3] === 'branch' ? info?.branch : info?.remote
      return { code: out ? 0 : 1, stdout: out ?? '' }
    }
    state.ghCalls++
    state.ghCommands.push(cmd)
    if (cmd[2] === 'merge') {
      return { code: 0, stdout: '' }
    }
    if (cmd[2] === 'view') {
      return { code: 0, stdout: JSON.stringify(state.head) }
    }
    return { code: 8, stdout: JSON.stringify(state.checks) }
  }
  const router = new ShepherdRouter({
    store, clock, exec, config: () => state.config, bindings: () => state.bindings,
    deliver: async (key, text) => {
      delivered.push({ key, text })
      return state.deliverResults.shift() ?? 'ok'
    },
    post: async (target, text, { silent }) => void posts.push({ target, text, silent }),
    reopenTopic: async key => {
      if (state.reopenFails) {
        throw new Error('TOPIC_ID_INVALID')
      }
      state.reopened.push(key)
    },
    spawn: async ev => {
      state.spawnCalls.push(`${ev.repo}#${ev.pr}`)
      return state.spawnResult
    },
    log: () => {},
  })
  const send = async (deliveryId: string, ev: ShepherdEvent) => {
    const reply = await router.accept(request(deliveryId, ev))
    await clock.settle()
    return reply
  }
  const unowned = async (deliveryId: string) => {
    const reply = await router.accept({ op: 'pr-unowned', v: 1, deliveryId })
    await clock.settle()
    return reply
  }
  return { dir, clock, store, state, router, delivered, posts, send, unowned }
}
