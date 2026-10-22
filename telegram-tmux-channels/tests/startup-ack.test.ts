import { describe, expect, test } from 'bun:test'
import { startupAckKey, startupAckPrefix } from '../src/startup-ack'

describe('startup prompt acknowledgement identity', () => {
  test('uses one stable key before and after the stub reveals a pane id', () => {
    const session = { bindingKeys: ['-100/42'], cwd: '/workspace' }
    expect(startupAckKey(session, '=project---100-42:')).toBe(startupAckKey(session, '%38'))
  })

  test('falls back to the terminal target without binding identity', () => {
    expect(startupAckKey({}, '%38')).toBe('%38')
  })

  test('binding prefix matches its own identity but not a binding whose key extends it', () => {
    const own = startupAckKey({ bindingKeys: ['-100/4'], cwd: '/w' }, '%1')
    const other = startupAckKey({ bindingKeys: ['-100/42'], cwd: '/w' }, '%2')
    expect(own.startsWith(startupAckPrefix('-100/4'))).toBe(true)
    expect(other.startsWith(startupAckPrefix('-100/4'))).toBe(false)
  })
})
