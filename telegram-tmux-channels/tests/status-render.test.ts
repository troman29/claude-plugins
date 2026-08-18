import { describe, expect, test } from 'bun:test'
import { deserializeStatus, emptyStatus, hasLiveWork, renderBg, renderStatus, serializeStatus, statusIsEmpty, syncBg, type BgTask } from '../src/status-render'

describe('status-render', () => {
  test('status state survives JSON serialization without losing Map identity', () => {
    const state = emptyStatus()
    state.agents.set('a', { name: 'worker', done: false })
    state.tasks.set('t', { subject: 'test', status: 'in_progress' })
    const restored = deserializeStatus(JSON.parse(JSON.stringify(serializeStatus(state))))
    expect(restored.agents.get('a')).toEqual({ name: 'worker', done: false })
    expect(restored.tasks.get('t')?.status).toBe('in_progress')
  })

  test('empty state renders nothing and reports empty', () => {
    const s = emptyStatus()
    expect(statusIsEmpty(s)).toBe(true)
    expect(renderStatus(s)).toBe('')
    expect(hasLiveWork(s)).toBe(false)
  })

  test('one bubble carries every section, agents first', () => {
    const s = emptyStatus()
    s.agents.set('a1', { name: 'Review diff', done: false })
    s.tasks.set('1', { subject: 'Ship it', status: 'in_progress' })
    s.todos = [{ content: 'write test', status: 'completed' }]
    s.skills.push({ skill: 'ponytail' })
    const out = renderStatus(s)
    expect(statusIsEmpty(s)).toBe(false)
    expect(out).toContain('🟡 Review diff')
    expect(out).toContain('🟡 Ship it')
    expect(out).toContain('✅ write test')
    expect(out).toContain('ponytail')
    expect(out.indexOf('Review diff')).toBeLessThan(out.indexOf('Ship it'))
    expect(out.split('\n\n').length).toBe(7) // 4 sections, each header split from its body
  })

  test('a shell missing from the Stop hook list has finished', () => {
    const bg: BgTask[] = [{ command: 'sleep 30', description: 'Wait' }, { command: 'npm run dev' }]
    expect(renderBg(bg)).toContain('▶️ Wait') // description preferred over the raw command

    // Stop still names both → nothing to say, so no Telegram edit
    expect(syncBg(bg, [{ command: 'sleep 30' }, { command: 'npm run dev' }])).toBe(false)

    // sleep finished; the dev server is still up and stays running
    expect(syncBg(bg, [{ command: 'npm run dev' }])).toBe(true)
    expect(renderBg(bg)).toContain('✅ Wait')
    expect(renderBg(bg)).toContain('▶️ npm run dev')
    expect(syncBg(bg, [{ command: 'npm run dev' }])).toBe(false) // idempotent

    // a foreground command Claude Code backgrounded itself: Stop is the first we hear of it
    expect(syncBg(bg, [{ command: 'npm run dev' }, { command: 'slow-build', description: 'Build' }])).toBe(true)
    expect(renderBg(bg)).toContain('▶️ Build')

    // a finished shell keeps its ✅ line — the run's message is its history, not a live list
    expect(syncBg(bg, [])).toBe(true)
    expect(bg.filter(b => b.done)).toHaveLength(3)
  })

  test('identical agent names collapse into one counted line', () => {
    const s = emptyStatus()
    s.agents.set('a1', { name: 'worker', done: true })
    s.agents.set('a2', { name: 'worker', done: false })
    expect(renderStatus(s)).toContain('🟡 worker 1/2')
    expect(hasLiveWork(s)).toBe(true)
    s.agents.get('a2')!.done = true
    expect(renderStatus(s)).toContain('✅ worker ×2')
    expect(hasLiveWork(s)).toBe(false)
  })

  test('html in names is escaped, long lists are capped', () => {
    const s = emptyStatus()
    s.agents.set('a1', { name: '<script>x</script>', done: false })
    expect(renderStatus(s)).toContain('&lt;script&gt;')
    const big = emptyStatus()
    for (let i = 0; i < 30; i++) big.tasks.set(String(i), { subject: `t${i}`, status: 'pending' })
    expect(renderStatus(big)).toContain('… +5')
  })
})
