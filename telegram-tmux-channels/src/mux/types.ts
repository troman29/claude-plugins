// Мультиплексор, в котором живут сессии агентов. Хаб видит только его: имя окна биндинга
// (по нему создаёт, ищет и гасит) и непрозрачный id пейна (по нему пишет и читает экран).

export type MuxKind = 'tmux' | 'herdr'

/** Клавиши — в словаре tmux (`Enter`, `Escape`, `C-c`, `Down`, цифры); строка, которая не
 *  является именем клавиши, печатается как есть — так `send-keys` ведёт себя и в tmux. */
export interface Mux {
  readonly kind: MuxKind
  /** Есть ли окно биндинга с этим именем. */
  has(name: string): Promise<boolean>
  /** Создать окно с шеллом в `dir`, если его нет; true — создано сейчас. */
  ensure(name: string, dir: string): Promise<boolean>
  /** Погасить окно вместе с процессами в нём; отсутствующее окно — не ошибка. */
  kill(name: string): Promise<void>
  /** Адрес окна, у агента которого ещё нет стаба (нет и id пейна): только для экрана и клавиш. */
  prestartTarget(name: string): string
  /** Это id живого пейна, а не prestartTarget. */
  isPaneId(target: string): boolean
  sendKeys(target: string, ...keys: string[]): Promise<void>
  /** Напечатать текст буквально, без Enter. */
  typeLiteral(target: string, text: string): Promise<void>
  /** Видимый экран: текст или с ANSI-цветами. */
  capture(target: string, opts?: { ansi?: boolean }): Promise<string>
  /** Имя переднего процесса пейна (`claude`, `zsh`); пустая строка — не узнали. */
  currentCommand(target: string): Promise<string>
  /** Id своего пейна из окружения процесса, запущенного в нём. */
  paneFromEnv(read: (key: string) => string | undefined): string | undefined
}
