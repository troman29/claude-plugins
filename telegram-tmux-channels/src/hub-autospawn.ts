import { existsSync } from 'fs'
import { join } from 'path'

type Policy = {
  enabled: boolean
  platform: NodeJS.Platform
  home: string
  exists?: (path: string) => boolean
}

/** A configured service is the exclusive hub owner, including its short restart window. */
export function shouldAutospawnHub({ enabled, platform, home, exists = existsSync }: Policy): boolean {
  if (!enabled) return false
  const managed = platform === 'linux'
    ? join(home, '.config', 'systemd', 'user', 'telegram-hub.service')
    : platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', 'dev.windbit.claude-telegram.plist')
      : undefined
  return !managed || !exists(managed)
}
