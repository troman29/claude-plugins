import { homedir } from 'os'
import { join } from 'path'

export type ClaudeBackend = 'claude' | 'chatgpt'

const DEFAULT_BACKEND: ClaudeBackend = 'claude'

export function parseClaudeBackend(value: string | undefined): ClaudeBackend | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'claude' || normalized === 'chatgpt' ? normalized : undefined
}

export function defaultClaudeBackend(value = process.env.TELEGRAM_CLAUDE_BACKEND): ClaudeBackend {
  if (!value?.trim()) {
    return DEFAULT_BACKEND
  }
  const backend = parseClaudeBackend(value)
  if (!backend) {
    throw new Error(`Unsupported Claude backend: ${value}`)
  }
  return backend
}

export function effectiveClaudeBackend(
  bindingBackend: ClaudeBackend | undefined,
  hostDefault = defaultClaudeBackend(),
): ClaudeBackend {
  return bindingBackend ?? hostDefault
}

export function chatgptEnvFile(): string {
  return process.env.TELEGRAM_CLAUDE_CHATGPT_ENV?.trim()
    || join(homedir(), '.claude', 'backends', 'chatgpt.env')
}
