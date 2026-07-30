import { describe, expect, test } from 'bun:test'
import { emptyStatus, hasLiveWork, renderStatus, statusIsEmpty } from '../src/status-render'

describe('status-render', () => {
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
    s.bg.push({ command: 'npm test', description: 'Run tests' })
    s.skills.push({ skill: 'ponytail' })
    const out = renderStatus(s)
    expect(statusIsEmpty(s)).toBe(false)
    expect(out).toContain('🟡 Review diff')
    expect(out).toContain('🟡 Ship it')
    expect(out).toContain('✅ write test')
    expect(out).toContain('Run tests') // description preferred over the raw command
    expect(out).toContain('ponytail')
    expect(out.indexOf('Review diff')).toBeLessThan(out.indexOf('Ship it'))
    expect(out.split('\n\n').length).toBe(9) // 5 sections, each header split from its body
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
