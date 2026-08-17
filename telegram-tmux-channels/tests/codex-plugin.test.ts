import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '..')

describe('Codex plugin package', () => {
  test('ships a valid local stdio Telegram MCP server with the plugin', () => {
    const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8')) as {
      name: string; mcpServers?: string
    }
    expect(manifest.name).toBe('telegram-tmux-channels')
    expect(manifest.mcpServers).toBe('./.mcp.json')

    const config = JSON.parse(readFileSync(join(root, manifest.mcpServers!), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string }>
    }
    expect(config.mcpServers?.telegram).toEqual({ cwd: '.', command: 'bun', args: ['src/stub.ts'] })
    expect(existsSync(join(root, 'src/stub.ts'))).toBe(true)
  })

  test('hook commands work under either plugin root variable', () => {
    const hooks = readFileSync(join(root, 'hooks/hooks.json'), 'utf8')
    expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/src/subagent-hook.ts')
    expect(hooks).toContain('"matcher": "^(Agent|Task|spawn_agent)$"')
    expect(hooks).toContain('"PreCompact"')
    expect(hooks).toContain('compaction-start')
  })
})
