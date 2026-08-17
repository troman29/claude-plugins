#!/usr/bin/env bun
// Short-lived Claude/Codex lifecycle hook. It normalizes each agent's hook payload into the
// shared hub protocol, writes one NDJSON message to hub.sock, and never blocks the agent.
import { SOCK_PATH } from './paths'
import { encode } from './protocol'
import { normalizeHookMessage, type HookMode } from './hook-normalize'
import { envOf, findAgentAncestor } from './proc'

const mode = process.argv[2] as HookMode | undefined
const VALID_MODES = new Set<HookMode>([
  'describe', 'start', 'stop', 'turnend', 'task-create', 'task-update',
  'skill', 'todo', 'bg', 'codex-plan', 'codex-skill', 'compaction-start', 'compaction-done',
])

function inheritedBindingKeys(): string[] {
  // Codex sanitises command-hook children exactly as it sanitises MCP children.  The durable
  // interactive parent retains the launch binding, so recover it there (Claude keeps passing it).
  const agent = findAgentAncestor(process.pid)
  return (process.env.TELEGRAM_BINDING_KEYS ?? (agent ? envOf(agent.pid, 'TELEGRAM_BINDING_KEYS') : '') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

async function main(): Promise<void> {
  const bindingKeys = inheritedBindingKeys()
  if (!bindingKeys.length || !mode || !VALID_MODES.has(mode)) return

  let raw = ''
  for await (const chunk of Bun.stdin.stream()) raw += Buffer.from(chunk).toString()
  let data: Record<string, unknown>
  try { data = JSON.parse(raw) } catch { return }

  const msg = normalizeHookMessage(mode, data, bindingKeys)
  if (!msg) return

  await new Promise<void>(resolve => {
    let done = false
    const finish = () => {
      if (!done) { done = true; resolve() }
    }
    setTimeout(finish, 2000)
    Bun.connect<undefined>({
      unix: SOCK_PATH,
      socket: {
        open(sock) { sock.write(encode(msg)); sock.end(); finish() },
        data() {},
        close: finish,
        error: finish,
      },
    }).catch(finish)
  })
}

await main()
