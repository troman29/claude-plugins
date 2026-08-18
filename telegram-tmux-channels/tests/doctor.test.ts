import { describe, expect, test } from 'bun:test'
import { renderDoctor } from '../src/doctor'

describe('doctor report', () => {
  test('renders checks and an exact severity summary', () => {
    const text = renderDoctor('<b>Doctor</b>', [
      { level: 'ok', label: 'Hub', detail: 'running' },
      { level: 'warn', label: 'Voice', detail: 'disabled' },
      { level: 'fail', label: 'Pane', detail: 'missing' },
      { level: 'ok', label: 'API', detail: 'reachable' },
    ], (ok, warn, fail) => `${ok}/${warn}/${fail}`)

    expect(text).toContain('✅ <b>Hub</b> — running')
    expect(text).toContain('⚠️ <b>Voice</b> — disabled')
    expect(text).toContain('❌ <b>Pane</b> — missing')
    expect(text.endsWith('2/1/1')).toBe(true)
  })
})
