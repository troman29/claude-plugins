import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { agentAdapter, mayLearn, claudeAdapter, codexAdapter } from '../src/agents'
import {
  buildCodexLaunch, codexRollouts, codexSessionMtimes, codexTranscriptSawIncoming,
  codexSessionForIncoming, lastCodexAssistantText, recentCodexSessions,
  isCodexArgv, isCodexHeadlessArgv, codexPaneIsWorking, codexPaneReady, parseCodexError,
  codexCanOpenStatusPanel, parseCodexStatusPanel,
} from '../src/agents/codex'

describe('agent adapter registry', () => {
  test('old bindings remain Claude and both explicit adapters resolve', () => {
    expect(agentAdapter(undefined)).toBe(claudeAdapter)
    expect(agentAdapter('claude')).toBe(claudeAdapter)
    expect(agentAdapter('codex')).toBe(codexAdapter)
  })

  test('every advertised parity capability has a boolean value', () => {
    expect(Object.keys(claudeAdapter.capabilities)).toEqual(Object.keys(codexAdapter.capabilities))
    for (const adapter of [claudeAdapter, codexAdapter]) {
      expect(Object.values(adapter.capabilities).every(v => typeof v === 'boolean')).toBe(true)
    }
  })

  test('uses a native live history picker only where the TUI actually supports one', () => {
    expect(claudeAdapter.capabilities.liveResumePicker).toBe(true)
    expect(codexAdapter.capabilities.liveResumePicker).toBe(false)
  })

  test('uses only reliable session-id sources for each CLI', () => {
    expect(claudeAdapter.capabilities.captureSessionIdAtLaunch).toBe(true)
    expect(claudeAdapter.capabilities.hookSessionIdReliable).toBe(true)
    expect(codexAdapter.capabilities.captureSessionIdAtLaunch).toBe(false)
    expect(codexAdapter.capabilities.hookSessionIdReliable).toBe(false)
  })

  test('agent-specific launch environment stays behind the adapter contract', () => {
    expect(claudeAdapter.launchEnvPrefix(['dm:7'])).toContain('CLAUDE_CODE_DISABLE_RESUME_PROMPT=1')
    expect(claudeAdapter.launchEnvPrefix(['dm:7'])).toContain('TELEGRAM_BINDING_KEYS')
    expect(codexAdapter.launchEnvPrefix(['dm:7'])).toContain('TELEGRAM_BINDING_KEYS')
    expect(codexAdapter.launchEnvPrefix(['dm:7'])).not.toContain('CLAUDE_CODE_DISABLE_RESUME_PROMPT')
  })

  test('recognises only its own live pane command for foreign-pane protection', () => {
    expect(claudeAdapter.isPaneCommand('claude')).toBe(true)
    expect(claudeAdapter.isPaneCommand('codex')).toBe(false)
    expect(codexAdapter.isPaneCommand('/usr/local/bin/codex')).toBe(true)
    expect(codexAdapter.isPaneCommand('zsh')).toBe(false)
  })
})

describe('Codex CLI adapter', () => {
  test('recognises standalone and absolute Codex binaries only', () => {
    expect(isCodexArgv(['codex'])).toBe(true)
    expect(isCodexArgv(['/home/u/.local/bin/codex', '--no-alt-screen'])).toBe(true)
    expect(isCodexArgv(['node', '/x/codex-helper.js'])).toBe(false)
  })

  test('distinguishes interactive sessions from exec and review', () => {
    expect(isCodexHeadlessArgv(['codex', 'exec', 'hello'])).toBe(true)
    expect(isCodexHeadlessArgv(['codex', 'review'])).toBe(true)
    expect(isCodexHeadlessArgv(['codex', '--no-alt-screen'])).toBe(false)
  })

  // Запуск всегда несёт `--ask-for-approval never` и полный доступ: за терминалом никого нет,
  // а первым же вопросом на одобрение становится наш собственный `reply` (см. describe ниже).
  test('builds deterministic new, resume and fork launches', () => {
    const A = '--ask-for-approval never --sandbox danger-full-access'
    expect(buildCodexLaunch(['codex', '--no-alt-screen'], 'new')).toBe(`codex ${A} --no-alt-screen`)
    expect(buildCodexLaunch(['codex', '--no-alt-screen'], 'resume', 'abc')).toBe(`codex ${A} --no-alt-screen resume abc`)
    expect(buildCodexLaunch(['codex'], 'resume')).toBe(`codex ${A} resume --last`)
    expect(buildCodexLaunch(['codex'], 'fork', 'abc')).toBe(`codex ${A} fork abc`)
    expect(buildCodexLaunch(['codex', 'resume', 'old'], 'fork', 'new')).toBe(`codex ${A} fork new`)
  })

  test('recognises real 0.147 idle/working panes and errors', () => {
    const padding = '\n'.repeat(80) // real tmux capture-pane keeps empty bottom rows
    const idle = '› Find and fix a bug in @filename\n\n  gpt-5.6-sol default · ~/projects/homelab\n' + padding
    const working = '› Reply exactly PROBE\n\n• Working (0s • esc to interrupt)\n\n› Find and fix a bug in @filename\n' + padding
    expect(codexPaneReady(idle)).toBe(true)
    expect(codexPaneIsWorking(idle)).toBe(false)
    expect(codexPaneReady(working)).toBe(false)
    expect(codexPaneIsWorking(working)).toBe(true)
    expect(parseCodexError('• Error: stream disconnected')).toBe('Error: stream disconnected')
  })

  test('parses the real 0.147 /status panel and never opens over a draft', () => {
    const panel = `╭────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.147.0)                                    │
│  Model:                              gpt-5.6-sol (reasoning low) │
│  Context window:                     98% left (17.8K used / 258K)│
│  Weekly limit:                       [██████████████████░░] 88% left (resets 03:33 on 20 Aug) │
│  GPT-5.3-Codex-Spark Weekly limit:   [████████████████████] 100% left (resets 09:54 on 22 Aug) │
│  Warning:                            limits may be stale - run /status again shortly. │
╰────────────────────────────────────────────────────────────────╯`
    expect(parseCodexStatusPanel(panel)).toEqual({
      model: 'gpt-5.6-sol', contextUsedPct: 2, contextLeftPct: 98, stale: true,
      limits: [
        { label: 'Weekly limit', remainingPct: 88, resets: '03:33 on 20 Aug' },
        { label: 'GPT-5.3-Codex-Spark Weekly limit', remainingPct: 100, resets: '09:54 on 22 Aug' },
      ],
    })
    expect(codexCanOpenStatusPanel('› Find and fix a bug in @filename\n\n  gpt-5.6-sol default')).toBe(true)
    expect(codexCanOpenStatusPanel('› do not submit this local draft\n\n  gpt-5.6-sol default')).toBe(false)
    expect(codexCanOpenStatusPanel('› Implement {feature}\n\n  gpt-5.6-sol default', '\u001b[0;1m›\u001b[0m \u001b[2mImplement {feature}\u001b[0m')).toBe(true)
    expect(codexCanOpenStatusPanel('› do not submit this local draft\n\n  gpt-5.6-sol default', '\u001b[0;1m›\u001b[0m do not submit this local draft')).toBe(false)
  })

  test('reads the matching rollout and ignores another cwd', () => {
    const root = join(tmpdir(), `tmux-channels-codex-${process.pid}-${Date.now()}`)
    const sessions = join(root, 'sessions', '2026', '08', '14')
    mkdirSync(sessions, { recursive: true })
    const oldHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = root
    const now = new Date().toISOString()
    const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: now, type, payload })
    writeFileSync(join(sessions, 'rollout-mine.jsonl'), [
      row('session_meta', { id: 'mine', cwd: '/work/mine' }),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\\n  <cwd>/work/mine</cwd>\\n</environment_context>' }] }),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Telegram message; chat_id="-1" topic_id="7"]\nhello telegram' }] }),
      row('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'working' }] }),
      row('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done' }] }),
    ].join('\n') + '\n')
    writeFileSync(join(sessions, 'rollout-other.jsonl'), row('session_meta', { id: 'other', cwd: '/work/other' }) + '\n')
    try {
      expect(codexRollouts('/work/mine')).toHaveLength(1)
      expect([...codexSessionMtimes('/work/mine').keys()]).toEqual(['mine'])
      expect(recentCodexSessions('/work/mine')[0]?.snippet).toBe('hello telegram')
      expect(codexTranscriptSawIncoming('/work/mine', Date.now() - 1000, 'telegram')).toBe(true)
      expect(codexSessionForIncoming('/work/mine', Date.now() - 1000, 'telegram')).toBe('mine')
      expect(lastCodexAssistantText('/work/mine', Date.now() - 1000, 'mine')).toBe('done')
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = oldHome
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('correlates same-text messages in a shared directory by their delivery marker', () => {
    const root = join(tmpdir(), `tmux-channels-codex-shared-${process.pid}-${Date.now()}`)
    const sessions = join(root, 'sessions', '2026', '08', '17')
    mkdirSync(sessions, { recursive: true })
    const oldHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = root
    const now = new Date().toISOString()
    const row = (id: string, marker: string) => [
      JSON.stringify({ timestamp: now, type: 'session_meta', payload: { id, cwd: '/work/shared' } }),
      JSON.stringify({ timestamp: now, type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Telegram message; delivery_id=${JSON.stringify(marker)}]\nyes` }],
      } }),
    ].join('\n') + '\n'
    writeFileSync(join(sessions, 'rollout-first.jsonl'), row('first', 'd-first'))
    writeFileSync(join(sessions, 'rollout-second.jsonl'), row('second', 'd-second'))
    try {
      expect(codexSessionForIncoming('/work/shared', Date.now() - 1000, 'delivery_id="d-first"')).toBe('first')
      expect(codexSessionForIncoming('/work/shared', Date.now() - 1000, 'delivery_id="d-second"')).toBe('second')
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = oldHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Пикер харнесса (2026-08-17): один переключатель вместо пары кнопок на каждый режим.
// Здесь — то, что можно проверить без Telegram: cmdline не должен переезжать чужому агенту.
describe('харнесс и cmdline группы', () => {
  test('codex не наследует cmdline, написанный для claude', () => {
    const claudeArgv = ['claude', '--permission-mode', 'bypassPermissions']
    expect(agentAdapter('claude').isProcessArgv(claudeArgv)).toBe(true)
    expect(agentAdapter('codex').isProcessArgv(claudeArgv)).toBe(false) // → в биндинг не попадёт
  })

  test('свой cmdline агент забирает', () => {
    expect(agentAdapter('codex').isProcessArgv(['codex', '--yolo'])).toBe(true)
  })
})

// Баг 2026-08-17: пробная codex-сессия, поднятая руками в папке claude-топика, переписала
// биндингу агента. Доставка ушла на кодексовый путь (печатать в пейн) и встала: сообщения
// из Telegram в сессию больше не попадали.
describe('чему верить от живой сессии (mayLearn)', () => {
  test('своя сессия хаба уточняет и argv, и агента', () => {
    expect(mayLearn(true, 'codex', 'claude')).toEqual({ argv: true, agent: true })
    expect(mayLearn(true, 'claude', 'claude')).toEqual({ argv: true, agent: false })
  })

  test('чужой процесс того же харнесса — только argv', () => {
    expect(mayLearn(false, 'claude', 'claude')).toEqual({ argv: true, agent: false })
  })

  test('чужой процесс ДРУГОГО харнесса — ничего (тот самый зонд)', () => {
    expect(mayLearn(false, 'codex', 'claude')).toEqual({ argv: false, agent: false })
    expect(mayLearn(false, 'claude', 'codex')).toEqual({ argv: false, agent: false })
  })

  test('пустой agent в биндинге читается как claude', () => {
    expect(mayLearn(false, 'claude', undefined)).toEqual({ argv: true, agent: false })
    expect(mayLearn(false, 'codex', undefined)).toEqual({ argv: false, agent: false })
  })
})

// 2026-08-17: Codex спрашивал одобрение на вызов нашего же `reply`, и ответ агента уезжал
// в пикер вместо чата. За терминалом никого нет — одобрять некому.
describe('запуск Codex без запросов одобрения', () => {
  test('флаг добавляется к обычному старту', () => {
    expect(buildCodexLaunch(undefined, 'new'))
      .toBe('codex --ask-for-approval never --sandbox danger-full-access')
  })

  test('и к resume, перед подкомандой', () => {
    expect(buildCodexLaunch(['codex'], 'resume', 'abc'))
      .toBe('codex --ask-for-approval never --sandbox danger-full-access resume abc')
  })

  // Проверено на живой модалке Codex 0.147: она парсится пикер-мостом как обычный вопрос,
  // поэтому «одобрения в чат» — это только флаги запуска, отдельного кода не нужно.
  test('с TELEGRAM_CODEX_APPROVALS спрашиваем в чате и оставляем песочницу', () => {
    process.env.TELEGRAM_CODEX_APPROVALS = '1'
    try {
      expect(buildCodexLaunch(undefined, 'new')).toBe('codex --ask-for-approval on-request')
    } finally {
      delete process.env.TELEGRAM_CODEX_APPROVALS
    }
  })

  test('чужой выбор не перетираем', () => {
    expect(buildCodexLaunch(['codex', '--ask-for-approval', 'on-request'], 'new'))
      .toBe('codex --sandbox danger-full-access --ask-for-approval on-request')
    expect(buildCodexLaunch(['codex', '-s', 'read-only'], 'new'))
      .toBe('codex --ask-for-approval never -s read-only')
  })
})

// Регрессия 2026-08-17: после добавления флага перед подкомандой сохранённый argv стал
// `codex --ask-for-approval never resume <id>`, а strip искал подкоманду строго на позиции 1 —
// и к запуску прилипал второй `resume <id>`. Codex падал сразу после старта.
test('перезапуск не дублирует resume, если перед ним есть флаги', () => {
  const saved = ['codex', '--ask-for-approval', 'never', '--sandbox', 'danger-full-access', 'resume', '01a0-old']
  expect(buildCodexLaunch(saved, 'resume', '01a0-new'))
    .toBe('codex --ask-for-approval never --sandbox danger-full-access resume 01a0-new')
  expect(buildCodexLaunch(saved, 'new')).toBe('codex --ask-for-approval never --sandbox danger-full-access')
})
