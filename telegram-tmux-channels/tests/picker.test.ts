import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePicker, trustOptionIndex, textBeforePicker, checkedIndexes, pickerCursorIndex, parseResumeList, paneReady, isStartupTrustPrompt, isCodexStartupTrustScreen, isCodexHooksTrustScreen, isCodexOwnToolApproval } from '../src/picker'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

describe('parsePicker', () => {
  test('вариант со словом owner/other/custom внутри — обычный пункт, а не «впиши свой»', () => {
    // подстрочный /own/ съедал «общий — owner/admin» и подменял рекомендованный вариант
    // кнопкой «впиши свой ответ»: у живого вопроса 24.08 пункт 1 просто исчез из чата
    const p = parsePicker(fx('ask-with-preamble.txt'))!
    expect(p.customIndex).toBeUndefined()
    expect(p.options.find(o => o.index === 1)?.label).toContain('Рабочий — любой участник')
    // а настоящий пункт «впиши свой» по-прежнему находится
    expect(parsePicker(fx('ask-single.txt'))?.customIndex).toBe(3)
  })

  test('текст агента ПЕРЕД вопросом достаётся с пейна целиком', () => {
    // живой снимок сессии: пояснение «● Зафиксировал…» стоит над рамкой вопроса
    const intro = textBeforePicker(fx('ask-with-preamble.txt'))
    expect(intro.startsWith('Зафиксировал: три типа')).toBe(true)
    expect(intro.endsWith('распадается надвое — типы-то разные.')).toBe(true)
    expect(intro).not.toContain('│') // рамка и колонки в текст не попадают
    expect(intro).not.toContain('☐')
  })

  test('над рамкой нет реплики агента — интро пустое, а не мусор с экрана', () => {
    expect(textBeforePicker(fx('ask-single.txt'))).toBe('') // экран начинается сразу с рамки
  })

  test('реплика агента над рамкой берётся целиком, со своим списком внутри', () => {
    // тот же снимок, что охраняет «нумерованный список сверху не течёт в опции»: список —
    // часть текста агента, и в интро он приехать ДОЛЖЕН, а в опции — нет
    const intro = textBeforePicker(fx('scrollback-noise.txt'))
    expect(intro.startsWith('Here are the migration steps:')).toBe(true)
    expect(intro).toContain('1. First back up the DB')
    expect(parsePicker(fx('scrollback-noise.txt'))?.options.map(o => o.label))
      .toEqual(['Migrate', 'Roll back', 'Type something.'])
  })

  test('«Chat about this» есть в обеих раскладках: с номером и без', () => {
    // в раскладке с превью номер теряется — до этого пункт молча уходил в chrome
    const preview = parsePicker(fx('picker-preview.txt'))
    expect(preview?.options.at(-1)).toEqual({ index: 0, label: 'Chat about this' })
    // в обычной он приходит нумерованным — и дублировать его синтетическим нельзя
    const plain = parsePicker(fx('ask-single.txt'))
    expect(plain?.options.filter(o => o.label === 'Chat about this')).toEqual([{ index: 4, label: 'Chat about this' }])
  })

  test('стартовый гейт Codex с подвалом «Press enter to continue» — тоже пикер', () => {
    // Реальный экран из habebe-trader 21.08: codex поднялся, упёрся в предложение обновиться
    // и не подключил стаб; в чат ничего не ушло, топик молча копил придержанные сообщения.
    const picker = parsePicker(fx('codex-update-prompt.txt'))
    expect(picker?.mode).toBe('single')
    expect(picker?.options.map(o => o.label)).toEqual([
      "Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)",
      'Skip',
      'Skip until next version',
    ])
  })

  test('Codex 0.147 command approval: options and lowercase footer', () => {
    const pane = `  Would you like to run the following command?\n\n  $ touch /tmp/probe\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel`
    expect(parsePicker(pane)).toMatchObject({
      title: 'Would you like to run the following command? $ touch /tmp/probe',
      mode: 'single',
      options: [
        { index: 1, label: 'Yes, proceed (y)' },
        { index: 2, label: "Yes, and don't ask again (p)" },
        { index: 3, label: 'No, and tell Codex what to do differently (esc)' },
      ],
    })
  })
  test('only an explicit Claude startup-trust picker is auto-acknowledged', () => {
    const trust = parsePicker(fx('startup-prompt.txt'))
    const approval = parsePicker(`  Would you like to run the following command?\n\n› 1. Yes, proceed (y)\n  2. No, cancel (esc)\n\n  Press enter to confirm or esc to cancel`)
    expect(trust).toBeDefined()
    expect(isStartupTrustPrompt(trust!)).toBe(true)
    expect(approval).toBeDefined()
    expect(isStartupTrustPrompt(approval!)).toBe(false)
  })
  test('Codex pre-MCP trust screen is recognised without confusing a regular approval', () => {
    const trust = `> You are in /workspace\n\n  Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue`
    const approval = `Would you like to run this?\n\n› 1. Yes, continue\n  2. No, quit\n\nPress enter to continue`
    expect(isCodexStartupTrustScreen(trust)).toBe(true)
    expect(isCodexStartupTrustScreen(approval)).toBe(false)
  })
  test('Codex 0.147 /model picker: go-back footer and descriptions', () => {
    const pane = `  Select Model and Effort\n  Access legacy models through config.toml\n\n› 1. gpt-5.6-sol (current)  Latest frontier model.\n  2. gpt-5.6-terra          Balanced model.\n  3. gpt-5.6-luna           Fast model.\n\n  Press enter to confirm or esc to go back`
    expect(parsePicker(pane)).toMatchObject({
      title: 'Select Model and Effort Access legacy models through config.toml',
      options: [
        { index: 1, label: 'gpt-5.6-sol (current)' },
        { index: 2, label: 'gpt-5.6-terra' },
        { index: 3, label: 'gpt-5.6-luna' },
      ],
    })
  })
  test('single /model: options, mode, no custom', () => {
    const p = parsePicker(fx('model-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.options.map(o => o.index)).toEqual([1, 2, 3, 4, 5])
    expect(p.options[3].label).toBe('Sonnet')
    expect(p.customIndex).toBeUndefined()
  })
  test('single AskUserQuestion: label without description, custom=Type something', () => {
    const p = parsePicker(fx('ask-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.title).toContain('Tea or coffee?')
    expect(p.options).toEqual([
      { index: 1, label: 'Tea' },
      { index: 2, label: 'Coffee' },
      { index: 3, label: 'Type something.' },
      { index: 4, label: 'Chat about this' },
    ])
    expect(p.customIndex).toBe(3)
  })
  test('multi: checkboxes → mode multi, label without [ ]', () => {
    const p = parsePicker(fx('ask-multi.txt'))!
    expect(p.mode).toBe('multi')
    expect(p.options[0]).toEqual({ index: 1, label: 'Python' })
    expect(p.customIndex).toBe(4)
  })
  test('typed custom value keeps the custom slot and picker identity stable', () => {
    const before = parsePicker(fx('ask-multi.txt'))!
    const after = parsePicker(fx('ask-multi.txt').replace('Type something.', 'TTC_DIRECT_CUSTOM'))!
    expect(after.customIndex).toBe(4)
    expect(after.hash).toBe(before.hash)
  })
  test('pickerCursorIndex reads the visible cursor without mistaking an ordinary option for it', () => {
    expect(pickerCursorIndex(fx('ask-multi.txt'))).toBe(1)
    expect(pickerCursorIndex('  1. Alpha\n  2. Beta')).toBeUndefined()
  })
  test('plain text without a picker → undefined', () => {
    expect(parsePicker('just a prompt\n❯ \n')).toBeUndefined()
  })
  test('stale footer: leftover «Esc to cancel» with a prompt box under it → not a picker', () => {
    expect(parsePicker(fx('stale-footer.txt'))).toBeUndefined()
  })
  test('live picker + foreign trailing chrome (echoed telegram messages, task widget) under the footer → still a picker', () => {
    const p = parsePicker(fx('live-with-trailing-chrome.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Back to text', 'Keep voice as is', 'Type something.', 'Chat about this'])
  })
  test('раскладка с превью: две колонки, перенесённые подписи, подсказки под списком', () => {
    // Живой снимок из screenlog: AskUserQuestion с preview рисует список слева и рамку справа.
    // Раньше разбор упирался в «Chat about this» между списком и футером и молча сдавался —
    // в Telegram кнопки не уезжали, а сессия висела в ожидании ответа.
    const p = parsePicker(fx('picker-preview.txt'))!
    expect(p.mode).toBe('single')
    expect(p.title).toContain('Как называть ветку')
    expect(p.options).toEqual([
      { index: 1, label: 'Явное имя, иначе короткий slug' },
      { index: 2, label: 'Явное имя, иначе номер топика' },
      { index: 3, label: 'Спрашивать имя кнопкой в пикере' },
      { index: 0, label: 'Chat about this' }, // в этой раскладке он без номера — жмётся стрелками
    ])
    expect(p.title).not.toContain('│') // левая планка рамки в заголовок не попадает
  })
  test('scrollback: a numbered list ABOVE the picker does not leak into options/title', () => {
    const p = parsePicker(fx('scrollback-noise.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Migrate', 'Roll back', 'Type something.'])
    expect(p.title).toBe("What's the next step?")
    expect(p.title).not.toContain('back up')
  })
  test('dialog with no options (Rewind) → not a picker, agent output above is not harvested', () => {
    expect(parsePicker(fx('dialog-without-options.txt'))).toBeUndefined()
  })
  test('paneReady: startup prompt is not ready, a drawn input prompt is', () => {
    expect(paneReady(fx('startup-prompt.txt'))).toBe(false) // модалка на старте
    expect(paneReady(fx('ask-single.txt'))).toBe(false) // ❯ есть, но это вариант в модалке
    expect(paneReady('● Готово.\n\n❯ \n\n  ⏵⏵ bypass permissions on\n')).toBe(true)
  })
  test('hash is stable and distinguishes pickers', () => {
    expect(parsePicker(fx('ask-single.txt'))!.hash).toBe(parsePicker(fx('ask-single.txt'))!.hash)
    expect(parsePicker(fx('ask-single.txt'))!.hash).not.toBe(parsePicker(fx('ask-multi.txt'))!.hash)
  })
})

describe('checkedIndexes', () => {
  test('reads [✔] from multi', () => {
    expect(checkedIndexes(fx('ask-multi.txt'))).toEqual([2])
  })
  test('single without checkboxes → []', () => {
    expect(checkedIndexes(fx('ask-single.txt'))).toEqual([])
  })
})

describe('parseResumeList', () => {
  test('real /resume snapshot: rows, cursor, total', () => {
    const l = parseResumeList(fx('resume-list.txt'))!
    expect(l.total).toBe('1 of 27')
    expect(l.cursor).toBe(0)
    expect(l.rows.map(r => r.title)).toEqual([
      '(session)',
      'commit changes in homelab and the plugin',
      'Remind me of the last two days of work',
      'Set up Telegram binding for Claude server',
    ])
    expect(l.rows[1].meta).toBe('1 day ago · main · 6.9MB')
  })
  test('plain screen without a list → undefined', () => {
    expect(parseResumeList(fx('model-single.txt'))).toBeUndefined()
    expect(parseResumeList('')).toBeUndefined()
  })
})

// Второй стартовый гейт Codex (2026-08-17): установка плагина сменила источник хуков, сессия
// встала на «Hooks need review», хаб нажал Enter (= «Review hooks») и топик остался без сессии.
describe('экран доверия хукам Codex', () => {
  const screen = [
    '  Hooks need review',
    '  13 hooks are new or changed.',
    '  Hooks can run outside the sandbox after you trust them.',
    '',
    '› 1. Review hooks',
    '  2. Trust all and continue',
    "  3. Continue without trusting (hooks won't run)",
    '',
    '  Press enter to confirm or esc to go back',
  ].join('\n')

  test('узнаём настоящий экран', () => {
    expect(isCodexHooksTrustScreen(screen)).toBe(true)
  })

  test('экран доверия КАТАЛОГУ — не он (там свой обработчик и голый Enter)', () => {
    const dir = [
      '  Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
      '  Press enter to continue',
    ].join('\n')
    expect(isCodexHooksTrustScreen(dir)).toBe(false)
    expect(isCodexStartupTrustScreen(dir)).toBe(true)
  })

  test('проза про хуки сама по себе не гейт', () => {
    expect(isCodexHooksTrustScreen('обсуждаем hooks need review в переписке')).toBe(false)
    // есть заголовок, но нет пункта доверия — не жмём вслепую
    expect(isCodexHooksTrustScreen('Hooks need review\n› 1. Review hooks\nPress enter to confirm')).toBe(false)
  })
})

// 2026-08-17: Codex спрашивает разрешение на каждый вызов MCP-тула. Первым — наш `reply`,
// поэтому вместо ответа в чат прилетало «❓ Allow the telegram MCP server to run tool…».
describe('разрешение на свой MCP-тул', () => {
  const ask = [
    '  Allow the telegram MCP server to run tool "reply"?',
    '  chat_id: -1004355407865',
    '  text: пришло',
    '  › 1. Allow                   Run the tool and continue.',
    '    2. Allow for this session  Run the tool and remember this choice for this session.',
    '    3. Always allow            Run the tool and remember this choice for future tool calls.',
    '    4. Cancel                  Cancel this tool call',
    '  enter to submit | esc to cancel',
  ].join('\n')

  test('свой сервер узнаём', () => {
    expect(isCodexOwnToolApproval(ask)).toBe(true)
  })

  test('чужой MCP-сервер не трогаем — там вопрос по делу', () => {
    expect(isCodexOwnToolApproval(ask.replace('telegram MCP', 'payments MCP'))).toBe(false)
  })

  test('без пункта «Always allow» не жмём вслепую', () => {
    expect(isCodexOwnToolApproval(ask.split('\n').filter(l => !l.includes('3. Always allow')).join('\n'))).toBe(false)
  })
})

// Стартовый гейт доверия Claude Code рисует варианты БЕЗ номеров, только курсором. Нумерованный
// разбор его не видел вовсе: 05.09 топик ion-wallet не поднялся — ни кнопок в чате, ни авто-ответа,
// а пейн держал незапустившийся claude, и все сообщения Ромы уходили в очередь.
describe('безномерной стартовый гейт', () => {
  const picker = parsePicker(fx('claude-trust-unnumbered.txt'))

  test('разбирается в два варианта с курсором на первом', () => {
    expect(picker?.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(picker?.cursorIndex).toBe(1)
  })

  test('опознаётся как trust-промпт, а доверие — ВТОРОЙ пункт', () => {
    expect(isStartupTrustPrompt(picker!)).toBe(true)
    expect(trustOptionIndex(picker!)).toBe(2)
  })

  test('обычный текст под футером пикером не становится', () => {
    expect(parsePicker('Готово.\nВсё сделано.\n\n Enter to confirm · Esc to cancel')).toBeUndefined()
  })
})
