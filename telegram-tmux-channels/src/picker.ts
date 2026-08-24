// Parser for Claude Code's interactive TUI pickers captured from tmux capture-pane.
// Grounded on real /model and AskUserQuestion renders — see tests/fixtures.

const OPTION_RE = /^\s*[❯›]?\s*(\d+)\.\s+(.*)$/
/** Пункт без номера («Chat about this» в раскладке с превью): жмётся стрелками, не цифрой. */
export const CHAT_ABOUT_INDEX = 0
const CHECKBOX_RE = /^\[[ ✔xX]\]\s*/
const CUSTOM_RE = /type something|other|custom|own/i
export const FOOTER = 'Esc to cancel' // общий признак «в пейне открыт модальный диалог»
const FOOTER_RE = /esc to (?:cancel|go back)/i
// Стартовые гейты Codex (доверие каталогу, доверие хукам, «вышло обновление») — та же
// нумерованная модалка, но подвал у неё другой. Разбор принимает оба подвала: иначе такой
// экран не превращается в кнопки и висит в пейне, пока кто-нибудь не сядет за терминал.
const ENTER_FOOTER_RE = /^\s*press enter to (?:continue|confirm)\s*$/i
// Только Esc-вариант: строка Codex остаётся на экране и ПОСЛЕ ответа, и пейн по ней числился
// бы занятым навсегда (paneReady) — а модалку без вариантов мы и так узнаём по ней же.
export const hasPickerFooter = (text: string): boolean => FOOTER_RE.test(text)
const isPickerFooterLine = (line: string): boolean => FOOTER_RE.test(line) || ENTER_FOOTER_RE.test(line)

export type PickerOption = { index: number; label: string }
export type Picker = {
  title: string
  options: PickerOption[]
  mode: 'single' | 'multi'
  customIndex?: number
  hash: string
}

// Both CLIs require an explicit trust acknowledgement before their local MCP server can start.
// This is only auto-acknowledged after an admin deliberately bound that directory; never
// generalise it to arbitrary yes/no prompts such as command approvals.
export function isStartupTrustPrompt(picker: Picker): boolean {
  if (picker.options.some(o => /I trust this folder|I am using this for local development/i.test(o.label))) {
    return true // Claude Code
  }
  return /do you trust the contents of this directory/i.test(picker.title)
    && picker.options.some(o => /^Yes, continue$/i.test(o.label)) // Codex 0.147+
}

// Unlike its later approval dialogs, Codex's initial directory-trust screen is not a modal
// picker: it ends with "Press enter to continue", not an Esc footer. Keep its signature narrow
// so arbitrary text asking a yes/no question can never be acknowledged automatically.
export function isCodexStartupTrustScreen(text: string): boolean {
  return /do you trust the contents of this directory\?/i.test(text)
    && /^[›>]\s*1\.\s+Yes, continue\s*$/mi.test(text)
    && /^\s*2\.\s+No, quit\s*$/mi.test(text)
    && /press enter to continue/i.test(text)
}

// Второй стартовый гейт Codex: доверие ХУКАМ. Появляется каждый раз, когда набор хуков сменил
// источник или содержимое — то есть после установки плагина и после любой правки его hooks.json.
// Здесь курсор стоит на «1. Review hooks», и голый Enter открывает разбор, а не подтверждает:
// 2026-08-17 сессия Codex так и умерла на этом экране, пользователь увидел «No live session».
// Нам нужен именно пункт «Trust all and continue» — без доверия хуки не выполняются, а без
// хука Stop хаб не узнаёт о конце хода и ответы агента не уходят в Telegram.
export function isCodexHooksTrustScreen(text: string): boolean {
  return /hooks?\s+(need|needs)\s+review/i.test(text)
    && /^\s*[›>]?\s*2\.\s+Trust all and continue\s*$/mi.test(text)
    && /press enter to confirm/i.test(text)
}

// Codex спрашивает разрешение на КАЖДЫЙ вызов MCP-тула отдельно (это не тот гейт, что
// `--ask-for-approval`, тот про команды). Первым под раздачу попадает наш собственный `reply`:
// пользователь вместо ответа получает «❓ Allow the telegram MCP server to run tool…», а ответ
// висит в терминале. Для СВОЕГО сервера отвечаем «Always allow» — он наш, и без него канал
// не работает вовсе. Чужие серверы не трогаем: там вопрос по делу.
export function isCodexOwnToolApproval(text: string, server = 'telegram'): boolean {
  const re = new RegExp(`Allow the ${server} MCP server to run tool`, 'i')
  return re.test(text)
    && /^\s*[›>]?\s*3\.\s+Always allow\b/mi.test(text)
    && /enter to submit/i.test(text)
}

const MAX_TITLE_LINES = 3
// A live picker owns the input area; a leftover footer higher up has the real chat
// input box (a bare ❯ prompt, no option text) below it — that's the staleness tell.
// Anything else below (delivered-message echoes, a background task widget) is just
// chrome and doesn't mean the picker resolved.
const BARE_PROMPT_RE = /^[❯›]\s*$/

function hasLiveInputBelow(lines: string[], footerIdx: number): boolean {
  for (let i = footerIdx + 1; i < lines.length; i++) {
    if (BARE_PROMPT_RE.test(lines[i].trim())) {
      return true
    }
  }
  return false
}

function optionLabel(rest: string): string {
  const noCheckbox = rest.replace(CHECKBOX_RE, '')
  const beforeDesc = noCheckbox.split(/\s{2,}/)[0] // inline description sits after 2+ spaces
  return beforeDesc.replace(/\s*✔\s*$/, '').trim()
}

function isSeparator(t: string): boolean {
  return /^[─▔━]+$/.test(t)
}

// Опции с превью рисуются в ДВЕ колонки: слева список, справа рамка с примером. Всё, что
// правее рамки, к выбору отношения не имеет — режем, иначе label уносит с собой чужой текст.
const PREVIEW_COLUMN_RE = /\s{2,}[┌│└├].*$/
// Левая планка заголовка диалога — часть рамки, а не текста.
const TITLE_GUTTER_RE = /^\s*│\s?/
const BOX_ONLY_RE = /^[┌┐└┘├┤─│\s]+$/
// Подсказки TUI между списком и футером. Именно перечислением: любой НЕизвестный текст в этом
// месте по-прежнему означает «это не пикер», иначе кнопками уедет вывод агента.
const HINT_RE = /^(?:Notes: press n to add notes|Chat about this|Press \S+ .*)$/
// «Chat about this» — настоящий пункт списка, а не подсказка. В обычной раскладке он приходит
// с номером (`4. Chat about this`), а в раскладке с превью номер теряется и остаётся голая
// строка под чертой — и до 24.08 она молча уезжала в chrome, из-за чего кнопки в чате не было.
const CHAT_ABOUT_RE = /^Chat about this$/

// UI chrome inside a picker box (not a separator — those are handled by the scan):
// blanks, the ●-sub-control, and the header chip (`☐ Word` / multi `← ☐ … Submit →`).
function isChrome(t: string): boolean {
  if (!t) {
    return true
  }
  if (/^●/.test(t)) {
    return true
  }
  if (/^[☐☒]/.test(t)) {
    return true
  }
  if (t.startsWith('←') && (t.includes('Submit') || t.includes('→'))) {
    return true
  }
  return BOX_ONLY_RE.test(t) || HINT_RE.test(t)
}

// Пейн реально готов принять ввод: отрисована строка-приглашение и не висит модалка.
// «Промпт ушёл» — недостаточный признак: поле ввода появляется на ~секунду позже, и
// сообщение, отправленное в эту щель, CLI теряет молча.
export function paneReady(text: string): boolean {
  return !hasPickerFooter(text) && /^\s*❯/m.test(text)
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Готовит строки пейна к разбору: срезает колонку предпросмотра и приклеивает перенос длинной
 * опции к её строке. Номера строк сохраняются (вместо склеенной кладём пустую) — по ним
 * дальше ищется футер.
 *
 * Склейка — ТОЛЬКО в раскладке с превью. Там список ужат в узкую левую колонку и длинная
 * подпись переносится, а описаний под опциями нет вовсе. В обычной раскладке строка с
 * отступом под опцией — это её ОПИСАНИЕ, и приклеивать его к подписи нельзя.
 * Пустая строка разрывает серию: иначе к последней опции приклеились бы подсказки под списком.
 */
export function joinWrappedOptions(lines: string[]): string[] {
  const withPreview = lines.some(line => PREVIEW_COLUMN_RE.test(line))
  const out: string[] = []
  let optionIdx = -1
  let optionIndent = 0
  for (const raw of lines) {
    const line = raw.replace(PREVIEW_COLUMN_RE, '')
    const m = OPTION_RE.exec(line)
    if (m) {
      out.push(line)
      optionIdx = out.length - 1
      optionIndent = line.search(/\S/)
      continue
    }
    if (!line.trim()) {
      out.push(line)
      optionIdx = -1
      continue
    }
    if (withPreview && optionIdx >= 0 && line.search(/\S/) > optionIndent) {
      out[optionIdx] += ' ' + line.trim()
      out.push('')
      continue
    }
    out.push(line)
    optionIdx = -1
  }
  return out
}

// Parse only the picker box: scan UPWARD from the footer, collecting the option
// block and (up to MAX_TITLE_LINES of) the title above it. Content further up the
// screen (scrollback, prior agent output with its own numbered lists) is ignored.
export function parsePicker(text: string): Picker | undefined {
  const lines = text.split('\n')
  let lastIdx = lines.length - 1
  while (lastIdx >= 0 && !lines[lastIdx].trim()) {
    lastIdx--
  }
  let footerIdx = -1
  for (let i = lastIdx; i >= 0; i--) {
    if (isPickerFooterLine(lines[i])) {
      footerIdx = i
      break
    }
  }
  if (footerIdx < 0 || hasLiveInputBelow(lines, footerIdx)) {
    return undefined
  }
  const options: PickerOption[] = []
  let titleParts: string[] = []
  let titleStarted = false
  let multi = false
  let chatAbout = false
  const prepared = joinWrappedOptions(lines)
  for (let i = footerIdx - 1; i >= 0; i--) {
    const line = prepared[i]
    const t = line.trim()
    const m = OPTION_RE.exec(line)
    if (m) {
      if (CHECKBOX_RE.test(m[2])) {
        multi = true
      }
      options.unshift({ index: Number(m[1]), label: optionLabel(m[2]) })
      titleParts = [] // an option above resets the title — descriptions between options aren't it
      titleStarted = false
      continue
    }
    if (isSeparator(t)) {
      if (titleStarted) {
        break // separator above the title = top of the picker box; stop before scrollback
      }
      continue // separator between options is internal
    }
    if (CHAT_ABOUT_RE.test(t)) {
      chatAbout = true
      continue
    }
    if (isChrome(t)) {
      continue
    }
    if (options.length === 0) {
      // Текст между футером и первой опцией = это не список выбора, а диалог без вариантов
      // (напр. Rewind: «Nothing to rewind to yet.»). Идти выше нельзя: там вывод агента, и
      // первый же его нумерованный список уедет в чат кнопками, которые ещё и жмут TUI.
      return undefined
    }
    titleStarted = true
    titleParts.unshift(t.replace(TITLE_GUTTER_RE, ''))
    if (titleParts.length >= MAX_TITLE_LINES) {
      break
    }
  }
  if (options.length < 2) {
    return undefined
  }
  // Добавляем ТОЛЬКО к состоявшемуся списку: голая строка сама по себе пикера не делает.
  // Номер 0 — свободный (нумерация с 1), по нему обработчик знает, что жать надо стрелками.
  if (chatAbout && !options.some(option => CHAT_ABOUT_RE.test(option.label))) {
    options.push({ index: CHAT_ABOUT_INDEX, label: 'Chat about this' })
  }
  // Once text is entered inline, Claude replaces "Type something" with the
  // value itself. The following Submit control is its stable structural marker.
  const inlineCustom = lines.findIndex((line, i) =>
    OPTION_RE.test(line) && lines.slice(i + 1).find(l => l.trim())?.trim() === 'Submit',
  )
  const custom = options.find(o => CUSTOM_RE.test(o.label))
  const customIndex = custom?.index ?? (inlineCustom >= 0 ? Number(OPTION_RE.exec(lines[inlineCustom]!)![1]) : undefined)
  const title = titleParts.join(' ').trim()
  return {
    title,
    options,
    mode: multi ? 'multi' : 'single',
    ...(customIndex != null ? { customIndex } : {}),
    // A typed custom value is state, not a new dialog. Keeping its slot stable
    // prevents a duplicate Telegram bubble after every character.
    hash: fnv1a(title + '|' + options.map(o => `${o.index}:${o.index === customIndex ? '__custom__' : o.label}`).join('|')),
  }
}

// ── native /resume session list ─────────────────────────────────────────
// Full-screen searchable TUI (not a numbered picker): rows are a title line
// (❯ marks the cursor, ↓/↑ mark scroll-more) followed by a metadata line
// "N <unit> ago · branch · size". Driven by arrow keys, not digits.

export type ResumeRow = { title: string; meta: string }
// pos/count — absolute cursor position from the "(N of M)" header; cursor — the ❯ index among visible rows
export type ResumeList = { total: string; pos: number; count: number; cursor: number; rows: ResumeRow[] }

// the "(N of M)" counter disappears when the whole list fits the viewport — then pos/count come from the visible rows
const RESUME_HEADER_RE = /Resume session(?: \((\d+) of (\d+)\))?\s*$/
const RESUME_META_RE = /ago · .+ · \S+B\s*$/

export function parseResumeList(text: string): ResumeList | undefined {
  const lines = text.split('\n')
  // the TUI is drawn at the bottom of the screen — search from the end, so we don't catch similar text in the transcript
  let h = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESUME_HEADER_RE.test(lines[i])) {
      h = i
      break
    }
  }
  if (h < 0) {
    return undefined
  }
  const hm = RESUME_HEADER_RE.exec(lines[h])!
  const rows: ResumeRow[] = []
  let cursor = -1
  for (let i = h + 1; i < lines.length; i++) {
    if (lines[i].includes('Esc to cancel')) {
      break
    }
    if (!RESUME_META_RE.test(lines[i])) {
      continue
    }
    const t = lines[i - 1] ?? ''
    const title = t.replace(/^\s*[❯↓↑]\s*/, '').trim()
    if (!title) {
      continue
    }
    if (/^\s*❯/.test(t)) {
      cursor = rows.length
    }
    rows.push({ title, meta: lines[i].trim() })
  }
  if (rows.length === 0 || cursor < 0) {
    return undefined
  }
  const pos = hm[1] ? Number(hm[1]) : cursor + 1
  const count = hm[2] ? Number(hm[2]) : rows.length
  return { total: hm[1] ? `${hm[1]} of ${hm[2]}` : String(rows.length), pos, count, cursor, rows }
}

export function checkedIndexes(text: string): number[] {
  const out: number[] = []
  for (const line of text.split('\n')) {
    const m = OPTION_RE.exec(line)
    if (m && /^\[[✔xX]\]/.test(m[2])) {
      out.push(Number(m[1]))
    }
  }
  return out
}

/** Currently highlighted numbered option in a live picker, if its cursor is visible. */
export function pickerCursorIndex(text: string): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^\s*[❯›]\s*(\d+)\.\s+/.exec(line)
    if (m) return Number(m[1])
  }
  return undefined
}
