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
  enter: 'Enter',
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
  enter: 'Enter',
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

// Пустая клетка сетки. Telegram не принимает кнопку без текста, а пробел обрезает, поэтому
// «пустой символ Брайля»: не пробел для Telegram, но на экране его не видно.
const BLANK_CELL = '\u2800'
export const TUI_NOOP_DATA = 'tuinoop'

/** Сетка 3×3, стрелки на своих сторонах, как на крестовине, Enter в центре: Esc и Ctrl-C в
 *  верхних углах, закрытие в нижнем правом. Пустая клетка нажимается, но ничего не делает. */
export function tuiButtons(token: string, closeLabel: string): TuiButton[][] {
  const key = (name: TuiKey): TuiButton => ({ text: TUI_LABELS[name], data: `tuikey:${token}:${name}` })
  const blank: TuiButton = { text: BLANK_CELL, data: TUI_NOOP_DATA }
  return [
    [key('esc'), key('up'), key('ctrlc')],
    [key('left'), key('enter'), key('right')],
    [blank, key('down'), { text: closeLabel, data: `scrclose:${token}` }],
  ]
}
