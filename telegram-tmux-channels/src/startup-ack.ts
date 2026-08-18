import type { SessionInfo } from './protocol'

// Before the MCP stub connects the same terminal is addressed by its tmux session target;
// afterwards it is addressed by pane id. Deduping by either address lets a stale screen frame
// receive a second Enter, which can land on the next dialog. A binding is the stable identity
// shared by both phases.
export function startupAckKey(session: Pick<SessionInfo, 'bindingKeys' | 'cwd'>, fallback: string): string {
  const key = session.bindingKeys?.[0]
  return key && session.cwd ? `binding:${key}\0${session.cwd}` : fallback
}

