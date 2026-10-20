// herdr (https://herdr.dev): мультиплексор, который сам видит агентов в пейнах и показывает их
// состояние в сайдбаре. Биндинг — свой workspace с меткой = имя окна; все workspace живут в
// одной именованной сессии herdr, поэтому `herdr session attach agents` показывает всех разом.
// Хаб ходит в herdr только через его CLI: JSON-ответы стабильнее разбора экрана.
import { readFileSync } from 'fs'
import type { Mux } from './types'

const SESSION = process.env.TELEGRAM_HERDR_SESSION?.trim() || 'agents'
const PANE_ID_RE = /^w\d+:p\d+$/
const PRESTART_PREFIX = 'herdr-ws:'
const SERVER_START_TIMEOUT_MS = 10_000
const SERVER_POLL_MS = 200
const SYSTEMD_RUN = Bun.which('systemd-run')

// Клавиши хаба названы по-tmux'овски; herdr понимает свои имена. Всё, чего нет в таблице и что
// не выглядит как `C-x`, — буквальный текст, как у `tmux send-keys`.
const KEY_NAMES: Record<string, string> = {
  Enter: 'enter', Escape: 'esc', Tab: 'tab', Space: 'space', BSpace: 'backspace',
  Up: 'up', Down: 'down', Left: 'left', Right: 'right',
}
const CTRL_KEY_RE = /^C-(.)$/
const SINGLE_KEY_RE = /^[0-9a-zA-Z]$/

type Workspace = { workspace_id: string; label?: string }
type Pane = { pane_id: string; workspace_id: string }
type ProcessInfo = { shell_pid?: number; foreground_processes?: { name?: string }[] }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function herdr(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(['herdr', '--session', SESSION, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { ok: (await proc.exited) === 0, out, err }
}

/** Ответ CLI — `{"result": …}` или `{"error": …}`; ошибка — исключение с текстом herdr.
 *  Команды ввода (send-keys, send-text) на успехе молчат: пустой вывод с кодом 0 — успех. */
async function call<T>(...args: string[]): Promise<T> {
  const { ok, out, err } = await herdr(...args)
  const parsed = (out.trim() ? JSON.parse(out) : {}) as { result?: T; error?: { message?: string } }
  if (!ok || parsed.error) {
    throw new Error(`herdr ${args.join(' ')} failed: ${parsed.error?.message ?? err.trim()}`)
  }
  return parsed.result as T
}

async function serverUp(): Promise<boolean> {
  return (await herdr('workspace', 'list')).ok
}

// Как и сервер tmux, сервер herdr не должен жить в cgroup хаба: рестарт хаба снёс бы всех агентов.
async function ensureServer(): Promise<void> {
  if (await serverUp()) {
    return
  }
  const args = ['herdr', '--session', SESSION, 'server']
  const argv = SYSTEMD_RUN
    ? [SYSTEMD_RUN, '--user', '--collect', `--unit=herdr-server-${SESSION}`, '--', ...args]
    : args
  Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref()
  for (let waited = 0; waited < SERVER_START_TIMEOUT_MS; waited += SERVER_POLL_MS) {
    await sleep(SERVER_POLL_MS)
    if (await serverUp()) {
      return
    }
  }
  throw new Error(`herdr server (session ${SESSION}) did not come up`)
}

async function workspaces(): Promise<Workspace[]> {
  if (!(await serverUp())) {
    return []
  }
  return (await call<{ workspaces: Workspace[] }>('workspace', 'list')).workspaces
}

async function workspaceByLabel(name: string): Promise<Workspace | undefined> {
  return (await workspaces()).find(ws => ws.label === name)
}

/** Id пейна: свой или корневой пейн workspace, на который указывает prestartTarget. */
async function resolvePane(target: string): Promise<string> {
  if (!target.startsWith(PRESTART_PREFIX)) {
    return target
  }
  const ws = await workspaceByLabel(target.slice(PRESTART_PREFIX.length))
  if (!ws) {
    throw new Error(`herdr workspace ${target} not found`)
  }
  const { panes } = await call<{ panes: Pane[] }>('pane', 'list')
  const pane = panes.find(p => p.workspace_id === ws.workspace_id)
  if (!pane) {
    throw new Error(`herdr workspace ${target} has no pane`)
  }
  return pane.pane_id
}

/** Клавиши tmux → вызовы herdr: подряд идущие клавиши одним send-keys, текст — send-text. */
export function herdrKeyBatches(keys: string[]): { kind: 'keys' | 'text'; values: string[] }[] {
  const batches: { kind: 'keys' | 'text'; values: string[] }[] = []
  for (const key of keys) {
    const ctrl = CTRL_KEY_RE.exec(key)
    const named = KEY_NAMES[key] ?? (ctrl ? `ctrl+${ctrl[1]!.toLowerCase()}` : SINGLE_KEY_RE.test(key) ? key : undefined)
    const kind = named ? 'keys' : 'text'
    const last = batches[batches.length - 1]
    if (last?.kind === kind && kind === 'keys') {
      last.values.push(named!)
    } else {
      batches.push({ kind, values: [named ?? key] })
    }
  }
  return batches
}

function shellName(pid?: number): string {
  if (!pid) {
    return ''
  }
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return ''
  }
}

export const herdrMux: Mux = {
  kind: 'herdr',

  async has(name) {
    return !!(await workspaceByLabel(name))
  },

  // Сервер поднимаем ДО проверки: стартуя, herdr восстанавливает workspace прошлой жизни, и
  // проверка на остановленном сервере не видела бы их — рядом вырастал бы тёзка.
  async ensure(name, dir) {
    await ensureServer()
    if (await this.has(name)) {
      return false
    }
    await call('workspace', 'create', '--cwd', dir, '--label', name, '--no-focus')
    return true
  },

  // herdr сохраняет workspace между рестартами сервера и поднимает их обратно; закрываем все с
  // этой меткой, чтобы тёзка, оставшийся от прошлой жизни сервера, не пережил /unbind.
  async kill(name) {
    for (const ws of (await workspaces()).filter(w => w.label === name)) {
      await call('workspace', 'close', ws.workspace_id)
    }
  },

  prestartTarget: name => `${PRESTART_PREFIX}${name}`,

  isPaneId: target => PANE_ID_RE.test(target),

  async sendKeys(target, ...keys) {
    const pane = await resolvePane(target)
    for (const batch of herdrKeyBatches(keys)) {
      if (batch.kind === 'keys') {
        await call('pane', 'send-keys', pane, ...batch.values)
      } else {
        await call('pane', 'send-text', pane, batch.values[0]!)
      }
    }
  },

  async typeLiteral(target, text) {
    await call('pane', 'send-text', await resolvePane(target), text)
  },

  async capture(target, opts) {
    const pane = await resolvePane(target)
    const { ok, out } = await herdr('pane', 'read', pane, '--source', 'visible', '--format', opts?.ansi ? 'ansi' : 'text')
    return ok ? out : ''
  },

  async currentCommand(target) {
    const info = await call<{ process_info: ProcessInfo }>('pane', 'process-info', '--pane', await resolvePane(target))
    const fg = info.process_info.foreground_processes ?? []
    return fg[fg.length - 1]?.name ?? shellName(info.process_info.shell_pid)
  },

  paneFromEnv: read => read('HERDR_PANE_ID') || undefined,
}
