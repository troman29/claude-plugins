// Кнопки управления под живым экраном /tui: нажать клавишу в пейне прямо из Telegram. Нужны,
// когда TUI встал на экране, который пикер-мост не превращает в кнопки, — модалка, меню,
// зависший ход. Набор намеренно узкий: навигация и выход, без ввода текста.

/** Кнопка → имя клавиши для `tmux send-keys`. Ctrl-C — одиночный: второй подряд у Claude Code
 *  означает выход из сессии, а не отмену хода. */
export const TUI_KEYS = {
  left: 'Left',
  up: 'Up',
  down: 'Down',
  right: 'Right',
  esc: 'Escape',
  ctrlc: 'C-c',
} as const

export type TuiKey = keyof typeof TUI_KEYS

export type TuiButton = { text: string; data: string }

const TUI_LABELS: Record<TuiKey, string> = {
  left: '←',
  up: '↑',
  down: '↓',
  right: '→',
  esc: 'Esc',
  ctrlc: 'Ctrl-C',
}

// `in` пропустил бы имена из прототипа («constructor»), а callback_data присылает клиент.
export function isTuiKey(value: string): value is TuiKey {
  return Object.hasOwn(TUI_KEYS, value)
}

export function tuiKeyLabel(key: TuiKey): string {
  return TUI_LABELS[key]
}

/** Раскладка: стрелки одним рядом, под ними Esc, Ctrl-C и закрытие просмотра. */
export function tuiButtons(token: string, closeLabel: string): TuiButton[][] {
  const key = (name: TuiKey): TuiButton => ({ text: TUI_LABELS[name], data: `tuikey:${token}:${name}` })
  return [
    [key('left'), key('up'), key('down'), key('right')],
    [key('esc'), key('ctrlc'), { text: closeLabel, data: `scrclose:${token}` }],
  ]
}
