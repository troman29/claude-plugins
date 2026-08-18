import { describe, expect, test } from 'bun:test'
import { startupAckKey } from '../src/startup-ack'

describe('startup prompt acknowledgement identity', () => {
  test('uses one stable key before and after the stub reveals a pane id', () => {
    const session = { bindingKeys: ['-100/42'], cwd: '/workspace' }
    expect(startupAckKey(session, '=project---100-42:')).toBe(startupAckKey(session, '%38'))
  })

  test('falls back to the terminal target without binding identity', () => {
    expect(startupAckKey({}, '%38')).toBe('%38')
  })
})
