import { describe, expect, test } from 'bun:test'
import { shouldAutospawnHub } from '../src/hub-autospawn'

describe('hub autospawn ownership', () => {
  test('an installed Linux user unit is the exclusive owner even while its socket is absent', () => {
    const exists = (path: string) => path === '/home/u/.config/systemd/user/telegram-hub.service'
    expect(shouldAutospawnHub({ enabled: true, platform: 'linux', home: '/home/u', exists })).toBe(false)
  })

  test('an installed macOS launch agent is also exclusive', () => {
    const exists = (path: string) => path === '/Users/u/Library/LaunchAgents/dev.windbit.claude-telegram.plist'
    expect(shouldAutospawnHub({ enabled: true, platform: 'darwin', home: '/Users/u', exists })).toBe(false)
  })

  test('standalone installs retain autospawn, explicit disable always wins', () => {
    const exists = () => false
    expect(shouldAutospawnHub({ enabled: true, platform: 'linux', home: '/home/u', exists })).toBe(true)
    expect(shouldAutospawnHub({ enabled: false, platform: 'linux', home: '/home/u', exists })).toBe(false)
  })
})
