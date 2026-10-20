// Все агенты — окна ОДНОЙ tmux-сессии: `tmux attach -t agents` показывает их разом, окно
// биндинга зовётся его именем. Сессии, поднятые до этого (по сессии на биндинг), переезжают
// в общую сессию окном при первом обращении — процессы в них не перезапускаются.
import type { Mux } from './types'

export const AGENTS_SESSION = 'agents'
// `window-size manual` держит размер окон фиксированным, когда кто-то подключился с маленького
// экрана: иначе сужались бы все агенты сразу, а пикеры и /screen парсят экран.
const WINDOW_SIZE = '200x100'
const SHELL_SETTLE_MS = 700
const SYSTEMD_RUN = Bun.which('systemd-run')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function tmux(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'ignore', stderr: 'pipe' })
  if ((await proc.exited) !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
  }
}

async function tmuxOut(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  return { ok: (await proc.exited) === 0, out }
}

const windowTarget = (name: string) => `=${AGENTS_SESSION}:=${name}`

async function windowNames(): Promise<string[]> {
  const { ok, out } = await tmuxOut('list-windows', '-t', `=${AGENTS_SESSION}`, '-F', '#{window_name}')
  return ok ? out.split('\n').filter(Boolean) : []
}

async function sessionExists(name: string): Promise<boolean> {
  return (await tmuxOut('has-session', '-t', `=${name}`)).ok
}

// Имя: иначе tmux переименует окно в `claude`/`codex` по переднему процессу, и хаб потеряет его.
// Размер — опция окна, а не сессии: ставим каждому окну, `default-size` сессии задаёт его значение.
async function pinWindow(target: string): Promise<void> {
  await tmux('set-option', '-w', '-t', target, 'automatic-rename', 'off')
  await tmux('set-option', '-w', '-t', target, 'allow-rename', 'off')
  await tmux('set-option', '-w', '-t', target, 'window-size', 'manual')
}

/** Сессия биндинга из прежней схемы → окно общей сессии. true — переехала. */
async function adoptLegacySession(name: string): Promise<boolean> {
  if (!(await sessionExists(name))) {
    return false
  }
  const { out } = await tmuxOut('display-message', '-p', '-t', `=${name}:`, '#{window_id}')
  const windowId = out.trim()
  if (!windowId) {
    return false
  }
  if (await sessionExists(AGENTS_SESSION)) {
    await tmux('move-window', '-d', '-s', windowId, '-t', `=${AGENTS_SESSION}:`)
  } else {
    await tmux('rename-session', '-t', `=${name}`, AGENTS_SESSION)
    await configureSession()
  }
  await tmux('rename-window', '-t', windowId, name)
  await pinWindow(windowId)
  return true
}

// Цель `=agents:` — с двоеточием: голое `=agents` set-option ищет как окно и не находит.
async function configureSession(): Promise<void> {
  await tmux('set-option', '-t', `=${AGENTS_SESSION}:`, 'default-size', WINDOW_SIZE)
}

// Первый `tmux new-session` нового сервера — прямой потомок хаба и унаследовал бы его cgroup:
// рестарт или падение хаба (KillMode=control-group) снёс бы сервер со всеми агентами. Свой
// scope от systemd-run отвязывает сервер. Без systemd (macOS) — обычный запуск: launchd так не гасит.
async function createSession(name: string, dir: string): Promise<void> {
  const [width, height] = WINDOW_SIZE.split('x')
  const args = ['tmux', 'new-session', '-d', '-x', width!, '-y', height!, '-s', AGENTS_SESSION, '-n', name, '-c', dir]
  const argv = SYSTEMD_RUN
    ? [SYSTEMD_RUN, '--user', '--scope', '--collect', `--unit=tmux-server-${AGENTS_SESSION}`, '--', ...args]
    : args
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' })
  if ((await proc.exited) !== 0) {
    throw new Error(`tmux new-session failed: ${await new Response(proc.stderr).text()}`)
  }
  await configureSession()
}

// Два подъёма разных биндингов при пустом сервере оба увидели бы, что сессии нет, и второй
// упал бы на «duplicate session». Проверка и создание идут под одним замком: очередь промисов,
// хвост которой занимается синхронно, до первого await.
let sessionLock: Promise<unknown> = Promise.resolve()

/** Создать сессию `agents` с первым окном `name`; false — сессия уже была, окно не создано. */
function createSessionOnce(name: string, dir: string): Promise<boolean> {
  const run = sessionLock.then(async () => {
    if (await sessionExists(AGENTS_SESSION)) {
      return false
    }
    await createSession(name, dir)
    return true
  })
  sessionLock = run.catch(() => {})
  return run
}

export const tmuxMux: Mux = {
  kind: 'tmux',

  async has(name) {
    return (await windowNames()).includes(name) || adoptLegacySession(name)
  },

  async ensure(name, dir) {
    if (await this.has(name)) {
      return false
    }
    if (!(await createSessionOnce(name, dir))) {
      await tmux('new-window', '-d', '-t', `=${AGENTS_SESSION}:`, '-n', name, '-c', dir)
    }
    await pinWindow(windowTarget(name))
    await sleep(SHELL_SETTLE_MS) // шелл должен подняться до send-keys
    return true
  },

  async kill(name) {
    await tmux('kill-window', '-t', windowTarget(name)).catch(() => {})
    await tmux('kill-session', '-t', `=${name}`).catch(() => {}) // сессия прежней схемы, если не переехала
  },

  prestartTarget: windowTarget,

  isPaneId: target => target.startsWith('%'),

  async sendKeys(target, ...keys) {
    await tmux('send-keys', '-t', target, ...keys)
  },

  async typeLiteral(target, text) {
    await tmux('send-keys', '-t', target, '-l', '--', text)
  },

  async capture(target, opts) {
    return (await tmuxOut('capture-pane', ...(opts?.ansi ? ['-e'] : []), '-p', '-t', target)).out
  },

  async currentCommand(target) {
    return (await tmuxOut('display-message', '-p', '-t', target, '#{pane_current_command}')).out.trim()
  },

  paneFromEnv: read => read('TMUX_PANE') || undefined,
}
