import { describe, expect, test } from 'bun:test'
import type { BindingEntry } from '../src/registry'
import type { Exec } from '../src/shepherd/owner'
import { MAX_LIVE_SPAWNED, spawnForPr, topicTitleFor, type SpawnDeps } from '../src/shepherd/spawn'
import { event } from './shepherd-helpers'

const BASE = '/p/agentek-console'
const WORKTREE = '/p/agentek-console--feat+x'
const CHAT = '-1001'

function setup(options: { porcelain?: string; localBranch?: boolean; fail?: string; mapped?: boolean } = {}) {
  const commands: string[][] = []
  const bindings: Record<string, BindingEntry> = {}
  const saved: { key: string; binding: BindingEntry }[] = []
  const topics: { chat: string; title: string }[] = []
  const exec: Exec = async cmd => {
    commands.push(cmd)
    const args = cmd.slice(3).join(' ')
    if (options.fail && args.startsWith(options.fail)) {
      return { code: 1, stdout: '' }
    }
    if (args === 'remote get-url origin') {
      return { code: 0, stdout: 'git@github.com:windbit/agentek-console.git\n' }
    }
    if (args === 'worktree list --porcelain') {
      return { code: 0, stdout: options.porcelain ?? `worktree ${BASE}\nHEAD abc\nbranch refs/heads/dev\n` }
    }
    if (args.startsWith('rev-parse')) {
      return { code: options.localBranch ? 0 : 1, stdout: '' }
    }
    return { code: 0, stdout: '' }
  }
  const deps: SpawnDeps = {
    exec, bindings: () => bindings, log: () => {},
    config: () => ({ spawn: options.mapped ? { 'windbit/agentek-console': { chat: CHAT, dir: BASE } } : {} }) as ReturnType<SpawnDeps['config']>,
    groups: () => ({ [CHAT]: { dir: BASE }, '-1002': { dir: '/p/other' }, '-1003': {} }),
    createTopic: async (chat, title) => {
      topics.push({ chat, title })
      return { key: `${chat}/55` }
    },
    saveBinding: async (key, binding) => void saved.push({ key, binding }),
  }
  return { deps, commands, bindings, saved, topics }
}

describe('spawnForPr', () => {
  test('fetch, worktree on the PR branch tracking origin, topic, binding', async () => {
    const s = setup()
    const result = await spawnForPr(s.deps, event('comment'))
    expect(result).toEqual({ kind: 'spawned', key: `${CHAT}/55` })
    const git = s.commands.map(cmd => cmd.slice(3).join(' ')).filter(line => !line.startsWith('remote') && !line.startsWith('worktree list'))
    expect(git).toEqual([
      'fetch origin feat/x',
      'rev-parse --verify --quiet refs/heads/feat/x',
      `worktree add --track -b feat/x ${WORKTREE} origin/feat/x`,
    ])
    expect(s.commands.every(cmd => cmd[0] === 'git' && !cmd.includes('-B') && !cmd.includes('reset'))).toBe(true)
    expect(s.topics).toEqual([{ chat: CHAT, title: 'agentek-console #1687 feat: shepherd' }])
    expect(s.saved).toEqual([{ key: `${CHAT}/55`, binding: { dir: WORKTREE, mode: 'worktree-plain', spawned: true } }])
  })

  test('the explicit shepherd.json mapping wins and needs no origin lookup', async () => {
    const s = setup({ mapped: true })
    await spawnForPr(s.deps, event('comment'))
    expect(s.commands.some(cmd => cmd.includes('remote'))).toBe(false)
    expect(s.topics[0]!.chat).toBe(CHAT)
  })

  test('an existing local branch is reused without reset and only fast-forwarded', async () => {
    const s = setup({ localBranch: true })
    await spawnForPr(s.deps, event('comment'))
    const lines = s.commands.map(cmd => cmd.slice(3).join(' '))
    expect(lines).toContain(`worktree add ${WORKTREE} feat/x`)
    expect(lines).toContain('merge --ff-only origin/feat/x')
    expect(lines.some(line => line.includes('-B') || line.includes('reset'))).toBe(false)
  })

  test('no mapping and no matching group', async () => {
    const s = setup()
    expect(await spawnForPr(s.deps, event('comment', { repo: 'windbit/unknown' }))).toEqual({ kind: 'no-mapping' })
    expect(s.topics).toEqual([])
  })

  test('branch already checked out: busy with that worktree, nothing created', async () => {
    const s = setup({ porcelain: `worktree ${BASE}\nHEAD a\nbranch refs/heads/dev\n\nworktree /p/wt\nHEAD b\nbranch refs/heads/feat/x\n` })
    expect(await spawnForPr(s.deps, event('comment'))).toEqual({ kind: 'busy', dir: '/p/wt' })
    expect(s.topics).toEqual([])
    expect(s.commands.some(cmd => cmd.includes('fetch'))).toBe(false)
  })

  test('a branch with a longer name sharing the prefix is not busy', async () => {
    const s = setup({ porcelain: `worktree /p/wt\nHEAD b\nbranch refs/heads/feat/x-2\n` })
    expect((await spawnForPr(s.deps, event('comment'))).kind).toBe('spawned')
  })

  test(`limit: ${MAX_LIVE_SPAWNED} live spawned sessions block a new one, closed ones do not count`, async () => {
    const s = setup()
    for (let n = 0; n < MAX_LIVE_SPAWNED; n++) {
      s.bindings[`-1/${n}`] = { dir: `/x/${n}`, spawned: true }
    }
    s.bindings['-1/0']!.closed = true
    expect((await spawnForPr(s.deps, event('comment'))).kind).toBe('spawned')
    s.bindings['-1/9'] = { dir: '/x/9', spawned: true }
    s.bindings['-1/0']!.closed = false
    expect(await spawnForPr(s.deps, event('comment'))).toEqual({ kind: 'limit' })
  })

  test('fetch failure is reported, no topic', async () => {
    const s = setup({ fail: 'fetch' })
    expect((await spawnForPr(s.deps, event('comment'))).kind).toBe('failed')
    expect(s.topics).toEqual([])
  })

  test('topic failure rolls the worktree back', async () => {
    const s = setup()
    s.deps.createTopic = async () => {
      throw new Error('forbidden')
    }
    expect(await spawnForPr(s.deps, event('comment'))).toEqual({ kind: 'failed', error: 'forbidden' })
    expect(s.commands.at(-1)!.slice(3)).toEqual(['worktree', 'remove', '--force', WORKTREE])
  })
})

describe('topicTitleFor', () => {
  test('at most 60 characters, ellipsis on overflow', () => {
    const title = topicTitleFor({ repo: 'windbit/agentek-console', pr: 1687, prTitle: 'x'.repeat(200) })
    expect(title).toHaveLength(60)
    expect(title.startsWith('agentek-console #1687 xxx')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
  })
})
