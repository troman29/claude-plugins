#!/usr/bin/env bun
// Hub: the single bot poller. Routing: chat/topic key → bindings.json → project dir
// → live sessions with that cwd. Bindings are created by /bind,/unbind,/allow from
// Telegram (admins from TELEGRAM_ADMINS).
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import type { ReactionTypeEmoji } from 'grammy/types'
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, statSync, realpathSync, chmodSync, readdirSync,
} from 'fs'
import { join, sep, basename } from 'path'
import { homedir } from 'os'
import type { Socket } from 'bun'

import { STATE_DIR, ENV_FILE, INBOX_DIR, PID_FILE, SOCK_PATH } from './paths'
import { messageKey, keyToTarget, targetFor, type Target } from './bindings'
import {
  loadBindings, saveBindings, keysForDir, sessionOwner, setSessionId, resolveProjectDir, parseBindSpec, type BindingEntry,
} from './registry'
import { encode, makeLineDecoder, type StubToHub, type HubToStub, type SessionInfo } from './protocol'
import { Router } from './router'
import { chunk, MAX_CHUNK_LIMIT, MAX_RICH_LIMIT, MAX_ATTACHMENT_BYTES, planAttachments } from './chunk'
import { escapeForRich, mdToHtml, needsRich } from './md-html'
import {
  parseOpsCommand, paneDigest, sendKeys, typeLine, typeText, typeSlashCommand, selectOption, restartSession, stopSession, alive,
  hasTmuxSession, ensureTmuxSession, killTmuxSession, shellQuote, isIdleToUnload, tmuxSessionName,
  paneCurrentCommand,
  type LaunchMode,
  memoryCapPrefix,
  capturePane, capturePaneAnsi, type OpsCommand,
} from './tmux-ops'
import { ansiToImage } from './ansi-image'
import { emptyStatus, hasLiveWork, renderBg, renderStatus, statusIsEmpty, syncBg, type BgTask, type StatusState } from './status-render'
import { discoverGlobalSkills, discoverProjectSkills, mangleCmd, resolveSkillCommand, skillInvocation, tgDescription, type Skill } from './skills'
import { agentPidsInDir, cmdlineOf } from './proc'
import { rmQuiet } from './util'
import { parsePicker, checkedIndexes, pickerCursorIndex, parseResumeList, fnv1a, hasPickerFooter, isStartupTrustPrompt, isCodexStartupTrustScreen, isCodexHooksTrustScreen, isCodexOwnToolApproval, type Picker, type ResumeRow } from './picker'
import { buildKeyboard, parseCallback } from './picker-drive'
import {
  loadTrustedGroups, isExcludedTopic, slugFromTopicName, modeLabel,
  type TrustedGroupConfig, type TrustedGroupMode,
} from './trusted-groups'
import { t, getLang, setLang, type Lang } from './i18n'
import { resolveModeDir, gitBranch, runHookDelete, removePlainWorktree, runStandCommand, worktreeHook, isLinkedWorktree } from './dir-resolve'
import { PROJECT_CONFIG_FILE, parseStandLinks, standLogTail, worktreeBases } from './project-config'
import { watchDelivery as watchDeliveryCore, type DeliveryDeps } from './delivery'
import { FallbackGate } from './fallback-gate'
import { topic as inTopic } from './chat'
import { HubStateRepository, type PersistedPicker, type PersistedInbound, type PersistedLaunchCapture } from './state-repo'
import { recordChat, recordTopic, topicTitle, chatLabel } from './known-chats'
import { agentAdapter, mayLearn, type AgentAdapter, type AgentKind, type AgentStatusPanel } from './agents'

const log = (s: string) => process.stderr.write(`telegram hub: ${s}\n`)

function adapterForBinding(binding: BindingEntry | undefined): AgentAdapter {
  return agentAdapter(binding?.agent)
}

function adapterForKey(key: string): AgentAdapter {
  return adapterForBinding(loadBindings()[key])
}

function adapterForSession(session: SessionInfo): AgentAdapter {
  if (session.agent) return agentAdapter(session.agent)
  const key = session.bindingKeys?.[0]
  return key ? adapterForKey(key) : agentAdapter('claude')
}

async function captureNewAdapterSessionId(
  adapter: AgentAdapter,
  dir: string,
  before: Map<string, number>,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Recursive rollout scans are filesystem-order dependent. Select the newest fresh session;
    // otherwise a previous rollout can win and `/restart` resumes the wrong Codex conversation.
    const fresh = [...adapter.sessionMtimes(dir).entries()]
      .filter(([id]) => !before.has(id))
      .sort(([, a], [, b]) => b - a)
    if (fresh[0]) return fresh[0][0]
    await new Promise(r => setTimeout(r, 2000))
  }
  return undefined
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Shorten a $HOME-relative path to ~/… for display.
const HOME = homedir()
function tildePath(p: string): string {
  return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p
}

// HTML <code> with a home-shortened, escaped path.
function codePath(p: string): string {
  return `<code>${escHtml(tildePath(p))}</code>`
}

// `/status` is a modal in Codex, not a stable machine API.  Open it only on an explicitly
// requested Telegram /status and only if the adapter proves that the composer is untouched;
// otherwise a local tmux draft could be submitted.  The panel is always closed before return.
async function readLiveStatusPanel(adapter: AgentAdapter, pane: string): Promise<AgentStatusPanel | undefined> {
  if (!adapter.statusPanelCommand) return undefined
  const [before, ansiBefore] = await Promise.all([
    capturePane(pane).catch(() => ''),
    capturePaneAnsi(pane).catch(() => ''),
  ])
  if (!adapter.canOpenStatusPanel(before, ansiBefore)) return undefined
  let opened = false
  try {
    await typeLine(pane, adapter.statusPanelCommand)
    for (let i = 0; i < 12; i++) {
      const text = await capturePane(pane).catch(() => '')
      const panel = adapter.parseStatusPanel(text)
      if (panel) {
        opened = true
        return panel
      }
      // Codex's slash palette can consume the first Enter as selection.  Submit the command
      // once more only when we can see the exact command we inserted, never arbitrary text.
      if (i === 1 && text.split('\n').some(line => line.trim() === `› ${adapter.statusPanelCommand}`)) {
        await sendKeys(pane, 'Enter')
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    return undefined
  } finally {
    if (opened) await sendKeys(pane, 'Escape').catch(() => {})
    else {
      const text = await capturePane(pane).catch(() => '')
      if (text.split('\n').some(line => line.trim() === `› ${adapter.statusPanelCommand}`)) {
        await sendKeys(pane, 'Escape').catch(() => {})
      }
    }
  }
}

function formatLiveStatusPanel(panel: AgentStatusPanel): string[] {
  const L = t()
  const lines: string[] = []
  if (panel.contextUsedPct != null) lines.push(L.statusContextUsed(panel.contextUsedPct))
  lines.push(...panel.limits.map(limit => L.statusQuota(escHtml(limit.label), limit.remainingPct, escHtml(limit.resets ?? ''))))
  if (panel.stale) lines.push(L.statusQuotaStale)
  return lines
}

// "typing…" hint — shown whenever the agent is handed input to work on.
// Telegram's typing action already lives ~5s, so refreshing faster is pure waste —
// and with several topics of one supergroup all nudging every poll tick it burst-hit
// the per-CHAT sendChatAction limit (429 retry-after), dropping the indicator at random.
// per-(chat,thread) throttle. Effective interval ≈ throttle rounded UP to the poll granularity
// (1.5s): a 4s throttle actually re-sent every ~4.5s — only 0.5s under Telegram's ~5s typing
// lifetime, so any jitter let the indicator lapse (measured). 3s → ~3s interval, comfortable
// margin, while still far below the every-1.5s rate that first triggered 429 (and auto-retry
// now backs up the rare 429 anyway).
const lastTyping = new Map<string, number>()
function typing(chatId: string, threadId?: number): void {
  const k = `${chatId}:${threadId ?? ''}`
  const now = Date.now()
  if (now - (lastTyping.get(k) ?? 0) < 3000) {
    return
  }
  lastTyping.set(k, now)
  void bot.api
    .sendChatAction(chatId, 'typing', inTopic(threadId))
    .catch(err => {
      // frequent send → a good place to notice the topic was deleted out from under us
      if (threadId != null && isThreadGoneError(err)) {
        void onTopicGone(`${chatId}/${threadId}`)
      } else {
        log(`typing failed: chat=${chatId} ${err}`)
      }
    })
}

// token and admins from state .env; the real env wins
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]
    }
  }
} catch {} // no .env file — token may come from the real env
// Проверка токена — в start(), а не здесь: иначе импорт модуля из теста просто убивал бы
// процесс. Всё, что лезет наружу (сокет, поллинг, таймеры, pid-файл), тоже живёт в start().
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ADMINS = (process.env.TELEGRAM_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const isAdmin = (id: string) => ADMINS.includes(id)
// Optional: incoming voice messages get auto-transcribed if set. Unset = leave voice
// messages as the raw attachment + "(voice message)" placeholder, same as before.
// Model/base URL are configurable (not hardcoded) so swapping provider or model later
// is an env change, not a code change — same names hermes already uses for the same
// purpose (STT_OPENAI_MODEL/STT_OPENAI_BASE_URL), and gpt-4o-transcribe beats whisper-1
// for Russian: punctuation, capitalization.
const STT_KEY = process.env.OPENAI_API_KEY
const STT_MODEL = process.env.STT_OPENAI_MODEL || 'gpt-4o-transcribe'
const STT_BASE_URL = process.env.STT_OPENAI_BASE_URL || 'https://api.openai.com/v1'

// Outgoing voice: reply(..., voice: true) speaks the text instead of just sending it as a
// message. Same key as STT; model/voice/base URL match what hermes already settled on.
const TTS_KEY = process.env.OPENAI_API_KEY
const TTS_MODEL = process.env.TTS_OPENAI_MODEL || 'gpt-4o-mini-tts'
const TTS_VOICE = process.env.TTS_OPENAI_VOICE || 'onyx'
const TTS_BASE_URL = process.env.TTS_OPENAI_BASE_URL || 'https://api.openai.com/v1'

// base for /bind <name>; absolute paths and ~/… still work
const PROJECTS_DIR = process.env.TELEGRAM_PROJECTS_DIR || join(homedir(), 'projects')

// Append a "⚠️ Context NN%" line to agent replies once context usage reaches this %.
// 0 (or invalid) disables it. Configurable via TELEGRAM_CONTEXT_WARN_PCT (default 80).
const CONTEXT_WARN_PCT = (() => {
  const n = Number(process.env.TELEGRAM_CONTEXT_WARN_PCT ?? '80')
  return Number.isFinite(n) ? n : 80
})()

// Debug log (screenlog.jsonl) writes ALL Telegram traffic to disk — a dev aid, off by default
// so the public plugin doesn't log everyone's messages. Enable with TELEGRAM_DEBUG_LOG=1.
const DEBUG_LOG = /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_DEBUG_LOG ?? '')

// Idle-unload: after N minutes of no activity a session is gracefully stopped (RAM back;
// a claude session + its MCP children is ~0.5 GB), and the next message auto-resumes it via
// the existing revive path. One knob — TELEGRAM_IDLE_UNLOAD_MINUTES; 0/unset = disabled.
// /pin exempts a topic. Off by default so the public plugin never touches anyone's sessions.
const IDLE_UNLOAD_MS = (() => {
  const n = Number(process.env.TELEGRAM_IDLE_UNLOAD_MINUTES ?? '0')
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 0
})()
// key → last time this binding showed activity (inbound msg or any pane movement). The idle
// timer measures from here; a live session with no entry is treated as "just active" (now).
const lastActivity = new Map<string, number>()
const unloading = new Set<string>() // guards against re-triggering while a stop is in flight
const idleUnloaded = new Set<string>() // was suspended by idle-unload → wake gets one quiet msg
function markActivity(keys: string[] | undefined): void {
  const now = Date.now()
  for (const k of keys ?? []) {
    lastActivity.set(k, now)
    idleUnloaded.delete(k)
  }
}

// The suspended state also lives in bindings.json: a reboot kills tmux, and boot-revive would
// otherwise start every sleeping session at once — a memory spike for topics nobody asked for.
function persistUnloaded(keys: string[], unloaded: boolean): void {
  const reg = loadBindings()
  let changed = false
  for (const k of keys) {
    const b = reg[k]
    if (b && Boolean(b.unloaded) !== unloaded) {
      if (unloaded) {
        b.unloaded = true
      } else {
        delete b.unloaded
      }
      changed = true
    }
  }
  if (changed) {
    saveBindings(reg)
  }
}

// kill a zombie poller (incl. the old plugin) — one getUpdates per token
function claimPollerSlot(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  try {
    const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (stale > 1 && stale !== process.pid) {
      // A persistent Docker home can retain a PID from a previous container.  Treat a
      // non-existent process as stale, but never let ESRCH prevent us from claiming the
      // slot (otherwise the hub cannot come back after a container recreate).
      try {
        process.kill(stale, 0)
        log(`replacing stale poller pid=${stale}`)
        process.kill(stale, 'SIGTERM')
      } catch (e: unknown) {
        if (!(e instanceof Error) || (e as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw e
        }
        log(`discarding dead poller pid=${stale}`)
      }
    }
  } catch {} // no pid file, or the process is already gone
  writeFileSync(PID_FILE, String(process.pid))
}

const SPAWN_LOCK = join(STATE_DIR, 'hub.spawnlock')
const MAX_409_ATTEMPTS = 8
const MAX_BACKOFF_MS = 15_000
const SCREEN_POLL_MS = 1500
const CUSTOM_TIMEOUT_MS = 120_000

// Заглушка вместо токена — чтобы модуль импортировался в тесте. Сам объект в сеть не ходит:
// наружу выходит только bot.start(), а он в start().
const bot = new Bot(TOKEN || 'import-only:no-token')
let botUsername = ''

// Raw Telegram traffic → debug log (see logDebugEvent below; hoisted).
// getUpdates would log the long-poll loop itself, sendChatAction is typing spam.
const TG_OUT_SKIP = new Set(['getUpdates', 'sendChatAction'])
bot.api.config.use((prev, method, payload, signal) => {
  if (!TG_OUT_SKIP.has(method)) {
    logDebugEvent({ type: 'tg_out', method, payload })
  }
  return prev(method, payload, signal)
})
// Resilience: retry on 429 honouring retry_after (never silently drop a message), and throttle
// outbound to stay under Telegram's limits (~30/s global, ~20/min per group). sendChatAction
// (the "typing…" nudge) bypasses the throttler — it's ephemeral, must fire promptly, and a
// rare 429 on it is caught by auto-retry anyway; queueing it would let the indicator lapse.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 20 }))
const throttler = apiThrottler()
bot.api.config.use((prev, method, payload, signal) =>
  method === 'sendChatAction' ? prev(method, payload, signal) : throttler(prev, method, payload, signal),
)
bot.use(async (ctx, next) => {
  logDebugEvent({ type: 'tg_in', update: ctx.update })
  await next()
})

const router = new Router<Socket<undefined>>()
const feeders = new Map<Socket<undefined>, (chunk: string) => void>()

function send(sock: Socket<undefined>, msg: HubToStub): void {
  try {
    sock.write(encode(msg))
  } catch (e) {
    log(`socket write failed: ${e}`)
  }
}

// a session's outbound is limited to the chats of its own keys
function ownKeys(conn: Socket<undefined>): string[] {
  const s = router.get(conn)
  if (s?.bindingKeys?.length) {
    return s.bindingKeys
  }
  if (!s?.cwd) {
    return []
  }
  // a legacy (no-bindingKeys) session falls back to "keys pointing at my dir", but
  // never one another live session already explicitly claims (mode: folder dir-share)
  const claimed = new Set<string>()
  for (const c of router.all()) {
    if (c !== conn) {
      for (const k of router.get(c)?.bindingKeys ?? []) {
        claimed.add(k)
      }
    }
  }
  return keysForDir(loadBindings(), s.cwd).filter(k => !claimed.has(k))
}

async function handleRpc(
  conn: Socket<undefined>,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  switch (method) {
    case 'reply': {
      const r = await doReply(conn, params)
      clearPendingAnswer(conn) // agent answered — turnend won't auto-forward
      return r
    }
    case 'react': {
      const r = await doReact(conn, params)
      clearPendingAnswer(conn)
      return r
    }
    case 'edit_message': {
      const r = await doEdit(conn, params)
      clearPendingAnswer(conn)
      return r
    }
    case 'download_attachment':
      return doDownload(params)
    case 'permission_request':
      // Permissions are surfaced in-topic by the picker bridge (it scrapes the TUI
      // "Do you want to proceed?" dialog). The old channel path DM'd admins a separate
      // 🔐 prompt that silently failed without an open DM — dropped. No-op: rely on the picker.
      return 'ignored'
    default:
      throw new Error(`unknown rpc method: ${method}`)
  }
}

function assertBoundChat(conn: Socket<undefined>, chat_id: string): void {
  if (!ownKeys(conn).some(k => keyToTarget(k).chat_id === chat_id)) {
    throw new Error(`chat ${chat_id} is not bound to this session's project`)
  }
}

// reply targets a specific topic — a session may only send into its OWN (chat,thread),
// not just any topic of a chat it happens to be bound to somewhere else. targetFor
// returns an explicit thread_id verbatim, so without this a session bound to -100/10
// could pass thread_id:20 and post into a sibling topic.
// ponytail: react/edit still assert only the chat — bounding an arbitrary message_id to
// the session's own topic needs a per-binding sent/received msg-id registry; deferred,
// the actor there is an already-shell-compromised session (weaker boundary).
function assertBoundTarget(conn: Socket<undefined>, target: Target): void {
  const ok = ownKeys(conn).some(k => {
    const t = keyToTarget(k)
    return t.chat_id === target.chat_id && t.thread_id === target.thread_id
  })
  if (!ok) {
    const where = target.thread_id != null ? `${target.chat_id}/${target.thread_id}` : target.chat_id
    throw new Error(`${where} is not bound to this session's project`)
  }
}

// Two ways out. A Rich Message (Bot API 10.1) has Telegram parse real GitHub-flavoured Markdown —
// tables, collapsible blocks, footnotes, formulas — but it carries no plain `text` field, so a
// client too old to know the type renders nothing at all. So it is used only where it earns that
// risk (needsRich); everything else keeps going out as the HTML the converter has always built.
let richSupported = true // sticky: one "unknown method" is enough to stop trying

async function sendMarkdown(
  chat_id: string,
  text: string,
  base: Record<string, unknown>,
  rich = needsRich(text),
): Promise<number[]> {
  if (rich && richSupported) {
    try {
      const sent = await bot.api.sendRichMessage(chat_id, { markdown: escapeForRich(text) }, base)
      return [sent.message_id]
    } catch (err) {
      // 404 = the method itself is missing (old local Bot API server); anything else is this
      // one message's content, so keep rich enabled for the next.
      if (err instanceof GrammyError && err.error_code === 404) {
        richSupported = false
      }
      log(`rich send failed (${err}) — falling back to HTML`)
    }
  }
  // The rich limit is 8× the plain one, so a chunk that was sized for rich may need splitting.
  const ids: number[] = []
  for (const part of chunk(text, MAX_CHUNK_LIMIT, 'length')) {
    const sent = await bot.api
      .sendMessage(chat_id, mdToHtml(part), { ...base, parse_mode: 'HTML' })
      .catch(() => bot.api.sendMessage(chat_id, part, base)) // never lose a message to formatting
    ids.push(sent.message_id)
  }
  return ids
}


async function doReply(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const target = targetFor(
    ownKeys(conn),
    params.chat_id as string | undefined,
    params.thread_id as string | undefined,
  )
  assertBoundTarget(conn, target)
  let text = params.text as string
  const reply_to = params.reply_to != null ? Number(params.reply_to) : undefined
  const files = (params.files as string[] | undefined) ?? []
  const parseMode = params.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined

  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  // Context-usage warning on real agent replies (this path only — hub control/status
  // messages don't go through doReply). % is scraped from the session's pane status line
  // (cached by pollScreens). Only when at/above the configured threshold.
  if (CONTEXT_WARN_PCT > 0) {
    const session = router.get(conn)
    const pane = session?.pane
    const pct = pane && session
      ? adapterForSession(session).parseContextPct(await capturePane(pane).catch(() => ''))
      : undefined
    if (pct != null && pct >= CONTEXT_WARN_PCT) {
      text = `${text}${t().contextWarn(String(pct))}` // at the bottom — so it doesn't push the reply itself down the screen
    }
  }

  // Decided once for the whole reply, so a table doesn't land in a different message shape than
  // the sentence introducing it. Captions are capped at 1024 whatever the method, so a reply
  // carrying files stays on the plain path.
  const rich = !parseMode && !files.length && richSupported && (params.format === 'rich' || needsRich(text))
  const chunks = chunk(text, rich ? MAX_RICH_LIMIT : MAX_CHUNK_LIMIT, 'length')
  const plan = planAttachments(files, chunks)
  // thread on EVERY send — otherwise chunks/files without reply_to land in General
  const threadOpt = inTopic(target.thread_id)
  const sentIds: number[] = []
  try {
    for (let i = 0; i < (plan.caption ? 0 : chunks.length); i++) {
      const base = {
        ...threadOpt,
        ...(reply_to != null && i === 0 ? { reply_parameters: { message_id: reply_to } } : {}),
      }
      if (parseMode) {
        // explicit format=markdownv2 — caller escaped it themselves, send raw
        const sent = await bot.api.sendMessage(target.chat_id, chunks[i], { ...base, parse_mode: parseMode })
        sentIds.push(sent.message_id)
      } else {
        sentIds.push(...(await sendMarkdown(target.chat_id, chunks[i], base, rich)))
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (target.thread_id != null && isThreadGoneError(err)) {
      void onTopicGone(`${target.chat_id}/${target.thread_id}`) // topic deleted mid-session
    }
    throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
  }
  const mediaOpts = {
    ...threadOpt,
    ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
  }
  // the caption belongs to the FIRST attachment only — on an album Telegram shows the first
  // item's caption as the album's, and repeating it on every item would print it N times
  let captionLeft = plan.caption
  const takeCaption = (): { caption: string; parse_mode: 'HTML' | 'MarkdownV2' } | Record<string, never> => {
    if (!captionLeft) {
      return {}
    }
    captionLeft = false
    return parseMode
      ? { caption: chunks[0], parse_mode: parseMode }
      : { caption: mdToHtml(chunks[0]), parse_mode: 'HTML' }
  }

  for (const batch of plan.photos) {
    const cap = takeCaption()
    if (batch.length === 1) {
      const sent = await bot.api.sendPhoto(target.chat_id, new InputFile(batch[0]), { ...mediaOpts, ...cap })
      sentIds.push(sent.message_id)
      continue
    }
    const media = batch.map((f, i) => ({ type: 'photo' as const, media: new InputFile(f), ...(i === 0 ? cap : {}) }))
    // a rejected caption must not sink the whole album — resend it unformatted, like the text path
    const sent = await bot.api.sendMediaGroup(target.chat_id, media, mediaOpts).catch(e => {
      if (!('caption' in cap)) {
        throw e
      }
      log(`album caption rejected, retrying plain: ${e}`)
      const plain = batch.map((f, i) => ({ type: 'photo' as const, media: new InputFile(f), ...(i === 0 ? { caption: chunks[0] } : {}) }))
      return bot.api.sendMediaGroup(target.chat_id, plain, mediaOpts)
    })
    sentIds.push(...sent.map(m => m.message_id))
  }
  for (const f of plan.docs) {
    const sent = await bot.api.sendDocument(target.chat_id, new InputFile(f), { ...mediaOpts, ...takeCaption() })
    sentIds.push(sent.message_id)
  }
  if (params.voice === true) {
    const audio = await synthesizeSpeech(text)
    if (audio) {
      const sent = await bot.api.sendVoice(target.chat_id, new InputFile(audio, 'reply.ogg'), {
        ...threadOpt,
        ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
      })
      sentIds.push(sent.message_id)
    }
  }
  return sentIds.length === 1
    ? `sent (id: ${sentIds[0]})`
    : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
}

async function doReact(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const chat_id = params.chat_id as string
  assertBoundChat(conn, chat_id)
  await bot.api.setMessageReaction(chat_id, Number(params.message_id), [
    { type: 'emoji', emoji: params.emoji as ReactionTypeEmoji['emoji'] },
  ])
  return 'reacted'
}

async function doEdit(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const chat_id = params.chat_id as string
  assertBoundChat(conn, chat_id)
  const parseMode = params.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
  const message_id = Number(params.message_id)
  const text = params.text as string
  // Telegram won't turn a plain message rich or a rich one plain, and the hub doesn't record
  // which it sent — so try the shape the new text asks for, then the other one.
  const asRich = () =>
    bot.api.raw.editMessageText({ chat_id, message_id, rich_message: { markdown: escapeForRich(text) } })
  const asHtml = () => bot.api.editMessageText(chat_id, message_id, mdToHtml(text), { parse_mode: 'HTML' })
  const edited = parseMode
    ? await bot.api.editMessageText(chat_id, message_id, text, { parse_mode: parseMode })
    : params.format === 'rich' || needsRich(text)
      ? await asRich().catch(asHtml)
      : await asHtml().catch(asRich)
  const id = typeof edited === 'object' ? edited.message_id : params.message_id
  return `edited (id: ${id})`
}

async function doDownload(params: Record<string, unknown>): Promise<string> {
  const file = await bot.api.getFile(params.file_id as string)
  if (!file.file_path) {
    throw new Error('Telegram returned no file_path — file may have expired')
  }
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

// Best-effort: any failure (no key, API error) just falls back to the raw
// "(voice message)" placeholder the session already knew how to handle.
// No ffmpeg step — Telegram's .oga IS an Ogg/Opus stream, byte-identical to .ogg;
// Whisper only keys off the filename extension in the upload, so a plain rename
// (no re-encode) is enough. Verified against real voice notes before landing this.
async function transcribeVoice(oggPath: string): Promise<string | undefined> {
  if (!STT_KEY) {
    return undefined
  }
  try {
    const audio = readFileSync(oggPath)
    // gpt-4o-transcribe caps its OUTPUT at ~2000 tokens and truncates a long voice note
    // mid-sentence with no error — a 16-min dictation came back as ~10 min of text.
    // whisper-1 chunks internally and has no such cap, so long notes go there instead.
    // ~4KB/s for Telegram's Opus → 1.5MB ≈ 6 min, comfortably under the cap.
    const model = audio.length > 1_500_000 ? 'whisper-1' : STT_MODEL
    const form = new FormData()
    form.append('file', new Blob([audio]), 'voice.ogg')
    form.append('model', model)
    form.append('language', 'ru')
    const res = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${STT_KEY}` },
      body: form,
    })
    if (!res.ok) {
      log(`STT transcription failed: HTTP ${res.status}`)
      return undefined
    }
    const data = (await res.json()) as { text: string }
    return data.text
  } catch (e) {
    log(`STT transcription error: ${e}`)
    return undefined
  }
}

// response_format 'opus' from OpenAI TTS is a real Ogg/Opus container — exactly what
// Telegram's sendVoice wants, no conversion step (verified against a real call before
// landing this, same as the STT rename trick above).
async function synthesizeSpeech(text: string): Promise<Buffer | undefined> {
  if (!TTS_KEY) {
    return undefined
  }
  try {
    const res = await fetch(`${TTS_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TTS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'opus' }),
    })
    if (!res.ok) {
      log(`TTS synthesis failed: HTTP ${res.status}`)
      return undefined
    }
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    log(`TTS synthesis error: ${e}`)
    return undefined
  }
}

// reply must never be able to send channel state (token, bindings.json)
function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// binding keys mid intentional teardown (e.g. /restart) — suppress the crash notice for these
const expectedDisconnect = new Set<string>()
const DEATH_GRACE_MS = 5000

// a stub's socket can close two ways: intentional (/restart flagged it in expectedDisconnect)
// or the tmux pane/process just died — the latter used to be silent until the user's next
// message revived it. Wait a beat for a reconnect (new spawn) before alarming.
async function notifyUnexpectedDeath(s: SessionInfo): Promise<void> {
  const key = s.bindingKeys?.[0]
  if (!key || expectedDisconnect.has(key)) {
    return
  }
  await new Promise(r => setTimeout(r, DEATH_GRACE_MS))
  if (expectedDisconnect.has(key)) {
    return
  }
  const binding = loadBindings()[key]
  if (!binding || connsForBinding(key, binding.dir).length > 0) {
    return
  }
  const target = keyToTarget(key)
  await bot.api
    .sendMessage(
      target.chat_id,
      t().sessionDied,
      { ...inTopic(target.thread_id), parse_mode: 'HTML' },
    )
    .catch(() => {})
}

function listenForStubs(): void {
rmQuiet(SOCK_PATH)
Bun.listen<undefined>({
  unix: SOCK_PATH,
  socket: {
    open(sock) {
      feeders.set(sock, makeLineDecoder<StubToHub>(
        msg => void handleStubMessage(sock, msg),
        e => log(`bad message from stub: ${e}`),
      ))
    },
    data(sock, data) {
      feeders.get(sock)?.(data.toString())
    },
    close(sock) {
      const s = router.get(sock)
      router.unsubscribe(sock)
      feeders.delete(sock)
      log(`stub disconnected (${router.size()} left)`)
      if (s) {
        void notifyUnexpectedDeath(s)
      }
    },
    error(_sock, err) {
      log(`stub socket error: ${err}`)
    },
  },
})
chmodSync(SOCK_PATH, 0o600)
log(`listening on ${SOCK_PATH}`)
}

// ── picker bridge: forward Claude Code TUI pickers to Telegram buttons ──
type ActivePicker = {
  chatId: string
  threadId?: number
  msgId: number
  hash: string
  token: string
  picker: Picker
  key: string // binding key — reject a tap if the pane got recycled to another session post-restart
}
const activePickers = new Map<string, ActivePicker>() // key = pane
const awaitingCustom = new Map<string, { chatId: string; threadId?: number; at: number; multi: boolean }>()

function bindingAllows(chatId: string, senderId: string): boolean {
  const reg = loadBindings()
  for (const [key, entry] of Object.entries(reg)) {
    if (keyToTarget(key).chat_id === chatId && entry.allow?.includes(senderId)) {
      return true
    }
  }
  return false
}

// allow-check scoped to ONE binding (not chat-wide) — for answering a specific topic's
// picker, where "allowed somewhere in this chat" would let a topic-A user answer topic-B.
function bindingAllowsKey(key: string, senderId: string): boolean {
  return loadBindings()[key]?.allow?.includes(senderId) ?? false
}

// A session's interactive prompts belong to Telegram ONLY if the hub spawned it —
// hub-spawned sessions carry bindingKeys. A session without them is a hand-started
// `claude` (the telegram stub is a global user-scope MCP, so every session connects); it
// has no topic and must be ignored, otherwise a terminal session opened in a bound dir
// would hijack that topic's pickers/messages via a cwd match. No dir-fallback on purpose.
function pickerChatFor(session: SessionInfo): { chatId: string; threadId?: number } | undefined {
  const key = session.bindingKeys?.[0]
  if (!key) {
    return undefined
  }
  const t = keyToTarget(key)
  return { chatId: t.chat_id, ...(t.thread_id != null ? { threadId: t.thread_id } : {}) }
}

function kbFrom(picker: Picker, token: string, checked: number[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const row of buildKeyboard(picker, token, checked).buttons) {
    for (const b of row) {
      kb.text(b.text, b.data)
    }
    kb.row()
  }
  return kb
}

function paneByToken(token: string): string | undefined {
  for (const [pane, ap] of activePickers) {
    if (ap.token === token) {
      return pane
    }
  }
  return undefined
}

// folder-trust / dev-channel prompts also carry "Esc to cancel"; the hub auto-acks
// them (see ackStartupPrompt below), so they must not surface as Telegram pickers.
// The 'Exit anyway' confirm during /stop//restart is NOT here on purpose: it
// surfaces as Telegram buttons via the picker bridge so the user can see the
// background task and choose; stopSession auto-answers only after a grace period.
function isAutoAckPrompt(picker: Picker): boolean {
  return isStartupTrustPrompt(picker)
}

// spawnSession/restartSession also ack these, but only inside a fixed 30s window after typing the
// launch — a slow start (host reboot with several sessions coming up at once) misses it and the
// pane then sits on the prompt forever, session dead to the chat. The poll loop sees every pane
// every tick, so ack here too: whenever a startup prompt shows up, regardless of how it got there
// (spawn, /restart, revive, a hand-typed launch). Re-ack after a cooldown in case Enter didn't land.
const autoAcked = new Map<string, { hash: string; at: number }>() // pane -> last ack
const AUTO_ACK_RETRY_MS = 8000

async function ackStartupPrompt(pane: string, picker: Picker): Promise<void> {
  const prev = autoAcked.get(pane)
  if (prev && prev.hash === picker.hash && Date.now() - prev.at < AUTO_ACK_RETRY_MS) {
    return
  }
  autoAcked.set(pane, { hash: picker.hash, at: Date.now() })
  log(`startup prompt auto-acked on ${pane}: ${picker.title.slice(0, 48)}`)
  await sendKeys(pane, 'Enter').catch(() => {})
}

async function ackCodexOwnToolApproval(pane: string, text: string): Promise<void> {
  const hash = fnv1a(text)
  const prev = autoAcked.get(pane)
  if (prev && prev.hash === hash && Date.now() - prev.at < AUTO_ACK_RETRY_MS) {
    return
  }
  autoAcked.set(pane, { hash, at: Date.now() })
  log(`tool approval auto-acked on ${pane}: own telegram MCP tool`)
  await sendKeys(pane, '3').catch(() => {}) // Always allow — больше в этой сессии не спросит
  await sendKeys(pane, 'Enter').catch(() => {})
}

async function ackCodexHooksTrustScreen(pane: string, text: string): Promise<void> {
  const hash = fnv1a(text)
  const prev = autoAcked.get(pane)
  if (prev && prev.hash === hash && Date.now() - prev.at < AUTO_ACK_RETRY_MS) {
    return
  }
  autoAcked.set(pane, { hash, at: Date.now() })
  log(`startup prompt auto-acked on ${pane}: Codex hooks trust`)
  // Именно «2», а не Enter: курсор стоит на «Review hooks», и Enter уводит в разбор.
  await sendKeys(pane, '2').catch(() => {})
  await sendKeys(pane, 'Enter').catch(() => {})
}

async function ackCodexStartupTrustScreen(pane: string, text: string): Promise<void> {
  const hash = fnv1a(text)
  const prev = autoAcked.get(pane)
  if (prev && prev.hash === hash && Date.now() - prev.at < AUTO_ACK_RETRY_MS) {
    return
  }
  autoAcked.set(pane, { hash, at: Date.now() })
  log(`startup prompt auto-acked on ${pane}: Codex directory trust`)
  await sendKeys(pane, 'Enter').catch(() => {})
}

// A session sitting on a startup prompt has NOT connected its stub yet (the MCP stub comes up only
// after the prompts are answered), so it is invisible to router.all() and PASS 1 never sees it —
// which is exactly how a swallowed Enter used to hang a pane forever. Scan the tmux session of each
// bound key that has no live stub and ack there too. Target the session (`=name:`) rather than a
// pane id, since we have no connection to ask for one.
async function ackStartupPromptsOnBoundPanes(): Promise<void> {
  for (const [key, b] of Object.entries(loadBindings())) {
    if (!b?.dir || router.byBindingKey(key).length > 0) {
      continue // no dir, or a stub is connected → PASS 1 already covers this pane
    }
    const name = sessionName(key, b.dir)
    if (!(await hasTmuxSession(name).catch(() => false))) {
      continue
    }
    const target = `=${name}:`
    const text = await captureTimeout(target).catch(() => '')
    if (text && isCodexStartupTrustScreen(text)) {
      await ackCodexStartupTrustScreen(target, text)
      continue
    }
    if (text && isCodexHooksTrustScreen(text)) {
      await ackCodexHooksTrustScreen(target, text)
      continue
    }
    const picker = text ? parsePicker(text) : undefined
    if (picker && isAutoAckPrompt(picker)) {
      await ackStartupPrompt(target, picker)
    }
  }
}

function pickerTitleHtml(ap: ActivePicker): string {
  return `❓ <b>${escHtml(ap.picker.title || t().pickerDefaultTitle)}</b>`
}

function resolvedText(ap: ActivePicker, answer: string): string {
  return `${pickerTitleHtml(ap)}\n\n${answer}`
}

async function resolvePickerMessage(ap: ActivePicker, answer: string): Promise<void> {
  await bot.api
    .editMessageText(ap.chatId, ap.msgId, resolvedText(ap, answer), { parse_mode: 'HTML' })
    .catch(() => {})
}

async function detectPicker(pane: string, session: SessionInfo, text: string): Promise<void> {
  // Разрешение на наш собственный telegram-тул отвечаем сами и в чат не выносим: без него
  // агент не может ответить вовсе, а пользователь получал бы вопрос на каждую реплику.
  if (isCodexOwnToolApproval(text)) {
    await ackCodexOwnToolApproval(pane, text)
    return
  }
  const picker = parsePicker(text)
  const existing = activePickers.get(pane)
  if (!picker || isAutoAckPrompt(picker)) {
    if (picker) {
      await ackStartupPrompt(pane, picker) // never surfaced to chat — and never left hanging
    }
    if (existing) {
      // closed without a TG tap (answered in the TUI) — the answer is unknown to us
      void resolvePickerMessage(existing, t().pickerAnsweredInTerminal)
      disarmPicker(pane)
    }
    return
  }
  if (existing && existing.hash === picker.hash) {
    // Already tracked (incl. a picker recovered from disk after a restart) — no duplicate send.
    return
  }
  const target = pickerChatFor(session)
  if (!target) {
    return
  }
  const key = session.bindingKeys?.[0] ?? ''
  // Restart recovery: if disk staged a picker for this pane, adopt its Telegram message instead of
  // sending a duplicate — but only when the SAME pane still shows the SAME picker under the SAME
  // binding (a recycled pane / moved-on session fails this and the stale bubble is closed instead).
  const rec = recoveredPickers.get(pane)
  if (rec) {
    recoveredPickers.delete(pane)
    if (rec.hash === picker.hash && rec.key === key) {
      armPicker(pane, {
        chatId: rec.chatId,
        ...(rec.threadId != null ? { threadId: rec.threadId } : {}),
        msgId: rec.msgId, hash: picker.hash, token: picker.hash, picker, key,
      })
      log(`picker recovered: pane=${pane} msg=${rec.msgId}`)
      return
    }
    stateRepo.delPicker(pane)
    void bot.api
      .editMessageText(rec.chatId, rec.msgId, t().pickerClosedRestart, { parse_mode: 'HTML' })
      .catch(() => {})
  }
  // Reserve the slot synchronously before the await below — otherwise an overlapping
  // pollScreens tick for the same pane sees `existing === undefined` too and double-sends.
  // In-memory only (msgId:-1 is a transient placeholder — nothing worth persisting yet).
  activePickers.set(pane, {
    chatId: target.chatId,
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
    msgId: -1,
    hash: picker.hash,
    token: picker.hash,
    picker,
    key,
  })
  const sent = await bot.api
    .sendMessage(target.chatId, `❓ <b>${escHtml(picker.title || 'Question')}</b>`, {
      ...inTopic(target.threadId),
      parse_mode: 'HTML',
      reply_markup: kbFrom(picker, picker.hash, checkedIndexes(text)),
    })
    .catch(() => undefined)
  if (sent) {
    log(`picker sent: pane=${pane} mode=${picker.mode} opts=${picker.options.length} title="${picker.title.slice(0, 40)}"`)
    armPicker(pane, {
      chatId: target.chatId,
      ...(target.threadId != null ? { threadId: target.threadId } : {}),
      msgId: sent.message_id,
      hash: picker.hash,
      token: picker.hash,
      picker,
      key,
    })
  } else if (activePickers.get(pane)?.msgId === -1) {
    disarmPicker(pane) // send failed — don't leave a permanently-unresolvable placeholder
  }
}

// Subagent tracking, fed by PreToolUse/SubagentStart/SubagentStop/Stop hooks
// (src/subagent-hook.ts) — independent of the screen-diff typing nudge below, and used
// to render a self-editing "active agents" status message per binding key. Finished
// agents stay in the list (checkmark instead of the running dot) rather than
// disappearing — the message is the batch's history, not just a running snapshot.
// A batch = one turn — but Stop fires whenever the FOREGROUND response finishes, even if
// a run_in_background agent is still going, so "Stop happened" alone can't close a batch:
// a genuinely new message is only warranted once Stop has fired AND every tracked agent is
// actually done. Otherwise a still-running background agent would be silently abandoned in
// its old (now-replaced) map the moment the next turn starts a fresh one.

// One self-updating Telegram message per binding key, per turn: sent once, then edited in place
// as state changes; a fresh batch (caller decides) starts a NEW message at the bottom. The
// msgId=-1 reservation serialises the first send so racing events (a workflow fans out N agents
// at once) don't each spawn their own bubble. Replaces four hand-rolled, subtly-divergent copies
// of this logic — task and skill were missing the reservation and could double-send.
//
// The single status bubble owns the only instance; `fresh` comes from beginStatusBatch() below,
// which combines sinceTurnEnd() with "nothing still running".
class PerTurnEditablePost {
  private msg = new Map<string, number>() // key -> Telegram message id (-1 = first send in flight)
  private turnEnded = new Map<string, boolean>() // key -> a Stop happened since this post's last batch
  endTurn(key: string): void { this.turnEnded.set(key, true) }
  sinceTurnEnd(key: string): boolean { return this.turnEnded.get(key) ?? true }
  forget(key: string): void { this.msg.delete(key); this.turnEnded.delete(key) }

  // `render` returns the HTML for the current domain state; it is called again after the first
  // send to fold in state that changed during the await. `fresh` = the caller's "new batch" call.
  async update(key: string, fresh: boolean, render: () => string): Promise<void> {
    if (fresh) {
      this.msg.delete(key) // new batch — start a fresh message at the bottom
    }
    this.turnEnded.set(key, false)
    const { chat_id, thread_id } = keyToTarget(key)
    const threadOpt = inTopic(thread_id)
    const existing = this.msg.get(key)
    if (existing === undefined) {
      this.msg.set(key, -1) // reserve synchronously before the await
      const text = render()
      const sent = await bot.api
        .sendMessage(chat_id, text, { ...threadOpt, parse_mode: 'HTML' })
        .catch(() => undefined)
      if (!sent) {
        if (this.msg.get(key) === -1) this.msg.delete(key) // send failed — release the reservation
        return
      }
      this.msg.set(key, sent.message_id)
      const latest = render() // events that raced in while sending skipped their edit — re-render now
      if (latest !== text) {
        await bot.api.editMessageText(chat_id, sent.message_id, latest, { parse_mode: 'HTML' }).catch(() => {})
      }
      return
    }
    if (existing === -1) {
      return // first send still in flight — the post-send re-render above will pick up this state
    }
    await bot.api.editMessageText(chat_id, existing, render(), { parse_mode: 'HTML' }).catch(() => {})
  }
}
// ONE bubble for everything a turn spawns — agents, tasks, todos, skills, background shells.
// Four separate posts meant a busy turn sent four notifications; now the first event sends and
// every later one edits. State per key lives in `statusState`; rendering is pure (status-render).
const statusPost = new PerTurnEditablePost()
const statusState = new Map<string, StatusState>()

// Returns the state to mutate, and whether this event opens a NEW bubble. A new batch starts
// only once the turn ended AND nothing is still running — a run_in_background agent outlives
// the Stop hook, and closing the bubble on Stop alone would abandon it half-reported.
function beginStatusBatch(key: string): { state: StatusState; fresh: boolean } {
  const prev = statusState.get(key)
  if (prev && !(statusPost.sinceTurnEnd(key) && !hasLiveWork(prev))) {
    return { state: prev, fresh: false }
  }
  const state = emptyStatus()
  statusState.set(key, state)
  return { state, fresh: true } // first-ever event: nothing to reset, update() sends anyway
}

// "is this binding still working?" for the typing nudge and idle-unload guard.
const keyIsBusy = (key: string): boolean => {
  const state = statusState.get(key)
  return !!state && hasLiveWork(state)
}

async function pushStatus(key: string, state: StatusState, fresh: boolean): Promise<void> {
  if (statusIsEmpty(state)) {
    return // e.g. an update for an item that predates this batch — nothing to show yet
  }
  await statusPost.update(key, fresh, () => renderStatus(state))
}
// PreToolUse(Agent) fires before SubagentStart and carries the human description;
// SubagentStart itself only has agent_id/agent_type — correlate the two via promptId.
const pendingDescriptions = new Map<string, string>()

// ── reply-fallback safety net ───────────────────────────────────────────────
// A Telegram-triggered turn that ends without the agent calling ANY egress tool
// (reply/react/edit — voice rides inside reply) means the agent wrote its answer
// into the transcript but forgot to send it (~1-in-5 substantive turns, measured on
// habebe-trader). On turnend we read the turn's final assistant text from the .jsonl
// and forward it ourselves. Files/voice/reactions still only travel the normal reply
// path — this only fires on a genuine miss, so no spam and no lost answers.
const pendingAnswer = new Map<string, { dir: string; at: number }>() // key -> inbound awaiting a reply
const lastFallback = new Map<string, string>() // key -> last auto-forwarded text (turnend can fire twice)
// Persist the two above so a hub restart between an inbound and the agent's reply no longer wipes
// the pending marker (the fallback would then never fire). Maps stay the runtime source of truth;
// the repo mirrors them to disk and rehydrates on boot.
const stateRepo = new HubStateRepository(log)
const launchCaptures = new Map<string, PersistedLaunchCapture>(stateRepo.launchCaptureEntries())
for (const [k, v] of stateRepo.pendingEntries()) pendingAnswer.set(k, v)
for (const [k, v] of stateRepo.fallbackEntries()) lastFallback.set(k, v)
function armPending(key: string, v: { dir: string; at: number }): void { pendingAnswer.set(key, v); stateRepo.setPending(key, v) }
function disarmPending(key: string): void { pendingAnswer.delete(key); stateRepo.delPending(key) }
// Пускать ли досылку (см. src/fallback-gate.ts). Живёт в пределах хода и рестарт хаба не
// переживает — тогда просто вернётся прежнее поведение, лишняя досылка вместо потерянной.
const fallbackGate = new FallbackGate()
function recordFallback(key: string, text: string): void { lastFallback.set(key, text); stateRepo.setFallback(key, text) }

function armLaunchCapture(key: string, before: Map<string, number>): void {
  const value: PersistedLaunchCapture = { beforeIds: [...before.keys()], at: Date.now() }
  launchCaptures.set(key, value)
  stateRepo.setLaunchCapture(key, value)
  // This is the crash boundary: the command is typed immediately afterwards.
  stateRepo.flush()
}

function disarmLaunchCapture(key: string): void {
  launchCaptures.delete(key)
  stateRepo.delLaunchCapture(key)
}

function resumeLaunchCapture(key: string, binding: BindingEntry): void {
  const capture = launchCaptures.get(key)
  if (!capture || binding.sessionId || Date.now() - capture.at > 90_000) {
    if (capture && Date.now() - capture.at > 90_000) disarmLaunchCapture(key)
    return
  }
  const adapter = adapterForBinding(binding)
  if (!adapter.capabilities.captureSessionIdAtLaunch) {
    disarmLaunchCapture(key)
    return
  }
  const before = new Map(capture.beforeIds.map(id => [id, 0]))
  void captureNewAdapterSessionId(adapter, binding.dir, before, 60_000).then(id => {
    if (!id) {
      disarmLaunchCapture(key)
      return
    }
    const reg = loadBindings()
    if (reg[key] && !reg[key].sessionId && !sessionOwner(reg, reg[key].dir, id, key)) {
      reg[key].sessionId = id
      saveBindings(reg)
      log(`recovered sessionId after hub restart for ${key}: ${id}`)
    } else if (reg[key] && !reg[key].sessionId) {
      log(`recovered sessionId rejected for ${key}: ${id} is owned by another binding`)
    }
    disarmLaunchCapture(key)
  })
}
const FALLBACK_MAX_CHARS = 3500 // cap the safety-net forward; a huge answer gets truncated, not spammed

// ── restart-survivable interactive state (Stage 3) ──────────────────────────
// An open picker outlives a hub restart: it is re-adopted only if the same pane still shows the same
// picker (recoveredPickers stages disk entries until the poll loop confirms them — see detectPicker),
// so a recycled pane can never resolve someone else's prompt.
const RECOVER_MAX_AGE_MS = 60 * 60 * 1000 // ignore anything older than an hour on boot (stale)
const RECOVER_GRACE_MS = 90 * 1000 // give revived sessions this long to re-show a recovered picker

function armPicker(pane: string, ap: ActivePicker): void {
  activePickers.set(pane, ap)
  stateRepo.setPicker(pane, { ...ap, at: Date.now() })
}
function disarmPicker(pane: string): void { activePickers.delete(pane); stateRepo.delPicker(pane) }

// pane -> a persisted picker awaiting confirmation that its session/pane still shows it
const recoveredPickers = new Map<string, PersistedPicker>()
for (const [pane, v] of stateRepo.pickerEntries()) {
  if (Date.now() - v.at > RECOVER_MAX_AGE_MS) { stateRepo.delPicker(pane); continue }
  recoveredPickers.set(pane, v)
}
// A recovered picker whose session never came back (or moved on) after the grace: close its
// Telegram message and forget it, so a dead button doesn't linger.
if (recoveredPickers.size > 0) {
  setTimeout(() => {
    for (const [pane, v] of recoveredPickers) {
      recoveredPickers.delete(pane)
      stateRepo.delPicker(pane)
      void bot.api
        .editMessageText(v.chatId, v.msgId, t().pickerClosedNoRevive, { parse_mode: 'HTML' })
        .catch(() => {})
    }
  }, RECOVER_GRACE_MS)
}

// The live session on `pane` really belongs to binding `key` (guards against a recycled pane id).
function paneBelongsToKey(pane: string, key: string): boolean {
  if (!key) return true // legacy picker without a stored key — nothing to check against
  return router.all().some(c => { const s = router.get(c); return s?.pane === pane && !!s.bindingKeys?.includes(key) })
}

// ── skill slash-commands ──
// GLOBAL skills (user + enabled plugins) become bot commands so every chat gets native
// /-autocomplete. The registered name is mangled (deep_research) and mapped back to the
// real slash name (/deep-research) on invocation. PROJECT-local skills go through the
// /skills button menu instead — Telegram command scopes are per-chat, not per-topic.
// Command names are language-independent; descriptions come from the current lang table,
// so the menu re-registers (with translated descriptions) whenever /lang switches.
const OPS_NAMES = new Set([
  'status', 'resume', 'screen', 'last', 'new', 'fork', 'skills', 'stand_up', 'stand_down',
  'pin', 'unpin', 'reload', 'compact', 'clear', 'esc', 'enter', 'model', 'stop',
  'restart', 'bind', 'unbind', 'delete', 'allow', 'lang',
])
function opsCommands(): { command: string; description: string }[] {
  const L = t()
  return [
    { command: 'status', description: L.cmd_status },
    { command: 'resume', description: L.cmd_resume },
    { command: 'screen', description: L.cmd_screen },
    { command: 'last', description: L.cmd_last },
    { command: 'new', description: L.cmd_new },
    { command: 'fork', description: L.cmd_fork },
    { command: 'skills', description: L.cmd_skills },
    { command: 'stand_up', description: L.cmd_stand_up },
    { command: 'stand_down', description: L.cmd_stand_down },
    { command: 'pin', description: L.cmd_pin },
    { command: 'unpin', description: L.cmd_unpin },
    { command: 'reload', description: L.cmd_reload },
    { command: 'compact', description: L.cmd_compact },
    { command: 'clear', description: L.cmd_clear },
    { command: 'esc', description: L.cmd_esc },
    { command: 'enter', description: L.cmd_enter },
    { command: 'queue', description: L.cmd_queue },
    { command: 'model', description: L.cmd_model },
    { command: 'stop', description: L.cmd_stop },
    { command: 'restart', description: L.cmd_restart },
    { command: 'bind', description: L.cmd_bind },
    { command: 'unbind', description: L.cmd_unbind },
    { command: 'delete', description: L.cmd_delete },
    { command: 'allow', description: L.cmd_allow },
    { command: 'lang', description: L.cmd_lang },
  ]
}
const TG_CMD_MAX = 100 // Telegram's hard cap on bot commands
let globalSkillMap = new Map<string, string>() // mangled command → real skill name
let lastSkillCount = 0
let cmdRetryTimer: ReturnType<typeof setTimeout> | undefined
const CMD_RETRY_MS = 60_000

// Rediscover global skills and (re)register the bot command list. Returns a summary.
async function refreshCommands(): Promise<string> {
  const L = t()
  const ops = opsCommands()
  let skills: Skill[]
  let failed: number
  try {
    ;({ skills, failed } = await discoverGlobalSkills())
  } catch (e) {
    log(`refreshCommands: discover failed: ${e}`)
    return L.skillsScanFail
  }
  const map = new Map<string, string>()
  const cmds: { command: string; description: string }[] = []
  let dropped = 0
  for (const s of skills) {
    const cmd = mangleCmd(s.name)
    // empty, clashes with an ops command, a mangling clash, or over Telegram's cap —
    // skip. Overflow skills stay runnable: typing "/name" still routes to the pane.
    if (!cmd || OPS_NAMES.has(cmd) || map.has(cmd) || ops.length + cmds.length >= TG_CMD_MAX) {
      dropped++
      continue
    }
    map.set(cmd, s.name)
    cmds.push({ command: cmd, description: tgDescription(s.description) })
  }
  // `plugin details` fan-out times out when a boot-time revive burst loads the box; publishing
  // the survivors would silently strip most of the bot's commands until the next restart.
  // Keep whatever we published last time and retry once instead.
  // A failure means the list is incomplete, so always re-run once — at boot (lastSkillCount 0)
  // that retry is the only thing standing between us and a silently truncated list.
  if (failed > 0 && !cmdRetryTimer) {
    cmdRetryTimer = setTimeout(() => {
      cmdRetryTimer = undefined
      void refreshCommands()
    }, CMD_RETRY_MS)
    cmdRetryTimer.unref?.()
  }
  if (failed > 0 && cmds.length < lastSkillCount) {
    const summary = L.skillsCollapsed(cmds.length, lastSkillCount, failed, CMD_RETRY_MS / 1000)
    log(`refreshCommands: ${summary}`)
    return summary
  }
  globalSkillMap = map
  lastSkillCount = cmds.length
  // Telegram also caps the TOTAL size of the command list (~5k description chars), not
  // just the count — it rejects with BOT_COMMANDS_TOO_MUCH. Rather than guess the exact
  // byte budget, shrink skill descriptions down a ladder and retry until it fits.
  let usedCap = 256
  for (const cap of [256, 80, 48, 28, 16]) {
    usedCap = cap
    const all = [
      ...ops,
      ...cmds.map(c => ({ command: c.command, description: c.description.length > cap ? c.description.slice(0, cap - 1) + '…' : c.description })),
    ]
    try {
      await bot.api.setMyCommands(all)
      break
    } catch (e) {
      if (e instanceof GrammyError && /TOO_MUCH/.test(e.description) && cap !== 16) {
        continue // still too big — shorten further
      }
      log(`setMyCommands: ${e}`)
      break
    }
  }
  const summary = L.cmdsSummary(
    ops.length + cmds.length,
    ops.length,
    cmds.length,
    dropped,
    usedCap < 256 ? L.cmdsCapNote(usedCap) : '',
    failed ? L.cmdsFailNote(failed, CMD_RETRY_MS / 1000) : '',
  )
  log(`refreshCommands: ${summary}`)
  return summary
}

// /skills menus: token → the project skills a message's buttons run. Callback data is
// tiny (skrun:<token>:<idx>), so the name list lives here, not in the button payload.
const skillMenus = new Map<string, { key: string; dir: string; names: string[] }>()
let skillMenuSeq = 0
const SKILL_PAGE = 8 // skills per page — one column, so keep it short enough to not scroll

// One-column skill buttons + a ◀ page/pages ▶ nav row (only when >1 page).
function skillMenuKeyboard(token: string, names: string[], page: number): InlineKeyboard {
  const pages = Math.max(1, Math.ceil(names.length / SKILL_PAGE))
  const p = Math.min(Math.max(0, page), pages - 1)
  const kb = new InlineKeyboard()
  names.slice(p * SKILL_PAGE, p * SKILL_PAGE + SKILL_PAGE).forEach((name, i) => {
    kb.text(name, `skrun:${token}:${p * SKILL_PAGE + i}`).row()
  })
  if (pages > 1) {
    if (p > 0) {
      kb.text('◀', `skpg:${token}:${p - 1}`)
    }
    kb.text(`${p + 1}/${pages}`, `skpg:${token}:${p}`) // middle = current page (no-op tap)
    if (p < pages - 1) {
      kb.text('▶', `skpg:${token}:${p + 1}`)
    }
  }
  return kb
}

// Type an agent-native skill invocation into every live pane, ack, and arm reply fallback.
// Claude needs its slash-autocomplete escape dance; Codex gets a normal explicit instruction
// so the supported 0.147 Docker CLI does not strand a `$skill` selector in its input field.
async function injectSkillToPanes(
  conns: Socket<undefined>[], cmdText: string, key: string, dir: string,
  chat_id: string, threadId: number | undefined, msgId: number | undefined, agent: AgentKind,
): Promise<boolean> {
  let typed = false
  for (const conn of conns) {
    const pane = router.get(conn)?.pane
    if (!pane) {
      continue
    }
    // Единственный путь доставки, который печатал сразу: в поднимающуюся сессию команда
    // уходила в никуда и молча пропадала. Ждём так же, как обычные сообщения.
    const session = router.get(conn)
    await waitPaneReady(pane, PANE_READY_MS, session ? adapterForSession(session) : undefined)
    const inject = agent === 'claude' ? typeSlashCommand : typeLine
    await inject(pane, cmdText).catch(e => log(`inject skill failed: ${e}`))
    typed = true
  }
  if (typed) {
    if (msgId != null) {
      void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👀' }]).catch(() => {})
    }
    typing(chat_id, threadId)
    snapshotScreens(key, cmdText, conns)
    armPending(key, { dir, at: Date.now() }) // reply-fallback armed
  }
  return typed
}

// Any agent-initiated egress for this session counts as "answered" — drop the pending marker
// so turnend won't also forward. Called only after the egress send actually succeeded.
function clearPendingAnswer(conn: Socket<undefined>): void {
  for (const k of ownKeys(conn)) {
    disarmPending(k)
    fallbackGate.noteAnswered(k) // и на дописанное в этот же ход досылка уже не сработает
  }
}

async function forwardFallbackReply(key: string): Promise<void> {
  const pending = pendingAnswer.get(key)
  if (!pending) {
    return
  }
  disarmPending(key) // one shot per inbound, whatever the transcript holds
  if (!fallbackGate.shouldForward(key)) {
    log(`reply-fallback: ${key} — агент в этом ходе уже отвечал, не досылаю`)
    return
  }
  // Read THIS binding's conversation, not whatever file in the project dir was touched last:
  // several topics routinely share one project dir, and "newest in dir" forwarded a neighbour
  // topic's answer into this one. Resolved now, not at arm time — /clear or an in-TUI /resume
  // may have moved the binding to another session id since the inbound arrived.
  const binding = loadBindings()[key]
  const sessionId = binding?.sessionId
  const adapter = adapterForBinding(binding)
  // Wait for the turn's transcript writes to FINISH before reading — not just for some text
  // to appear. The Stop hook that triggers turnend fires mid-flush: when only an intermediate
  // preamble is on disk while the real final answer is still being written (seen live —
  // forwarded "…let me verify…" while the actual answer landed ~200ms later). Poll the file
  // size until it goes quiet (filesystem-agnostic "flush done"), THEN read the final text.
  let lastSize = -1
  let stable = 0
  for (let i = 0; i < 30; i++) {
    const sz = adapter.transcriptSize(pending.dir, sessionId)
    if (sz === lastSize) {
      if (++stable >= 3) {
        break // size unchanged for ~600ms — the turn has fully flushed
      }
    } else {
      lastSize = sz
      stable = 0
    }
    await new Promise(r => setTimeout(r, 200)) // ~6s hard cap
  }
  const text = adapter.lastAssistantText(pending.dir, pending.at, sessionId)
  if (!text || lastFallback.get(key) === text) {
    return // no fresh textual answer this turn, or already forwarded
  }
  recordFallback(key, text)
  const target = keyToTarget(key)
  const threadOpt = inTopic(target.thread_id)
  const body = text.length > FALLBACK_MAX_CHARS ? `${text.slice(0, FALLBACK_MAX_CHARS)}\n\n${t().truncatedNote}` : text
  // marker so it's visibly distinct from a normal reply — a fallback means the agent
  // forgot to call reply, which is itself a signal worth seeing.
  // rich Markdown understands the label's HTML too, so one path renders both halves
  await sendMarkdown(target.chat_id, `${t().autoForwardLabel}\n\n${body}`, threadOpt).catch(e =>
    log(`reply-fallback send failed key=${key}: ${e}`),
  )
  log(`reply-fallback: forwarded ${text.length} chars for key=${key} (agent never called reply)`)
}

async function handleSubagentEvent(msg: Extract<StubToHub, { op: 'subagent' }>): Promise<void> {
  if (msg.action === 'describe') {
    log(`subagent: describe promptId=${msg.promptId} "${msg.description}"`)
    pendingDescriptions.set(msg.promptId, msg.description)
    setTimeout(() => pendingDescriptions.delete(msg.promptId), 30_000) // safety net if never claimed
    return
  }
  if (msg.action === 'turnend') {
    log(`subagent: turnend keys=${msg.bindingKeys.join(',')} bg=${msg.bg?.length ?? 0}`)
    for (const key of msg.bindingKeys) {
      await reconcileBg(key, msg.bg ?? []) // before endTurn: pushStatus clears the turn-ended flag
      statusPost.endTurn(key)
      await forwardFallbackReply(key) // agent didn't reply → forward its final text ourselves
      fallbackGate.endTurn(key) // ход закрыт: следующий начинается с чистого листа
      await flushQueued(key) // отложенное через /queue — ход кончился, самое время
    }
    return
  }
  // workflow agents carry no name in the hook (only "workflow-subagent") — their status comes
  // from the pane-scraped workflow line (handleWorkflow) with the real name, so skip them here
  // to avoid a duplicate generic "🤖 Agents" message.
  if (msg.action === 'start' && msg.agentType === 'workflow-subagent') {
    return
  }
  for (const key of msg.bindingKeys) {
    if (msg.action === 'stop') {
      // A stop never opens a batch: with nothing tracked (hub restarted mid-turn) there is
      // no name to show, so touching the bubble would only blank it.
      const state = statusState.get(key)
      const existing = state?.agents.get(msg.agentId)
      if (existing) {
        existing.done = true
      }
      log(`subagent: stop key=${key} agentId=${msg.agentId} found=${!!existing}`)
      if (state && existing) {
        await pushStatus(key, state, false)
      }
      continue
    }
    const { state, fresh } = beginStatusBatch(key)
    const description = pendingDescriptions.get(msg.promptId)
    if (description) {
      pendingDescriptions.delete(msg.promptId)
    }
    state.agents.set(msg.agentId, { name: description ?? msg.agentType, done: false })
    log(`subagent: start key=${key} agentId=${msg.agentId} type=${msg.agentType} fresh=${fresh} name="${description ?? msg.agentType}"`)
    // live thunk (not a snapshot): the post-send re-render inside update() must see state that
    // racing events mutated during the await.
    await pushStatus(key, state, fresh)
  }
}

// Compaction progress, scraped from the pane (no hook exposes the %): Claude Code renders
// "✻ Compacting conversation… (elapsed)" + a "▰▱… NN%" bar during /compact and auto-compact.
// Mirror it into one self-editing Telegram message per pane. capturePane occasionally catches
// a mid-redraw frame WITHOUT the line, so finalize only after 2 consecutive misses (anti-flicker).
type CompactState = { chatId: string; threadId?: number; msgId: number; lastPct: number; misses: number }
const compactMessages = new Map<string, CompactState>() // key = pane

function renderCompactBar(pct: number, elapsed?: string): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled)
  return t().compaction(bar, String(pct), elapsed ? escHtml(elapsed) : '')
}

async function handleCompaction(pane: string, session: SessionInfo, text: string): Promise<void> {
  const prog = adapterForSession(session).parseCompaction(text)
  const existing = compactMessages.get(pane)
  if (prog) {
    if (!existing) {
      const target = pickerChatFor(session)
      if (!target) {
        return
      }
      // reserve the slot synchronously so an overlapping tick doesn't double-send
      compactMessages.set(pane, { chatId: target.chatId, ...(target.threadId != null ? { threadId: target.threadId } : {}), msgId: -1, lastPct: prog.pct, misses: 0 })
      const sent = await bot.api
        .sendMessage(target.chatId, renderCompactBar(prog.pct, prog.elapsed), {
          ...inTopic(target.threadId),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (sent) {
        compactMessages.set(pane, { chatId: target.chatId, ...(target.threadId != null ? { threadId: target.threadId } : {}), msgId: sent.message_id, lastPct: prog.pct, misses: 0 })
      } else if (compactMessages.get(pane)?.msgId === -1) {
        compactMessages.delete(pane)
      }
      return
    }
    existing.misses = 0
    if (existing.msgId === -1 || prog.pct === existing.lastPct) {
      return // still sending, or bar hasn't moved — skip the edit (Telegram rate-limits edits)
    }
    existing.lastPct = prog.pct
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, renderCompactBar(prog.pct, prog.elapsed), { parse_mode: 'HTML' })
      .catch(() => {})
  } else if (existing && existing.msgId !== -1) {
    if (++existing.misses < 2) {
      return // tolerate a single flicker frame before declaring it done
    }
    compactMessages.delete(pane)
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, t().compactionDone, { parse_mode: 'HTML' })
      .catch(() => {})
  }
}

// Running-workflow status, scraped from the pane — hooks expose only "workflow-subagent" with
// no name, but Claude Code renders the real name + agent count on one bottom line. Same
// self-editing + 2-miss anti-flicker as compaction; the workflow-subagent hook status is
// suppressed (handleSubagentEvent) so this doesn't double up.
type WorkflowState = { chatId: string; threadId?: number; msgId: number; last: string; name: string; total: number; misses: number }
const workflowMessages = new Map<string, WorkflowState>() // key = pane

function renderWorkflow(name: string, done: number, total: number): string {
  return t().workflow(escHtml(name), done, total)
}

async function handleWorkflow(pane: string, session: SessionInfo, text: string): Promise<void> {
  const wf = adapterForSession(session).parseWorkflow(text)
  const existing = workflowMessages.get(pane)
  if (wf) {
    const key = `${wf.name} ${wf.done}/${wf.total}`
    if (!existing) {
      const target = pickerChatFor(session)
      if (!target) {
        return
      }
      const base = { chatId: target.chatId, ...(target.threadId != null ? { threadId: target.threadId } : {}) }
      workflowMessages.set(pane, { ...base, msgId: -1, last: key, name: wf.name, total: wf.total, misses: 0 }) // reserve
      const sent = await bot.api
        .sendMessage(target.chatId, renderWorkflow(wf.name, wf.done, wf.total), {
          ...inTopic(target.threadId),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (sent) {
        workflowMessages.set(pane, { ...base, msgId: sent.message_id, last: key, name: wf.name, total: wf.total, misses: 0 })
      } else if (workflowMessages.get(pane)?.msgId === -1) {
        workflowMessages.delete(pane)
      }
      return
    }
    existing.misses = 0
    existing.name = wf.name
    existing.total = wf.total
    if (existing.msgId === -1 || existing.last === key) {
      return // still sending, or count unchanged — skip the edit
    }
    existing.last = key
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, renderWorkflow(wf.name, wf.done, wf.total), { parse_mode: 'HTML' })
      .catch(() => {})
  } else if (existing && existing.msgId !== -1) {
    if (++existing.misses < 2) {
      return // tolerate a flicker frame before declaring it done
    }
    workflowMessages.delete(pane)
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, t().workflowDone(escHtml(existing.name), existing.total), { parse_mode: 'HTML' })
      .catch(() => {})
  }
}

// Push error/auth banners (API Error, expired login, …) into the bound topic — no hook
// fires for them, so without this the user only sees them if watching tmux. Edge-triggered
// and deduped: the pane is scraped every 1.5s and a banner lingers for many ticks, so we
// notify once per NEW banner and re-arm after it scrolls off (parseError → undefined).
// ponytail: immediate re-arm can double-notify if a banner flickers in/out of the scanned
// window; errors are rare and missing one is worse than a rare dup — add a miss-counter if it nags.
const lastError = new Map<string, string>() // key = pane → last-notified banner
const errorMisses = new Map<string, number>() // pane → сколько подряд проверок без баннера
const ERROR_FORGET_TICKS = 10 // ~15с при опросе раз в 1.5с: столько ждём, прежде чем забыть баннер

async function handleErrors(pane: string, session: SessionInfo, text: string): Promise<void> {
  const adapter = adapterForSession(session)
  const err = adapter.parseError(text)
  if (!err) {
    // Не забываем баннер мгновенно: он уезжает и приезжает обратно в просматриваемое окно,
    // пока агент печатает, и на каждом возврате слался бы дубль. Чистим после нескольких
    // подряд чистых проверок (~15с) — тогда это действительно новая ошибка, а не прокрутка.
    const miss = (errorMisses.get(pane) ?? 0) + 1
    if (miss >= ERROR_FORGET_TICKS) {
      lastError.delete(pane)
      errorMisses.delete(pane)
    } else {
      errorMisses.set(pane, miss)
    }
    return
  }
  errorMisses.delete(pane)
  if (lastError.get(pane) === err) {
    return
  }
  // Агент уже работает дальше — значит ошибка была разовой и он от неё оправился
  // (типичный случай: "API Error: Connection closed mid-response", после которого идёт
  // повторная попытка). Молчим: паниковать поверх работающего агента только пугает.
  if (adapter.paneIsWorking(text)) {
    lastError.set(pane, err) // запомнить, чтобы не всплыло позже, когда агент затихнет
    return
  }
  lastError.set(pane, err)
  const target = pickerChatFor(session)
  if (!target) {
    return
  }
  // Auth can't be fixed from chat (OAuth is interactive) — we say what to do on the host,
  // otherwise the topic just stays silent on every message: the turn dies before reply is called.
  const authHint = /login|api key|oauth|credit balance/i.test(err)
    ? t().authHint
    : ''
  await bot.api
    .sendMessage(target.chatId, t().sessionError(escHtml(err), authHint), {
      ...inTopic(target.threadId),
      parse_mode: 'HTML',
    })
    .catch(e => log(`error-notify failed: pane=${pane} ${e}`))
}

// Task-list tracking, fed by TaskCreate/TaskUpdate hooks — no promptId dance: id/subject/status
// come straight off one PostToolUse event each. Feeds the shared status bubble.
async function handleTaskEvent(msg: Extract<StubToHub, { op: 'task' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    if (msg.action === 'update') {
      const state = statusState.get(key)
      const existing = state?.tasks.get(msg.taskId)
      if (existing) {
        existing.status = msg.status
      }
      log(`task: update key=${key} taskId=${msg.taskId} status=${msg.status} found=${!!existing}`)
      if (state && existing) {
        await pushStatus(key, state, false)
      }
      continue
    }
    const { state, fresh } = beginStatusBatch(key)
    state.tasks.set(msg.taskId, { subject: msg.subject, status: 'pending' })
    log(`task: create key=${key} taskId=${msg.taskId} fresh=${fresh} subject="${msg.subject}"`)
    await pushStatus(key, state, fresh)
  }
}

// TodoWrite (the ⊡/✓ checklist tool, distinct from TaskCreate/Update) — carries the FULL list
// each call, so no per-item lifecycle: just replace what the bubble shows.
async function handleTodoEvent(msg: Extract<StubToHub, { op: 'todo' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    const { state, fresh } = beginStatusBatch(key)
    state.todos = msg.todos
    await pushStatus(key, state, fresh)
  }
}

// Skill invocations — append-only: a Skill has no lifecycle, one PreToolUse event per call.
async function handleSkillEvent(msg: Extract<StubToHub, { op: 'skill' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    const { state, fresh } = beginStatusBatch(key)
    state.skills.push({ skill: msg.skill, ...(msg.args ? { args: msg.args } : {}) })
    log(`skill: key=${key} skill=${msg.skill}${msg.args ? ` args="${msg.args}"` : ''}`)
    await pushStatus(key, state, fresh)
  }
}

// Background shells own a message of their own, on the same send-once-then-edit machinery as
// the turn bubble but with a different lifetime: a run keeps its message until every shell in
// it has finished, however many turns that takes. The next shell after that starts a new one.
const bgPost = new PerTurnEditablePost()
const bgState = new Map<string, BgTask[]>() // key -> shells of the current run, done ones kept

// Returns the list to mutate, and whether this opens a NEW message: only once the previous run
// is fully finished. Otherwise a shell launched now joins the message already on screen.
function beginBgRun(key: string): { bg: BgTask[]; fresh: boolean } {
  const prev = bgState.get(key)
  if (prev?.some(b => !b.done)) {
    return { bg: prev, fresh: false }
  }
  const bg: BgTask[] = []
  bgState.set(key, bg)
  return { bg, fresh: true }
}

async function pushBg(key: string, bg: BgTask[], fresh: boolean): Promise<void> {
  if (bg.length) {
    await bgPost.update(key, fresh, () => renderBg(bg))
  }
}

// Backgrounded Bash (run_in_background) — the launch half, so the line appears mid-turn.
async function handleBgEvent(msg: Extract<StubToHub, { op: 'bg' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    const { bg, fresh } = beginBgRun(key)
    bg.push({ command: msg.command, ...(msg.description ? { description: msg.description } : {}) })
    log(`bg: key=${key} cmd="${msg.command.slice(0, 60)}"`)
    await pushBg(key, bg, fresh)
  }
}

// Unlike Claude's TUI bar, Codex hooks expose an exact compaction lifecycle but no numeric
// progress. One message per binding gives start → completion visibility without inventing a
// percentage from an unstable transcript.
const hookCompactions = new Map<string, { chatId: string; threadId?: number; msgId: number }>()
async function handleCompactionEvent(msg: Extract<StubToHub, { op: 'compaction' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    const existing = hookCompactions.get(key)
    if (msg.phase === 'start') {
      if (existing) continue
      const target = keyToTarget(key)
      const sent = await bot.api.sendMessage(target.chat_id, t().compactionStarted(msg.trigger ?? ''), {
        ...inTopic(target.thread_id), parse_mode: 'HTML',
      }).catch(() => undefined)
      if (sent) hookCompactions.set(key, { chatId: target.chat_id, ...(target.thread_id != null ? { threadId: target.thread_id } : {}), msgId: sent.message_id })
      continue
    }
    hookCompactions.delete(key)
    if (existing) {
      await bot.api.editMessageText(existing.chatId, existing.msgId, t().compactionDone, { parse_mode: 'HTML' }).catch(() => {})
    }
  }
}

// The completion half (syncBg does the diffing). Claude Code delivers each finished shell as a
// fresh prompt to the session, which ends in another Stop — that second turnend is what flips
// the line, seconds after the shell actually exited.
async function reconcileBg(key: string, live: BgTask[]): Promise<void> {
  const bg = bgState.get(key)
  if (!bg) {
    // Nothing tracked (hub restarted mid-run): adopt what Stop reports, so the shells still
    // running get a message instead of vanishing until they finish.
    if (live.length) {
      const { bg: fresh } = beginBgRun(key)
      fresh.push(...live)
      await pushBg(key, fresh, true)
    }
    return
  }
  if (syncBg(bg, live)) {
    await pushBg(key, bg, false)
  }
}

// One capture per live pane per tick, fanned out to screen detectors.
// last captured frame per pane — a change since the previous poll means the
// agent (or something) is actively doing something, worth a "typing…" nudge
const lastPaneText = new Map<string, string>()

// Идёт ли прямо сейчас ход в этой сессии. Берём последний кадр экрана из общего опроса,
// а не снимаем свой: `/queue` приходит в разгар работы, и лишний capture тут ни к чему.
// Свежесть кадра — в пределах такта опроса; для «занят / свободен» этого достаточно.
function keyIsWorking(key: string, dir: string): boolean {
  if (keyIsBusy(key)) {
    return true // работают сабагенты — ход точно не кончился
  }
  const pane = router.get(connsForBinding(key, dir)[0]!)?.pane
  const text = pane ? lastPaneText.get(pane) : undefined
  return text !== undefined && adapterForKey(key).paneIsWorking(text)
}

const captureTimeout = (pane: string): Promise<string> =>
  Promise.race([capturePane(pane).catch(() => ''), new Promise<string>(r => setTimeout(() => r(''), 2000))])

// Two-pass poll. PASS 1 (capture panes in parallel + fire "typing…") runs EVERY tick and is
// never blocked by Telegram sends, so the typing indicator can't starve while a heavy workflow
// spams status edits. PASS 2 (the detectors, which DO send) runs across panes in parallel
// (per-pane state → safe) and is skipped if a previous pass is still in flight, with a hard cap
// so a hung send can't wedge it forever.
let detectorsRunning = false
async function pollScreens(): Promise<void> {
  const sessions = router.all().map(c => router.get(c)).filter((s): s is SessionInfo & { pane: string } => !!s?.pane && !!s.cwd)
  const seen = new Set<string>()
  // PASS 1 — parallel capture + typing keep-alive (cheap, fire-and-forget)
  const captured = await Promise.all(
    sessions.map(async s => {
      const text = await captureTimeout(s.pane)
      seen.add(s.pane)
      const subagentBusy = s.bindingKeys?.some(k => keyIsBusy(k)) ?? false
      const prev = lastPaneText.get(s.pane)
      // Fire typing on: a running subagent, a visible working footer (covers static/byte-identical
      // captures where elapsed hadn't ticked — a pure diff would miss those and the indicator lapses),
      // or any pane change. paneIsWorking is the robust "agent is busy" signal from the live TUI.
      if (subagentBusy || adapterForSession(s).paneIsWorking(text) || (prev !== undefined && prev !== text)) {
        const target = pickerChatFor(s)
        if (target) {
          typing(target.chatId, target.threadId)
        }
      }
      lastPaneText.set(s.pane, text)
      return { s, text }
    }),
  )
  // Activity + idle-unload. Any pane movement or busy state = activity (covers agent output,
  // not just user input). A truly quiet, unpinned session past the threshold is stopped; the
  // next inbound message revives it (handleInbound). Guarded so we never stop a working pane.
  for (const { s, text } of captured) {
    const busy = s.bindingKeys?.some(k => keyIsBusy(k)) ?? false
    const adapter = adapterForSession(s)
    const working = busy || adapter.paneIsWorking(text) || !!adapter.parseWorkflow(text)
    if (working) {
      markActivity(s.bindingKeys)
    }
    if (IDLE_UNLOAD_MS > 0) {
      void maybeIdleUnload(s, working)
    }
  }
  for (const pane of [...activePickers.keys()]) if (!seen.has(pane)) disarmPicker(pane)
  for (const pane of [...lastPaneText.keys()]) if (!seen.has(pane)) lastPaneText.delete(pane)
  for (const pane of [...autoAcked.keys()]) if (!seen.has(pane)) autoAcked.delete(pane)
  void ackStartupPromptsOnBoundPanes() // panes with no stub yet (stuck on a startup prompt)
  for (const pane of [...compactMessages.keys()]) if (!seen.has(pane)) compactMessages.delete(pane)
  for (const pane of [...lastError.keys()]) if (!seen.has(pane)) { lastError.delete(pane); errorMisses.delete(pane) }
  for (const pane of [...workflowMessages.keys()]) if (!seen.has(pane)) workflowMessages.delete(pane)

  // PASS 2 — detectors, parallel across panes; skip if a prior pass is still running
  if (detectorsRunning) {
    return
  }
  detectorsRunning = true
  const done = Promise.all(
    captured.map(async ({ s, text }) => {
      await detectPicker(s.pane, s, text)
      await handleCompaction(s.pane, s, text)
      await handleWorkflow(s.pane, s, text)
      await handleErrors(s.pane, s, text)
    }),
  )
  // don't let a hung send wedge detectorsRunning forever — release after a hard cap regardless
  await Promise.race([done.catch(() => {}), new Promise<void>(r => setTimeout(r, 25_000))])
  detectorsRunning = false
}
const startScreenPoll = (): void => void setInterval(() => void pollScreens(), SCREEN_POLL_MS)

// Stop a quiet, unpinned, past-threshold session; the next inbound message revives it.
async function maybeIdleUnload(s: SessionInfo & { pane: string }, working: boolean): Promise<void> {
  const keys = s.bindingKeys ?? []
  const reg = loadBindings()
  if (keys.length === 0 || keys.some(k => reg[k]?.pinned)) {
    return // pinned binding on this session → never unload
  }
  const now = Date.now()
  const lastActive = Math.max(...keys.map(k => lastActivity.get(k) ?? now))
  const key = keys[0]
  if (unloading.has(key) || !isIdleToUnload(now, lastActive, IDLE_UNLOAD_MS, false, working)) {
    return
  }
  if (!s.pid) {
    return // can't stop what we can't signal
  }
  unloading.add(key)
  expectedDisconnect.add(key) // so the stub close isn't reported as a 💀 death
  const ok = await stopSession(s.pane, s.pid, log).catch(() => false)
  if (ok) {
    // no suspend message by design (any new message marks the topic unread) — only the wake
    // line is sent, on revive. State stays visible in /status and on the dashboard.
    for (const k of keys) {
      lastActivity.delete(k)
      idleUnloaded.add(k)
    }
    persistUnloaded(keys, true)
  } else {
    markActivity(keys) // stop failed (busy/picker open) → treat as active, retry after another idle window
  }
  log(`idle-unload: ${key} (${s.cwd}) stopped=${ok}`)
  setTimeout(() => expectedDisconnect.delete(key), 90_000)
  unloading.delete(key)
}

async function handlePickCallback(
  ctx: Context,
  pick: NonNullable<ReturnType<typeof parseCallback>>,
): Promise<void> {
  const pane = paneByToken(pick.token)
  const ap = pane ? activePickers.get(pane) : undefined
  if (!pane || !ap) {
    await ctx.answerCallbackQuery({ text: t().toastPickerClosed }).catch(() => {})
    return
  }
  // Post-restart safety: never send keys to a pane that has been recycled to a different session
  // than the one this picker belongs to (would answer the wrong agent).
  if (!paneBelongsToKey(pane, ap.key)) {
    disarmPicker(pane)
    await ctx.answerCallbackQuery({ text: t().toastPickerClosed }).catch(() => {})
    return
  }
  const senderId = String(ctx.from!.id)
  if (!isAdmin(senderId) && !bindingAllows(ap.chatId, senderId)) {
    await ctx.answerCallbackQuery({ text: t().toastNoAccess }).catch(() => {})
    return
  }
  const action = pick.action
  log(`pick: pane=${pane} from=${senderId} action=${action.kind}${action.kind === 'opt' ? action.index : ''}`)
  void capturePane(pane)
    .then(s => logDebugEvent({
      type: 'screen', key: ap.chatId, pane,
      trigger: `pick:${action.kind}${action.kind === 'opt' ? action.index : ''}`, screen: s,
    }))
    .catch(() => {})
  const labelOf = (i: number) => ap.picker.options.find(o => o.index === i)?.label ?? String(i)
  if (action.kind === 'opt' && ap.picker.mode === 'single') {
    await selectOption(pane, action.index)
    await resolvePickerMessage(ap, `✅ <b>${escHtml(labelOf(action.index))}</b>`)
    disarmPicker(pane)
    typing(ap.chatId, ap.threadId) // agent resumes on the answer
    await ctx.answerCallbackQuery({ text: t().toastChosen }).catch(() => {})
  } else if (action.kind === 'opt') {
    await sendKeys(pane, String(action.index)) // multi: toggle checkbox
    await ctx.answerCallbackQuery().catch(() => {})
    const text = await capturePane(pane).catch(() => '')
    await ctx
      .editMessageReplyMarkup({ reply_markup: kbFrom(ap.picker, ap.token, checkedIndexes(text)) })
      .catch(() => {})
  } else if (action.kind === 'submit') {
    const screen = await capturePane(pane).catch(() => '')
    const checked = checkedIndexes(screen)
    const chosen = checked.map(labelOf)
    if (ap.picker.customIndex != null && checked.includes(ap.picker.customIndex)) {
      // An inline custom value leaves focus in its input. Tab moves to the
      // adjacent Submit control; Enter submits without appending a digit.
      await sendKeys(pane, 'Tab')
      await new Promise(resolve => setTimeout(resolve, 100))
      await sendKeys(pane, 'Enter') // opens Claude's confirmation screen
      await new Promise(resolve => setTimeout(resolve, 100))
      await sendKeys(pane, 'Enter') // its preselected “Submit answers” action
    } else {
      await sendKeys(pane, 'Right') // → review screen
      await selectOption(pane, 1) // Submit answers
    }
    await resolvePickerMessage(ap, `✅ <b>${chosen.length ? escHtml(chosen.join(', ')) : '—'}</b>`)
    disarmPicker(pane)
    typing(ap.chatId, ap.threadId) // agent resumes on the submitted answers
    await ctx.answerCallbackQuery({ text: t().toastSent }).catch(() => {})
  } else {
    // The custom row is an inline field. In a multi picker navigate to it first;
    // Ctrl-G is only Claude's optional external-editor shortcut, never required UX.
    if (ap.picker.customIndex != null) {
      if (ap.picker.mode === 'multi') {
        const cursor = pickerCursorIndex(await capturePane(pane).catch(() => '')) ?? 1
        const move = ap.picker.customIndex - cursor
        if (move) await sendKeys(pane, ...Array(Math.abs(move)).fill(move > 0 ? 'Down' : 'Up'))
      } else {
        await sendKeys(pane, String(ap.picker.customIndex))
      }
    }
    awaitingCustom.set(pane, {
      chatId: ap.chatId,
      ...(ap.threadId != null ? { threadId: ap.threadId } : {}),
      at: Date.now(),
      multi: ap.picker.mode === 'multi',
    })
    await ctx.answerCallbackQuery({ text: t().toastSendText }).catch(() => {})
    void bot.api
      .sendMessage(ap.chatId, t().sendAnswerMsg, {
        ...inTopic(ap.threadId),
        parse_mode: 'HTML',
      })
      .catch(() => {})
  }
}

// The socket is 0600, but every Claude session runs shell as the hub user, so a
// prompt-injected session could connect and claim ANOTHER binding's keys to hijack its
// traffic. A claimed key is only honoured if it exists AND its dir is the session's real
// cwd (sessions launch via `tmux -c <binding.dir>`, so this holds for legit ones).
// ponytail: dir-match can't separate two bindings that share a folder (mode: folder) —
// a random per-session capability token would; add if same-dir hijack matters.
function verifyClaimedKeys(session: SessionInfo): SessionInfo {
  if (!session.bindingKeys?.length) {
    return session
  }
  const reg = loadBindings()
  const canon = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const cwd = session.cwd
  const sameDir = (a: string, b: string) => a === b || canon(a) === canon(b)
  const valid = session.bindingKeys.filter(k => cwd != null && reg[k] != null && sameDir(reg[k].dir, cwd))
  if (valid.length !== session.bindingKeys.length) {
    const dropped = session.bindingKeys.filter(k => !valid.includes(k))
    log(`subscribe: dropped unverified keys [${dropped}] for cwd=${cwd ?? '-'}`)
  }
  return { ...session, bindingKeys: valid.length ? valid : undefined }
}

// The hub otherwise learns a session id ONLY at spawn, and only for a FRESH start
// (captureNewSessionId). `/clear` and an in-TUI `/resume` switch the conversation with no spawn at
// all, so the binding silently kept a stale id (or none) and the next restart resumed the wrong
// conversation. Hook events carry the live id every turn — persist it whenever it drifts.
function syncSessionId(bindingKeys: string[], sessionId: string): void {
  const reg = loadBindings()
  let changed = false
  for (const key of bindingKeys) {
    const b = reg[key]
    const owner = b && sessionOwner(reg, b.dir, sessionId, key)
    if (owner) {
      // A hook is authoritative for its own process, but never turn two same-folder
      // topics into writers of one transcript. This also contains a late launch-capture
      // result from an older hub after a replacement session has already claimed the id.
      log(`sessionId sync rejected for ${key}: ${sessionId} is owned by ${owner}`)
      continue
    }
    if (b && b.sessionId !== sessionId) {
      log(`sessionId synced for ${key}: ${b.sessionId ?? '<none>'} → ${sessionId}`)
      b.sessionId = sessionId
      changed = true
    }
  }
  if (changed) {
    saveBindings(reg)
  }
}

// Подтверждения доставки от стаба: id → кому его отдать. Прямой ответ «отдал/не отдал»
// вместо гадания по транскрипту; старые стабы молчат, и сторож работает как раньше.
const pendingAcks = new Map<string, (r: 'ok' | 'failed') => void>()
const ACK_WAIT_MS = 10_000

function awaitAck(id: string): Promise<'ok' | 'failed' | 'silent'> {
  return new Promise(resolve => {
    pendingAcks.set(id, r => { pendingAcks.delete(id); resolve(r) })
    setTimeout(() => { if (pendingAcks.delete(id)) { resolve('silent') } }, ACK_WAIT_MS)
  })
}

async function handleStubMessage(sock: Socket<undefined>, msg: StubToHub): Promise<void> {
  if (msg.op === 'ack') {
    pendingAcks.get(msg.id)?.(msg.ok ? 'ok' : 'failed')
    if (!msg.ok) {
      log(`delivery: стаб не отдал сообщение в сессию: ${msg.error ?? '?'}`)
    }
    return
  }
  if (msg.op === 'subscribe') {
    const session = verifyClaimedKeys(msg.session)
    // A launch is not complete merely because its command was typed into tmux:
    // a second `/new` can arrive in the small gap before the stub connects. Keep
    // the per-binding launch guard until this authoritative handshake, otherwise
    // that second command sees a foreground `claude` and gets a misleading
    // foreign-pane refusal instead of being deduplicated.
    for (const key of session.bindingKeys ?? []) {
      spawningBindings.delete(key)
      const binding = loadBindings()[key]
      if (binding) resumeLaunchCapture(key, binding)
    }
    router.subscribe(sock, session)
    markActivity(session.bindingKeys) // fresh session = active now; starts the idle clock
    persistUnloaded(session.bindingKeys ?? [], false)
    learnCmdline(session)
    log(`subscribe: cwd=${session.cwd ?? '-'} pane=${session.pane ?? '-'}`)
    return
  }
  if (msg.op === 'rpc') {
    try {
      const result = await handleRpc(sock, msg.method, msg.params)
      send(sock, { op: 'result', id: msg.id, ok: true, result })
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err)
      send(sock, { op: 'result', id: msg.id, ok: false, error: e })
    }
    return
  }
  // Every hook event carries the live session id — one chokepoint keeps bindings.json honest.
  if ('bindingKeys' in msg && msg.sessionId) {
    const reliableKeys = msg.bindingKeys.filter(key => adapterForKey(key).capabilities.hookSessionIdReliable)
    if (reliableKeys.length) syncSessionId(reliableKeys, msg.sessionId)
    if (reliableKeys.length !== msg.bindingKeys.length) {
      log(`sessionId hook ignored for ${msg.bindingKeys.filter(key => !reliableKeys.includes(key)).join(',')}: adapter requires transcript correlation`)
    }
  }
  if (msg.op === 'subagent') {
    await handleSubagentEvent(msg)
    return
  }
  if (msg.op === 'compaction') {
    await handleCompactionEvent(msg)
    return
  }
  if (msg.op === 'task') {
    await handleTaskEvent(msg)
  }
  if (msg.op === 'skill') {
    await handleSkillEvent(msg)
  }
  if (msg.op === 'todo') {
    await handleTodoEvent(msg)
  }
  if (msg.op === 'bg') {
    await handleBgEvent(msg)
  }
}

// a live session's argv is remembered in its bindings — /resume relaunches with the same flags
function learnCmdline(session: SessionInfo): void {
  if (!session.cwd || !session.cmdline?.length) {
    return
  }
  // A headless one-shot (`claude -p '<prompt>'` — e.g. a cron/timer review job) also connects as a
  // session for this binding, but it must NEVER become the binding's launch command: relaunching it
  // replays that batch prompt into the user's chat and exits immediately, so the next inbound revives
  // it again — an endless loop. Hit in prod on 2026-07-21: a Role-2 review ran 5× in 11 minutes and
  // left the topic with no live session.
  if (adapterForSession(session).isHeadlessArgv(session.cmdline)) {
    log(`learnCmdline: ignoring headless (-p) argv for ${session.bindingKeys?.join(',') ?? session.cwd}`)
    return
  }
  const reg = loadBindings()
  let changed = false
  // Сессия, поднятая ХАБОМ, несёт ключи биндингов — она и есть их сессия. Всё остальное в той же
  // папке — посторонний процесс: запустили руками, зонд, соседний топик. Раньше такой сессии
  // отдавали все биндинги каталога, и она переписывала им argv И АГЕНТА: 2026-08-17 пробный codex
  // в ~/projects/homelab пометил давно живой claude-топик как codex, после чего хаб перестал
  // доставлять туда сообщения (у codex нет нативного входящего канала — ушёл печатать в пейн).
  const owned = !!session.bindingKeys?.length
  const keys = owned ? session.bindingKeys! : keysForDir(reg, session.cwd)
  const kind = session.agent ?? 'claude'
  for (const k of keys) {
    if (!reg[k]) {
      continue // stale bindingKeys — the binding was removed after this session launched
    }
    // Чужой сессии верим только про СВОЙ харнесс и только про argv: агента меняет тот, кто
    // биндинг создавал (пикер, /bind), а не случайный процесс, оказавшийся в той же папке.
    const may = mayLearn(owned, kind, reg[k].agent)
    if (may.argv && JSON.stringify(reg[k].cmdline) !== JSON.stringify(session.cmdline)) {
      reg[k].cmdline = session.cmdline
      changed = true
    }
    if (may.agent) {
      reg[k].agent = kind
      changed = true
    }
  }
  if (changed) {
    saveBindings(reg)
  }
}

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string }

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// Sessions serving a binding — strictly those that report this binding key. No cwd
// fallback: a hand-started `claude` in a bound dir (no bindingKeys) is not this topic's
// session, so an inbound to a topic with no live session revives a proper hub session
// (handleInbound) instead of hijacking the terminal one. `dir` kept for call-site symmetry.
function connsForBinding(key: string, _dir: string): Socket<undefined>[] {
  return router.byBindingKey(key)
}

async function waitForBinding(key: string, timeoutMs: number): Promise<Socket<undefined>[]> {
  const dir = loadBindings()[key]?.dir
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const conns = dir ? connsForBinding(key, dir) : router.byBindingKey(key)
    if (conns.length > 0) {
      return conns
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return []
}

// dir alone collides when several bindings share it (mode: shared) — tmux session is per-binding
function sessionName(key: string, dir: string): string {
  return tmuxSessionName(basename(dir), key)
}

function trackedPids(): Set<number> {
  const out = new Set<number>()
  for (const conn of router.all()) {
    const pid = router.get(conn)?.pid
    if (pid) {
      out.add(pid)
    }
  }
  return out
}

// Untracked claude processes that would FORK this binding's conversation — i.e. ones already
// holding its sessionId. A foreign claude working in the same folder on a different session is
// no conflict, and without a sessionId we spawn fresh, so there's nothing to fork either.
// Narrow on purpose: this refuses a revive, and a dead binding has nowhere else to go.
function forkRiskPids(binding: BindingEntry): number[] {
  const sid = binding.sessionId
  if (!sid) {
    return []
  }
  const tracked = trackedPids()
  const adapter = adapterForBinding(binding)
  return agentPidsInDir(binding.dir, adapter.isProcessArgv).filter(pid => {
    if (tracked.has(pid)) {
      return false
    }
    try {
      return cmdlineOf(pid).includes(sid)
    } catch {
      return false // vanished mid-scan
    }
  })
}

// /screen → фото: capture-pane -e → отрисовка сегментов на холсте (ansi-image).
async function renderScreenImage(pane: string): Promise<Uint8Array | undefined> {
  const ansi = (await capturePaneAnsi(pane)).replace(/\s+$/, '')
  return ansi ? await ansiToImage(ansi) : undefined
}

// /screen live view: one self-updating photo message + a Close button that fully deletes it —
// /screen is a debug aid that otherwise litters the history. A render + photo re-upload is
// ~300 KB of traffic, so refresh only when the pane text actually changed (cheap capturePane
// compare); auto-stop refreshing after SCREEN_LIVE_MS so an abandoned view doesn't render forever
// (the message + Close button stay so it can still be dismissed).
// kind: 'png' = /screen (rendered photo), 'text' = /last (paneDigest as a <pre> message).
// Both share the same live-view lifecycle (one self-updating message, Close button, auto-stop).
type LiveScreen = { chatId: string; threadId?: number; msgId: number; pane: string; lastText: string; kind: 'png' | 'text'; timer?: ReturnType<typeof setInterval> }
const liveScreens = new Map<string, LiveScreen>() // token -> view
let screenSeq = 0
const SCREEN_REFRESH_MS = 5000 // calm cadence — a busier tick just spams "edited" on the message
const SCREEN_LIVE_MS = 3 * 60_000
const LAST_LIVE_MS = 30 * 60_000 // /last — это editMessageText, ни рендера, ни заливки: живёт долго

const closeKb = (token: string) => new InlineKeyboard().text(t().btnClose, `scrclose:${token}`)
// live timestamp in the caption — so it's visibly "alive" even when the pane content is static
const screenCap = (pane: string, note?: string) =>
  `🖥 <code>${escHtml(pane)}</code> · ${note ?? new Date().toLocaleTimeString('ru-RU')}`
// /last message body: header (live timestamp so an unchanged pane still edits cleanly) + digest
const digestMsg = (pane: string, digest: string, note?: string) =>
  `📄 <code>${escHtml(pane)}</code> · ${note ?? new Date().toLocaleTimeString('ru-RU')}\n<pre>${escHtml(digest || '—')}</pre>`

function closeLiveScreen(token: string): LiveScreen | undefined {
  const v = liveScreens.get(token)
  if (v) {
    if (v.timer) clearInterval(v.timer)
    liveScreens.delete(token)
  }
  return v
}

// One live view per pane: a new /screen or /last closes+deletes any prior view of the same pane.
// Several views on one pane meant N refresh loops racing — glitchy. Called before starting a new view.
// Живой экран ровно один на всего бота: у throttler'а на группу секунда между вызовами и
// резерв 20/мин, общий с ответами агентов, — второй дайджест на пятисекундном такте забивал
// его вдвоём с первым, и ответы вставали в очередь на минуты. Новый /last гасит прежние.
async function closeAllLiveScreens(): Promise<void> {
  for (const [token, v] of [...liveScreens]) {
    closeLiveScreen(token)
    await bot.api.deleteMessage(v.chatId, v.msgId).catch(() => {})
  }
}

// auto-stop refreshing but KEEP the entry + message + Close button (so it can still be dismissed)
function stopRefreshing(token: string): void {
  const v = liveScreens.get(token)
  if (!v?.timer) {
    return
  }
  clearInterval(v.timer)
  v.timer = undefined
  if (v.kind === 'text') {
    void bot.api
      .editMessageText(v.chatId, v.msgId, digestMsg(v.pane, paneDigest(v.lastText), t().updateStopped), { parse_mode: 'HTML', reply_markup: closeKb(token) })
      .catch(() => {})
  } else {
    void bot.api
      .editMessageCaption(v.chatId, v.msgId, { caption: screenCap(v.pane, t().updateStopped), parse_mode: 'HTML', reply_markup: closeKb(token) })
      .catch(() => {})
  }
}

async function refreshLiveScreen(token: string): Promise<void> {
  const v = liveScreens.get(token)
  if (!v) {
    return
  }
  const text = await capturePane(v.pane).catch(() => '')
  if (v.kind === 'text') {
    // Не «всегда re-edit»: у Telegram ~20 сообщений в минуту НА ГРУППУ, и этот бюджет общий с
    // ответами агентов. Тикающая метка времени делала каждый тик новым edit'ом — два открытых
    // дайджеста забивали лимит целиком, throttler ставил настоящие ответы в очередь на минуты,
    // стаб ловил таймаут RPC и слал дубль. Пейн не изменился — молчим.
    if (text === v.lastText) {
      return
    }
    v.lastText = text
    await bot.api
      .editMessageText(v.chatId, v.msgId, digestMsg(v.pane, paneDigest(text)), { parse_mode: 'HTML', reply_markup: closeKb(token) })
      .catch(() => {})
    return
  }
  if (text === v.lastText) {
    // pane unchanged — just tick the caption (cheap, no re-upload), so it's visibly live
    await bot.api
      .editMessageCaption(v.chatId, v.msgId, { caption: screenCap(v.pane), parse_mode: 'HTML', reply_markup: closeKb(token) })
      .catch(() => {})
    return
  }
  v.lastText = text
  const png = await renderScreenImage(v.pane).catch(() => undefined)
  if (!png) {
    return
  }
  // editMessageMedia drops the inline keyboard unless it's re-sent — keep the Close button
  await bot.api
    .editMessageMedia(
      v.chatId,
      v.msgId,
      { type: 'photo', media: new InputFile(png, 'screen.jpg'), caption: screenCap(v.pane), parse_mode: 'HTML' },
      { reply_markup: closeKb(token) },
    )
    .catch(() => {})
}

async function startLiveScreen(chatId: string, threadId: number | undefined, pane: string, kind: 'png' | 'text' = 'png'): Promise<void> {
  await closeAllLiveScreens() // ровно один живой экран на бота — новый гасит прежний
  const token = String(++screenSeq)
  const kb = closeKb(token)
  const threadOpt = inTopic(threadId)

  if (kind === 'text') {
    const raw = await capturePane(pane).catch(() => '')
    const sent = await bot.api
      .sendMessage(chatId, digestMsg(pane, paneDigest(raw)), { ...threadOpt, parse_mode: 'HTML', reply_markup: kb })
      .catch(() => undefined)
    if (sent) {
      const timer = setInterval(() => void refreshLiveScreen(token), SCREEN_REFRESH_MS)
      liveScreens.set(token, { chatId, ...(threadId != null ? { threadId } : {}), msgId: sent.message_id, pane, lastText: raw, kind: 'text', timer })
      setTimeout(() => stopRefreshing(token), LAST_LIVE_MS)
    }
    return
  }

  const png = await renderScreenImage(pane).catch(() => undefined)
  if (png) {
    const sent = await bot.api
      .sendPhoto(chatId, new InputFile(png, 'screen.jpg'), { ...threadOpt, caption: screenCap(pane), parse_mode: 'HTML', reply_markup: kb })
      .catch(() => undefined)
    if (sent) {
      const lastText = await capturePane(pane).catch(() => '')
      const timer = setInterval(() => void refreshLiveScreen(token), SCREEN_REFRESH_MS)
      liveScreens.set(token, { chatId, ...(threadId != null ? { threadId } : {}), msgId: sent.message_id, pane, lastText, kind: 'png', timer })
      setTimeout(() => stopRefreshing(token), SCREEN_LIVE_MS) // stop refreshing; Close still works
      return
    }
  }
  // render / photo failed → fall back to the live text view (same as /last)
  await startLiveScreen(chatId, threadId, pane, 'text')
}

// Стаб подключился ≠ пейн готов принять ввод: на старте висит модалка (доверие к папке,
// dev-каналы), а после её ack поле ввода дорисовывается ещё ~секунду. Сообщение, посланное
// в эту щель, съедает модалка или молча теряет неготовый CLI — так пропадало ровно первое
// сообщение при пробуждении. Ждём отрисованного приглашения и даём CLI дозапуститься.
const PANE_SETTLE_MS = 1500
// Сколько ждём, пока сессия дорисуется и начнёт принимать ввод. Один срок на ВСЕ пути
// доставки: печать в пейн раньше готовности молча теряется, а «сколько ждать» — свойство
// поднимающегося Claude Code, а не конкретного вызова.
const PANE_READY_MS = 60_000
async function waitPaneReady(pane: string | undefined, ms: number, adapter = agentAdapter('claude')): Promise<boolean> {
  if (!pane) {
    return true
  }
  for (let waited = 0; ; waited += 500) {
    if (adapter.paneReady(await capturePane(pane).catch(() => ''))) {
      await new Promise(r => setTimeout(r, PANE_SETTLE_MS))
      return true
    }
    if (waited >= ms) {
      return false
    }
    await new Promise(r => setTimeout(r, 500))
  }
}

// Kill the binding's live sessions before switching to another conversation (--resume forks otherwise).
async function stopLiveSessions(key: string, binding: BindingEntry): Promise<boolean> {
  const live = connsForBinding(key, binding.dir)
  if (live.length === 0) {
    return true
  }
  expectedDisconnect.add(key)
  setTimeout(() => expectedDisconnect.delete(key), 90_000)
  for (const conn of live) {
    const s = router.get(conn)
    if (s?.pane && s.pid && !(await stopSession(s.pane, s.pid, log).catch(() => false))) {
      return false
    }
  }
  return true
}

// tmux+launch for a binding — shared by /resume,/new and auto-topic creation
const spawningBindings = new Set<string>()
const SPAWN_GUARD_MS = 30_000
async function spawnSession(
  key: string,
  binding: BindingEntry,
  mode: LaunchMode,
  say: (html: string) => void,
): Promise<void> {
  if (spawningBindings.has(key)) {
    log(`spawn skipped: already starting ${key}`)
    say(t().spawnInProgress)
    return
  }
  spawningBindings.add(key)
  hintedKeys.delete(key) // новая сессия — напомним ей про reply-тул ещё раз
  let launchIssued = false
  try {
  // bindings.json is hand-editable/hot-reloaded. Never let a stale or mistyped
  // directory turn into a tmux session rooted somewhere else (tmux otherwise
  // creates a bare shell and the topic looks deceptively alive).
  if (!statSync(binding.dir, { throwIfNoEntry: false })?.isDirectory()) {
    const err = `binding directory does not exist: ${binding.dir}`
    log(`spawn refused: ${err} (${key})`)
    say(t().bindingDirectoryMissing(codePath(binding.dir)))
    return
  }
  const name = sessionName(key, binding.dir)
  // форк тоже получает свой session id — его надо выучить, иначе биндинг ветки указывает
  // на оригинал и следующий подъём поднимет (и снова форкнёт) не ту сессию
  // Разговор мог исчезнуть с диска — чистка Claude Code по возрасту (cleanupPeriodDays)
  // удаляет .jsonl, а id остаётся в биндинге. `--resume <мёртвый id>` не запускается, а
  // мгновенно выходит с "No conversation found", и хаб зацикливается: поднял → «сессия
  // оборвалась» → на следующее сообщение поднял тем же id. Резюмим только живое.
  const adapter = adapterForBinding(binding)
  const resumeId = binding.sessionId && adapter.sessionMtimes(binding.dir).has(binding.sessionId)
    ? binding.sessionId
    : undefined
  const lostConversation = mode === 'resume' && !!binding.sessionId && !resumeId
  // Не подменяем на --continue: у общей папки он подхватит разговор соседнего топика.
  const launchMode: LaunchMode = lostConversation ? 'new' : mode
  const fresh = launchMode !== 'resume' || !resumeId
  // A /new must never survive a hub restart as the previous conversation. Claude learns a fresh
  // id from its launch scan; Codex learns it once the first tagged Telegram input appears.
  if (fresh && binding.sessionId) {
    const reg = loadBindings()
    if (reg[key]?.sessionId === binding.sessionId) {
      delete reg[key].sessionId
      saveBindings(reg)
      binding = reg[key]!
    }
  }
  const before = fresh ? adapter.sessionMtimes(binding.dir) : new Map<string, number>()
  if (fresh && adapter.capabilities.captureSessionIdAtLaunch) armLaunchCapture(key, before)
  try {
    const created = await ensureTmuxSession(name, binding.dir)
    if (!created) {
      const command = await paneCurrentCommand(`=${name}:`).catch(() => '')
      if (adapter.isPaneCommand(command)) {
        log(`spawn refused: ${key} has an unconnected ${adapter.kind} in ${name}`)
        say(t().tmuxForeignAgent(escHtml(command || adapter.displayName)))
        return
      }
    }
    const launch = adapter.buildLaunch(binding.cmdline, launchMode, resumeId)
    if (lostConversation) {
      log(`spawn: conversation ${binding.sessionId} gone from disk — starting fresh for ${key}`)
      say(t().conversationGone)
    }
    say(
      created
        ? t().tmuxCreated(escHtml(name), codePath(binding.dir))
        : t().tmuxExists(escHtml(name)),
    )
    const envPrefix = adapter.launchEnvPrefix([key])
    await typeLine(`=${name}:`, `cd ${shellQuote([binding.dir])} && ${envPrefix} ${memoryCapPrefix()}${launch}`)
    launchIssued = true
    // A broken launch must not wedge future retries forever. Successful launches
    // clear this sooner, from the stub's subscribe handshake above.
    setTimeout(() => spawningBindings.delete(key), SPAWN_GUARD_MS)
    // mode 'new' covers two different things: an explicit /new over an EXISTING conversation
    // (genuinely "from scratch"), and the very first launch of a binding that never had one — calling
    // that "from scratch" reads as if something was discarded, when nothing existed yet.
    const startedLabel = launchMode === 'resume'
      ? t().modeResume
      : launchMode === 'fork'
        ? t().modeFork
        : binding.sessionId && !lostConversation
          ? t().modeRestart
          : t().modeNew
    say(`${startedLabel}\n\n<code>${escHtml(launch)}</code>`)
    if (fresh && adapter.capabilities.captureSessionIdAtLaunch) {
      void captureNewAdapterSessionId(adapter, binding.dir, before, 60_000).then(id => {
        if (!id) {
          disarmLaunchCapture(key)
          return
        }
        const reg = loadBindings()
        if (reg[key] && !sessionOwner(reg, reg[key].dir, id, key)) {
          reg[key].sessionId = id
          saveBindings(reg)
          log(`learned sessionId for ${key}: ${id}`)
        } else if (reg[key]) {
          log(`learned sessionId rejected for ${key}: ${id} is owned by another binding`)
        }
        disarmLaunchCapture(key)
      })
    }
    } catch (e) {
      say(t().spawnFailed(mode, escHtml(String(e))))
    }
  } finally {
    if (!launchIssued) {
      spawningBindings.delete(key)
    }
  }
}

// On hub start, bring back sessions whose tmux is gone (host reboot: the whole tmux server
// died with it). A plain hub restart leaves tmux alive — hasTmuxSession skips those, their
// stubs reconnect on their own. Staggered so a reboot doesn't launch every Claude at once.
let revivedOnce = false
async function reviveBoundSessions(): Promise<void> {
  if (revivedOnce) {
    return // onStart also fires on polling reconnects — revive is a boot-only pass
  }
  revivedOnce = true
  for (const [key, binding] of Object.entries(loadBindings())) {
    if (binding.unloaded) {
      idleUnloaded.add(key) // it was asleep before the reboot — leave it so; an inbound wakes it
      continue
    }
    if (await hasTmuxSession(sessionName(key, binding.dir))) {
      continue
    }
    log(`boot-revive: ${key} → ${binding.dir}`)
    const t = keyToTarget(key)
    // Telegram sends no update for a deleted forum topic.  After a host reboot
    // there is no live session to make the usual reactive `typing`/reply call,
    // so probe the thread before reviving it.  Without this, a deleted topic
    // becomes an invisible zombie binding and tmux session on every boot.
    try {
      await bot.api.sendChatAction(t.chat_id, 'typing', inTopic(t.thread_id))
    } catch (err) {
      if (t.thread_id != null && isThreadGoneError(err)) {
        await onTopicGone(key)
      } else {
        log(`boot-revive probe failed: ${key} ${err}`)
      }
      continue
    }
    const say = (html: string) =>
      void bot.api
        .sendMessage(t.chat_id, html, { ...inTopic(t.thread_id), parse_mode: 'HTML' })
        .catch(err => {
          // `sendChatAction` is accepted even for a deleted forum topic on
          // Telegram, whereas the first real message reliably reports
          // `message thread not found`.  Do not swallow that signal during
          // boot revive: tear down the freshly-created zombie immediately.
          if (t.thread_id != null && isThreadGoneError(err)) {
            void onTopicGone(key)
          } else {
            log(`boot-revive notify failed: ${key} ${err}`)
          }
        })
    await spawnSession(key, binding, binding.sessionId ? 'resume' : 'new', say)
    await new Promise(r => setTimeout(r, 3000))
  }
}

// Tear down a binding fully: remove it, kill its tmux, clean its worktree (hook if this
// binding was hook-created, else a plain `git worktree remove` when the dir is a linked
// worktree). Shared by /unbind and topic-deletion cleanup. Returns an HTML summary plus
// failed=true, если папку/стенд убрать не вышло — /delete по нему решает, сносить ли топик.
async function teardownBinding(key: string, binding: BindingEntry): Promise<{ note: string; failed: boolean }> {
  const reg = loadBindings()
  delete reg[key]
  saveBindings(reg)
  // The report goes to General (the topic is already gone) — so it must name what was removed itself:
  // the topic (id + name, if known), the folder and the conversation id, else it's unreadable in the shared feed.
  const { chat_id: chatId, thread_id: tid } = keyToTarget(key)
  const topic = tid != null ? topicTitle(chatId, tid) : undefined
  const L = t()
  let note =
    L.unbound(tid != null ? L.unboundTopicPart(tid) : '') +
    `${topic ? ` «${escHtml(topic)}»` : ''}\n📁 ${codePath(binding.dir)}` +
    `${binding.sessionId ? L.unboundSessionPart(escHtml(binding.sessionId)) : ''}`
  // The hub created this tmux session (spawnSession) — it owns tearing it down, any mode.
  const name = sessionName(key, binding.dir)
  if (await hasTmuxSession(name)) {
    await killTmuxSession(name)
    note += L.tmuxClosed(escHtml(name))
  }
  // Папку сносим, только если её больше никто не держит: /fork наследует dir родителя, и
  // `git worktree remove --force` по своему топику стёр бы живому соседу незакоммиченные правки.
  const alsoBound = keysForDir(reg, binding.dir)
  if (alsoBound.length) {
    const tids = alsoBound.map(k => {
      const t2 = keyToTarget(k).thread_id
      return t2 != null ? `<code>#${t2}</code>` : `<code>${escHtml(k)}</code>`
    })
    return { note: note + L.dirStillInUse(tids.join(', ')), failed: false }
  }
  const groupCfg = loadTrustedGroups()[keyToTarget(key).chat_id]
  // same source as on creation: the project's `.tmux-channels.json` wins over the group hook
  const hook = groupCfg?.dir ? worktreeHook(groupCfg.dir, groupCfg.hook) : groupCfg?.hook
  // Bindings written before hookBranch was recorded correctly have none — fall back to the FOLDER
  // name so their teardown still runs the hook (which is what folds claude-mem memory, drops the
  // per-branch DB, frees the slot). Plain `git worktree remove` would silently skip all of it.
  // Именно папка, а не текущая ветка: при флоу «одна итерация — один PR» воркри к моменту сноса
  // стоит на последней ветке цепочки, хук такой ветки не знает и отказывается сносить.
  // Gated on isLinkedWorktree: a folder binding points at the MAIN repo, and running the removal hook
  // there would tear down the real checkout.
  const hookBranch =
    binding.hookBranch ??
    (hook?.delete && (await isLinkedWorktree(binding.dir)) ? basename(binding.dir) : undefined)
  let failed = false
  if (hookBranch && hook?.delete && groupCfg?.dir) {
    try {
      await runHookDelete(hook, hookBranch, groupCfg.dir)
      note += L.cleanupHookOk(escHtml(hookBranch))
    } catch (e) {
      note += L.cleanupHookFail(escHtml(String(e)))
      failed = true
    }
  } else {
    try {
      if (await removePlainWorktree(binding.dir)) {
        note += L.worktreeRemoved
      }
    } catch (e) {
      note += L.worktreeRemoveFail(escHtml(String(e)))
      failed = true
    }
  }
  return { note, failed }
}

// Telegram has NO "forum topic deleted" update (unlike created/closed/reopened) — bots
// aren't told. So a deleted topic is detected reactively: the next send to it fails with
// "message thread not found". That error triggers this teardown; notifications go to
// General (no thread_id), since the topic itself is gone.
function isThreadGoneError(err: unknown): boolean {
  const d = err instanceof GrammyError ? err.description : String((err as { message?: string })?.message ?? err)
  return /message thread not found|thread not found|TOPIC_DELETED/i.test(d)
}
const tearingDown = new Set<string>()
async function onTopicGone(key: string): Promise<void> {
  if (tearingDown.has(key) || !loadBindings()[key]) {
    return
  }
  tearingDown.add(key)
  try {
    const binding = loadBindings()[key]
    if (!binding) {
      return
    }
    log(`topic gone: ${key} — auto-unbind + cleanup`)
    const { note } = await teardownBinding(key, binding)
    void bot.api
      .sendMessage(keyToTarget(key).chat_id, t().topicDeletedCleanup(note), { parse_mode: 'HTML' })
      .catch(() => {})
  } finally {
    tearingDown.delete(key)
  }
}

// new forum topic in a trusted group → auto-bind + auto-start, no /bind needed
type PendingTopic = { cfg: TrustedGroupConfig; mode: TrustedGroupMode; topicName: string; say: (html: string) => void; base?: string; agent?: AgentKind }
const pendingTopics = new Map<string, PendingTopic>() // waiting for a "which folder?" answer
// mode picker sent, waiting for a button tap — before dir resolution starts
type PendingModeChoice = { cfg: TrustedGroupConfig; topicName: string; say: (html: string) => void; agent?: AgentKind }
const pendingModeChoice = new Map<string, PendingModeChoice>()

// Messages typed while a topic is still being set up (mode not yet picked, session not yet
// up). Held here and delivered by flushQueued once the session connects, so the first task
// isn't lost. Keyed by binding key.
const queuedMessages = new Map<string, Inbound[]>()
// Режим уже выбран, биндинга ещё нет (worktree создаётся десятки секунд). Без этого флага
// сообщение из этого окна уходит в late-binding, поднимает ВТОРОЙ пикер и запирает очередь:
// flushQueued вернёт всё обратно в неё, потому что pendingModeChoice снова взведён.
const settingUp = new Set<string>()
// A trusted-topic launch is asynchronous (worktree/hook resolution and then tmux).  A manual
// /bind is an explicit override, not a second competing setup request. Track the auto-owned
// record separately so a late manual bind can also tear down an auto tmux that already started.
const autoTopicBindings = new Set<string>()
const cancelledAutoTopics = new Set<string>()
function sayFor(chatId: string, threadId: number) {
  return (html: string) => void bot.api.sendMessage(chatId, html, { ...inTopic(threadId), parse_mode: 'HTML' }).catch(() => {})
}
function armMode(key: string, value: PendingModeChoice, chatId: string, threadId: number): void {
  pendingModeChoice.set(key, value)
  stateRepo.setPendingMode(key, { cfg: value.cfg, topicName: value.topicName, chatId, threadId })
}
function disarmMode(key: string): void { pendingModeChoice.delete(key); stateRepo.delPendingMode(key) }
function enqueueForTopic(key: string, inbound: Inbound): void {
  const q = queuedMessages.get(key) ?? []
  q.push(inbound)
  queuedMessages.set(key, q)
  stateRepo.setQueued(key, q.map(persistInbound))
  const msgId = inbound.ctx.message?.message_id
  if (msgId != null) {
    // 👌 = "held, will deliver once the session is up" (⏳ isn't in Telegram's reaction set)
    void bot.api.setMessageReaction(String(inbound.ctx.chat!.id), msgId, [{ type: 'emoji', emoji: '👌' }]).catch(() => {})
  }
}
async function flushQueued(key: string): Promise<void> {
  const q = queuedMessages.get(key)
  queuedMessages.delete(key)
  stateRepo.delQueued(key)
  if (!q?.length) {
    return
  }
  const conns = await waitForBinding(key, 30_000)
  if (!conns.length) {
    const c = q[0]?.ctx
    if (c?.chat) {
      const tid = c.message?.message_thread_id
      void bot.api
        .sendMessage(String(c.chat.id), t().sessionNotUpInTime, {
          ...inTopic(tid),
          parse_mode: 'HTML',
        })
        .catch(() => {})
    }
    return
  }
  for (const inb of q) {
    await handleInbound(inb) // binding now exists → normal delivery path
  }
}

// mode is known — start the session. Branch/slug is always the topic name (no "type a
// branch" window: it only ate the user's first message). Dir from group config, or ask.
function beginTopicSession(
  key: string,
  cfg: TrustedGroupConfig,
  mode: TrustedGroupMode,
  topicName: string,
  say: (html: string) => void,
  base?: string,
  agent?: AgentKind,
): void {
  if (!cfg.dir) {
    say(t().sendFolderPromptBind(codePath(PROJECTS_DIR)))
    pendingTopics.set(key, { cfg, mode, topicName, say, ...(base ? { base } : {}), ...(agent ? { agent } : {}) })
    return
  }
  void runAutoTopic(key, cfg, cfg.dir, mode, slugFromTopicName(topicName), say, base, agent)
}

async function runAutoTopic(
  key: string,
  cfg: TrustedGroupConfig,
  dir: string,
  mode: TrustedGroupMode,
  branch: string,
  say: (html: string) => void,
  base?: string,
  agent?: AgentKind,
): Promise<void> {
  const usedAgent = agent ?? cfg.agent // выбор в пикере важнее группового умолчания
  const branchNote = mode === 'folder' ? '' : t().branchNote(escHtml(branch))
  say(t().preparingSession(escHtml(mode), branchNote))
  settingUp.add(key)
  try {
    // hook comes back resolved (project config wins over the group's) — flag the binding from THAT,
    // not from `cfg.hook`, so teardown runs the same hook creation used.
    const { dir: resolvedDir, hook: usedHook, branch: usedBranch } = await resolveModeDir(mode, dir, cfg.hook, branch, base ?? worktreeBases(dir)[0])
    if (usedBranch !== branch) {
      // Имя было занято прошлым топиком — говорим вслух, иначе человек ищет ветку под старым
      // именем и правит не то (а именно так и уехал PR на месячную базу).
      log(`auto-topic: branch "${branch}" занята → "${usedBranch}"`)
      say(t().branchRenamed(escHtml(branch), escHtml(usedBranch)))
    }
    // A manual /bind may have won while resolving a worktree/hook. Do not write the
    // stale auto-topic defaults over that deliberate adapter/path choice, and do not
    // launch a second agent into the topic behind the user's back.
    if (cancelledAutoTopics.has(key) || loadBindings()[key]) {
      log(`auto-topic cancelled: ${key} was manually bound while resolving its directory`)
      return
    }
    const reg = loadBindings()
    reg[key] = {
      dir: resolvedDir,
      ...(usedAgent ? { agent: usedAgent } : {}),
      // cmdline из конфига группы — только если он про ТОГО ЖЕ агента. Адаптер чужой argv
      // и сам отбросит, но хранить в биндинге запуск claude под codex — врать состоянием.
      ...(cfg.cmdline && agentAdapter(usedAgent).isProcessArgv(cfg.cmdline) ? { cmdline: cfg.cmdline } : {}),
      ...(usedHook ? { hookBranch: usedBranch } : {}), // именно ту, что создали, — её же сносить
    }
    saveBindings(reg)
    autoTopicBindings.add(key)
    if (cancelledAutoTopics.has(key)) {
      log(`auto-topic cancelled: ${key} was manually bound before launch`)
      return
    }
    await spawnSession(key, reg[key], 'new', say)
  } catch (e) {
    say(t().sessionSpawnFail(escHtml(String(e))))
  } finally {
    autoTopicBindings.delete(key)
    cancelledAutoTopics.delete(key)
    settingUp.delete(key) // снять ДО flush — иначе очередь уйдёт сама в себя
    // always drain the hold queue — deliver on success, or tell the user + clear it on failure
    await flushQueued(key)
  }
}

const ownDirLabel = () => t().ownDirLabel

/** Харнессы, между которыми переключает кнопка. Пусто/один — переключателя нет. */
function harnessChoices(cfg: TrustedGroupConfig): AgentKind[] {
  return (cfg.agents ?? []).length > 1 ? cfg.agents! : []
}

function modeKeyboard(key: string, cfg: TrustedGroupConfig, agent?: AgentKind): InlineKeyboard {
  const kb = new InlineKeyboard()
  const bases = cfg.dir ? worktreeBases(cfg.dir) : []
  // Переключатель, а не отдельная кнопка на каждую пару «режим × харнесс»: режимов уже три,
  // и перемножать их значит утопить пикер в рядах.
  const choices = harnessChoices(cfg)
  if (choices.length) {
    const current = agent ?? cfg.agent ?? choices[0]!
    kb.text(t().harnessToggle(agentAdapter(current).displayName), `topicharness:${key}`).row()
  }
  for (const m of cfg.modes) {
    // Несколько баз — размножаем саму кнопку «worktree», отдельного пикера не заводим:
    // выбор режима и выбор базы — один вопрос, один тап.
    if (m === 'worktree' && bases.length > 1) {
      bases.forEach((b, i) => kb.text(t().modeWorktreeFrom(b), `topicmode:${key}:worktree:${i}`).row())
      continue
    }
    kb.text(modeLabel(m), `topicmode:${key}:${m}`).row()
  }
  return kb.text(ownDirLabel(), `topicdir:${key}`).row()
}

const modeExplain = (m: TrustedGroupMode): string => (m === 'worktree' ? t().modeIntroWorktree : t().modeIntroFolder)

// button labels alone can't fit a path — spell out what each mode actually does here
function modePromptText(cfg: TrustedGroupConfig, intro: string): string {
  const L = t()
  const base = cfg.dir ? L.modeBaseSet(codePath(cfg.dir)) : L.modeBaseUnset
  const modeLines = cfg.modes.map(m => modeExplain(m))
  return [intro, '', base, '', ...modeLines, L.ownDirSuffix(ownDirLabel())].join('\n')
}

// forum_topic_created can be missed (hub down, race) — a message in an unbound topic of a
// trusted group sets the topic up the same way. The real title isn't in a message update,
// so callers pass a generic slug (topic-<id>) as topicName; the triggering message is
// queued by the caller and delivered once the session is up.
// Имя топика-ветки: имя исходного топика с суффиксом (Telegram режет на 128) — так ветка
// стоит рядом с родителем в списке; переименовать её юзер может сам.
function forkTopicName(chatId: string, threadId: number, dir: string): string {
  const base = topicTitle(chatId, threadId) || basename(dir)
  return `${base} (fork)`.slice(0, 128)
}

async function handleLateTopic(
  key: string,
  chatId: string,
  threadId: number,
  cfg: TrustedGroupConfig,
  topicName: string,
  say: (html: string) => void,
): Promise<void> {
  armMode(key, { cfg, topicName, say }, chatId, threadId)
  void bot.api
    .sendMessage(chatId, modePromptText(cfg, t().newTopicPrompt), {
      message_thread_id: threadId,
      parse_mode: 'HTML',
      reply_markup: modeKeyboard(key, cfg),
    })
    .catch(() => {})
}

type Inbound = {
  ctx: Context
  text: string
  downloadImage?: () => Promise<string | undefined>
  attachment?: AttachmentMeta
}

function persistInbound(inbound: Inbound): PersistedInbound {
  const msg = inbound.ctx.message
  return {
    text: inbound.text, chatId: String(inbound.ctx.chat!.id), threadId: msg?.message_thread_id,
    senderId: String(inbound.ctx.from!.id), username: inbound.ctx.from?.username,
    msgId: msg?.message_id, at: Date.now(),
  }
}

function reviveInbound(value: PersistedInbound): Inbound {
  // Queued input only needs the stable Telegram identity/message fields consumed by
  // handleInbound.  Rebuild those rather than persisting grammY's live Context object.
  const ctx = {
    from: { id: Number(value.senderId), username: value.username },
    chat: { id: Number(value.chatId), type: 'supergroup' },
    message: value.msgId == null ? undefined : { message_id: value.msgId, message_thread_id: value.threadId, date: Math.floor(value.at / 1000) },
  } as unknown as Context
  return { ctx, text: value.text }
}

for (const [key, values] of stateRepo.queuedEntries()) queuedMessages.set(key, values.map(reviveInbound))
for (const [key, value] of stateRepo.pendingModeEntries()) {
  pendingModeChoice.set(key, { cfg: value.cfg, topicName: value.topicName, say: sayFor(value.chatId, value.threadId) })
}

async function handleInbound(inbound: Inbound): Promise<void> {
  const { ctx, text, downloadImage, attachment } = inbound
  const from = ctx.from
  const chat = ctx.chat
  if (!from || !chat) {
    return
  }
  const senderId = String(from.id)
  const chat_id = String(chat.id)
  const msgId = ctx.message?.message_id
  const replyTo = ctx.message?.reply_to_message
  // MTProto can omit `message_thread_id` on a reply to the forum-topic's
  // creation service message.  That reply still belongs to this topic; use the
  // root message id only in that unambiguous service-message shape.
  const threadId = ctx.message?.message_thread_id
    ?? replyTo?.message_thread_id
    ?? (replyTo?.forum_topic_created ? replyTo.message_id : undefined)
  const key = messageKey({ chatType: chat.type, chatId: chat_id, threadId })
  const seenAt = new Date().toISOString()
  recordChat(chat_id, chat.type, chatLabel(chat), seenAt)
  if (threadId != null) {
    // A plain message carries no topic name, but a message that roots/replies to the topic
    // sometimes brings the creation service message along — grab the name from it for free.
    const rootName = replyTo?.forum_topic_created?.name
    recordTopic(chat_id, threadId, rootName || undefined, seenAt)
  }
  const say = (html: string) =>
    void bot.api
      .sendMessage(chat_id, html, { ...inTopic(threadId), parse_mode: 'HTML' })
      .catch(() => {})

  // explicit commands always win — never swallowed by an auto-topic prompt waiting for text
  const ops = parseOpsCommand(text)
  if (ops && (!ops.bot || ops.bot.toLowerCase() === botUsername.toLowerCase())) {
    // `/queue` живёт здесь, а не в handleOps: ему нужен сам inbound (картинки, вложения,
    // message_id), чтобы позже проиграть доставку обычным путём. Текст команды при этом
    // снимается — иначе на выдаче из очереди сообщение снова опознается как команда.
    if (ops.cmd === 'queue') {
      const body = ops.arg?.trim()
      if (!body) {
        say(t().queueUsage)
        return
      }
      const held: Inbound = { ...inbound, text: body }
      const binding = loadBindings()[key]
      // Держать имеет смысл, только пока сессия занята ходом. Свободной отдаём сразу:
      // иначе сообщение ждало бы конца хода, который никто не начинал.
      if (binding && keyIsWorking(key, binding.dir)) {
        log(`queue: ${key} — держу до конца хода`)
        enqueueForTopic(key, held) // 👌 = принято, доставлю после хода
        return
      }
      await handleInbound(held)
      return
    }
    // A harmless ops command (notably /status while the mode keyboard is on screen)
    // must not consume topic setup. Only a command that explicitly replaces or
    // removes the binding invalidates the still-visible mode callback.
    if (ops.cmd === 'bind' || ops.cmd === 'unbind' || ops.cmd === 'delete') {
      pendingTopics.delete(key)
      disarmMode(key)
    }
    await handleOps({ cmd: ops.cmd, arg: ops.arg, key, chat_id, threadId, senderId, ...(msgId != null ? { msgId } : {}) })
    return
  }

  // this topic asked "which folder?" and is waiting for the answer. The dir picks the
  // session cwd (→ Claude runs there with bypassPermissions), so only an admin may supply
  // it — a non-admin group member must not be able to point a session at an arbitrary dir.
  const pendingTopic = pendingTopics.get(key)
  if (pendingTopic) {
    if (!isAdmin(senderId)) {
      log(`drop (not admin) pending-topic answer: key=${key} from=${senderId}`)
      return
    }
    let dir: string
    try {
      dir = resolveProjectDir(text.trim(), PROJECTS_DIR)
    } catch (e) {
      pendingTopic.say(t().notAFolder(escHtml(e instanceof Error ? e.message : String(e))))
      return
    }
    pendingTopics.delete(key)
    await runAutoTopic(key, pendingTopic.cfg, dir, pendingTopic.mode, slugFromTopicName(pendingTopic.topicName), pendingTopic.say, pendingTopic.base, pendingTopic.agent)
    return
  }

  // custom-answer text for a picker: THIS topic's pane is waiting for free text. Match
  // the exact (chat,thread) and check allow for this specific binding — otherwise a user
  // allowed in topic A could answer topic B's AskUserQuestion (and with several pickers
  // pending, the first in Map order would be picked).
  for (const [pane, aw] of awaitingCustom) {
    if (aw.chatId !== chat_id || aw.threadId !== threadId) {
      continue
    }
    if (Date.now() - aw.at > CUSTOM_TIMEOUT_MS) {
      awaitingCustom.delete(pane)
      continue
    }
    if (isAdmin(senderId) || bindingAllowsKey(key, senderId)) {
      const ap = activePickers.get(pane)
      if (aw.multi) {
        // Do not press Enter: it toggles the custom checkbox back off. The multi
        // picker marks the inline value selected as it is typed; Submit remains a
        // separate Telegram button for the complete selection.
        await typeText(pane, text)
        // A multi answer is not complete until the user presses Submit. Keep its
        // Telegram keyboard armed so subsequent option changes and Submit still work.
        if (ap) {
          const screen = await capturePane(pane).catch(() => '')
          await bot.api.editMessageText(
            ap.chatId, ap.msgId,
            `✍️ <b>${escHtml(text)}</b>\n\n${t().pkCustomSavedSubmit}`,
            { ...inTopic(ap.threadId), parse_mode: 'HTML', reply_markup: kbFrom(ap.picker, ap.token, checkedIndexes(screen)) },
          ).catch(() => {})
        }
      } else {
        await typeLine(pane, text)
        typing(chat_id, threadId) // agent now processes the custom answer
        if (ap) {
          await resolvePickerMessage(ap, `✅ <b>${escHtml(text)}</b>`)
          disarmPicker(pane)
        }
      }
      awaitingCustom.delete(pane)
      return
    }
  }

  // mode picker sent, waiting for a button tap — hold this message and deliver it once the
  // session is up (flushQueued), so the first task typed before tapping isn't lost.
  if (pendingModeChoice.has(key) || settingUp.has(key)) {
    enqueueForTopic(key, inbound)
    return
  }

  const binding = loadBindings()[key]
  if (!binding) {
    if (threadId != null && isAdmin(senderId)) {
      const trustedCfg = loadTrustedGroups()[chat_id]
      if (trustedCfg && !trustedCfg.exclude?.topicIds?.includes(threadId)) {
        // forum_topic_created was missed (hub was down / raced) — set the topic up now,
        // triggered by this message. Queue the message so it reaches the session once it's
        // up instead of being consumed. Topic name is unknown here → generic slug.
        log(`late-binding: forum_topic_created missed for key=${key}, using message as trigger`)
        enqueueForTopic(key, inbound)
        await handleLateTopic(key, chat_id, threadId, trustedCfg, `topic-${threadId}`, say)
        return
      }
    }
    if (isAdmin(senderId) && bindOffersWelcome(chat_id)) {
      log(`unbound: offering folders key=${key} from=${senderId}`)
      offerBind(key, chat_id, threadId)
      return
    }
    log(`drop (unbound): key=${key} from=${senderId} text=${text.slice(0, 60)}`)
    return
  }
  if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
    log(`drop (not allowed): key=${key} from=${senderId}`)
    return
  }
  const wasIdle = idleUnloaded.has(key) // capture BEFORE markActivity clears it
  markActivity([key]) // an inbound message is activity — resets the idle clock
  let conns = connsForBinding(key, binding.dir)
  if (conns.length === 0) {
    log(`reviving: key=${key} dir=${binding.dir} — no live session for an inbound message`)
    // Idle-unloaded sessions wake with ONE quiet line (no spawnSession chatter); a genuine
    // cold revive keeps the normal verbose say so the user sees what's happening.
    if (wasIdle) {
      void bot.api
        .sendMessage(chat_id, t().raisingSession, {
          ...inTopic(threadId), parse_mode: 'HTML', disable_notification: true,
        })
        .catch(() => {})
    }
    await spawnSession(key, binding, binding.sessionId ? 'resume' : 'new', wasIdle ? () => {} : say)
    conns = await waitForBinding(key, 30_000)
    if (conns.length === 0) {
      say(t().sessionNotConnectedInTime)
      return
    }
    // Ждать пейн и перерезолвить conn не нужно — это делает deliverMessage перед самой отправкой.
  }

  log(`deliver: ${key} → ${binding.dir} (${conns.length} session${conns.length > 1 ? 's' : ''})`)

  // A non-hub slash ("/deep-research …", "/deep_research …") → type it into the session's
  // pane so Claude Code expands it as a REAL slash command / skill. Ops commands were
  // consumed above, so anything still starting with "/" is a Claude slash command. Strip
  // the "@botname" Telegram appends in groups (Claude Code would read "@…" as a file
  // mention → Enter opens the picker instead of submitting), then map a mangled global
  // skill (/deep_research) back to its real hyphenated name. Skip when media rides along.
  if (text.trim().startsWith('/') && !attachment && !downloadImage) {
    const [head, ...rest] = text.trim().split(/\s+/)
    const name = head!.slice(1).replace(/@\w+$/, '').toLowerCase() // drop leading "/" and "@bot"
    // глобальные И проектные скиллы: /add_model → /add-model (Telegram не даёт дефис)
    const real = resolveSkillCommand(name, globalSkillMap, discoverProjectSkills(binding.dir, binding.agent))
    const agent = binding.agent ?? 'claude'
    const cmd = skillInvocation(agent, real, rest)
    const ok = await injectSkillToPanes(conns, cmd, key, binding.dir, chat_id, threadId, msgId, agent)
    if (!ok) {
      void say(t().notInTmuxSlash)
    }
    return
  }

  // 👀 = "received" ack: the reply may lag if the session is busy
  if (msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👀' }])
      .catch(() => {})
  }
  // thread_id is required, otherwise typing goes to General instead of the topic
  typing(chat_id, threadId)
  const imagePath = downloadImage ? await downloadImage() : undefined
  const meta: Record<string, string> = {
    chat_id,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    user: from.username ?? senderId,
    user_id: senderId,
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(threadId != null ? { topic_id: String(threadId) } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment
      ? {
          attachment_kind: attachment.kind,
          attachment_file_id: attachment.file_id,
          ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
          ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        }
      : {}),
  }
  snapshotScreens(key, text, conns)
  armPending(key, { dir: binding.dir, at: Date.now() }) // armed until the agent replies or turnend forwards
  await deliverMessage(key, binding.dir, { op: 'event', kind: 'message', content: text, meta }, text)
}

// ── единственная точка отправки сообщения в сессию ──────────────────────────
// Через неё идут все ветки: живая сессия, пробуждение, очередь нового топика. Раньше каждая
// решала «адресат готов?» по-своему, и две из трёх решали неверно — сообщения пропадали молча.
// Здесь три вещи в одном месте:
//  1. пейн ждём ДО отправки: стаб подписывается раньше, чем Claude Code готов принимать (на
//     старте он ещё рисует баннер и крутит SessionStart-хуки), и событие в этот момент тонет;
//  2. conn резолвим прямо перед записью: на старте стаб подключается дважды, первый сокет
//     умирает сразу после подписки, а `send()` в закрытый сокет молчит;
//  3. сторож проверяет, что сообщение реально легло в транскрипт (src/delivery.ts) — тихая
//     потеря больше не тихая.
let nextDeliveryId = 1

// Текст, который печатается прямо в пейн (агенты без нативного входящего канала — Codex).
// Инструкция про reply здесь не для красоты: у Codex тул есть, но подсказки MCP-сервера до него
// не доходят, и он отвечает в терминал. Хаб тогда досылает ответ сам, и КАЖДАЯ реплика
// приезжает с плашкой «↩️ auto-forward» — досыл превращается из страховки в норму.
const REPLY_HINT = 'Answer via the telegram `reply` tool (chat_id/thread_id from the tag above); '
  + 'terminal output alone never reaches the user.'

// Подсказку даём ОДИН раз на сессию: агенту хватает, а печатать её в каждое сообщение —
// засорять и пейн, и его контекст. Ключ — БИНДИНГ, а не пейн: пейн приходит то как id (`%13`),
// то как цель сессии (`=name:`), и на разных путях доставки подсказка выдавалась повторно.
const hintedKeys = new Set<string>()

function fallbackInboundText(content: string, meta: Record<string, string>, key?: string): string {
  const details = Object.entries(meta).map(([k, value]) => `${k}=${JSON.stringify(value)}`).join(' ')
  if (!details) {
    return content
  }
  const first = key !== undefined && !hintedKeys.has(key)
  if (first) {
    hintedKeys.add(key)
  }
  return `[Telegram message; ${details}]\n${first ? `${REPLY_HINT}\n` : ''}${content}`
}

async function deliverMessage(key: string, dir: string, payload: HubToStub, needle: string): Promise<number> {
  const binding = loadBindings()[key]
  const adapter = adapterForBinding(binding)
  const first = connsForBinding(key, dir)[0]
  // Codex starts its stdio MCP only when it first needs a tool. Until then there is no stub
  // subscription, although its tmux pane is already a perfectly live interactive session. Do
  // not relaunch into that pane (which types a second `codex` command into the first agent).
  const subscribedPane = first ? router.get(first)?.pane : undefined
  const directPane = !subscribedPane && !adapter.capabilities.nativeInboundTransport && binding
    && await hasTmuxSession(sessionName(key, binding.dir)).catch(() => false)
    ? `=${sessionName(key, binding.dir)}:`
    : undefined
  const pane = subscribedPane ?? directPane
  const ready = await waitPaneReady(pane, PANE_READY_MS, adapter)
  if (!adapter.capabilities.nativeInboundTransport && (!pane || !ready)) {
    log(`delivery: fallback pane is not ready for key=${key}`)
    return 0
  }
  const at = Date.now()
  // id живёт на самом событии: по нему стаб отвечает, отдал он сообщение в сессию или нет
  const id = `d${process.pid}-${Date.now()}-${nextDeliveryId++}`
  // The visible message body is not an identity: two topics that share a directory can
  // send the same text at once. Put the delivery id into the exact envelope Codex records,
  // then use that unique marker for both delivery verification and rollout correlation.
  const tagged: HubToStub = payload.op === 'event' && payload.kind === 'message'
    ? { ...payload, id, meta: { ...payload.meta, delivery_id: id } }
    : payload
  const conns = connsForBinding(key, dir)
  if (adapter.capabilities.nativeInboundTransport) {
    for (const conn of conns) send(conn, tagged)
  } else if (pane && payload.op === 'event' && payload.kind === 'message') {
    // Codex has no Claude Channels notification transport. Its MCP stub still supplies reply,
    // files and session identity; inbound text is submitted through the same tmux TUI users see.
    await typeLine(pane, fallbackInboundText(payload.content, payload.meta))
  }
  if (conns.length || pane) {
    const correlationNeedle = adapter.kind === 'codex'
      ? `delivery_id=${JSON.stringify(id)}`
      : needle.trim().slice(0, 60)
    void watchDelivery(key, dir, tagged, correlationNeedle, at, id, adapter)
  }
  return conns.length || pane ? 1 : 0
}

// Боевая обвязка сторожа: реальные часы, транскрипт на диске, сокеты стаба и Telegram.
// Сама логика — в src/delivery.ts, её и покрывают сценарные тесты.
function deliveryDeps(key: string, dir: string, payload: HubToStub, id: string, adapter: AgentAdapter): DeliveryDeps {
  return {
    clock: { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) },
    awaitAck: () => adapter.capabilities.nativeInboundTransport ? awaitAck(id) : Promise.resolve('silent'),
    sawIncoming: adapter.transcriptSawIncoming,
    resend: async () => {
      if (adapter.capabilities.nativeInboundTransport) {
        for (const conn of connsForBinding(key, dir)) send(conn, payload)
        return
      }
      const conn = connsForBinding(key, dir)[0]
      const binding = loadBindings()[key]
      const pane = conn
        ? router.get(conn)?.pane
        : !adapter.capabilities.nativeInboundTransport && binding && await hasTmuxSession(sessionName(key, binding.dir)).catch(() => false)
          ? `=${sessionName(key, binding.dir)}:`
          : undefined
      if (pane && payload.op === 'event' && payload.kind === 'message') {
        await typeLine(pane, fallbackInboundText(payload.content, payload.meta, key))
      }
    },
    warn: async () => {
      const target = keyToTarget(key)
      await bot.api
        .sendMessage(target.chat_id, t().deliveryLost, {
          ...inTopic(target.thread_id), parse_mode: 'HTML',
        })
        .catch(() => {})
    },
    log,
  }
}

// Не долетело — переотправляем ОДИН раз (потеря обычно на старте сессии и не повторяется),
// и если снова тишина — говорим вслух: молчаливая потеря заметна только по «мне не ответили».
async function watchDelivery(
  key: string, dir: string, payload: HubToStub, needle: string, at: number, id: string, adapter: AgentAdapter,
): Promise<void> {
  const outcome = await watchDeliveryCore(deliveryDeps(key, dir, payload, id, adapter), key, dir, needle, at)
  if (outcome === 'lost') return
  const sessionId = adapter.sessionForIncoming(dir, at, needle)
  if (!sessionId) return
  const reg = loadBindings()
  const binding = reg[key]
  if (!binding || binding.dir !== dir) return
  const owner = sessionOwner(reg, dir, sessionId, key)
  if (owner) {
    log(`incoming-correlated sessionId rejected for ${key}: ${sessionId} is owned by ${owner}`)
    return
  }
  if (binding.sessionId !== sessionId) {
    log(`incoming-correlated sessionId for ${key}: ${binding.sessionId ?? '<none>'} → ${sessionId}`)
    binding.sessionId = sessionId
    saveBindings(reg)
  }
}

// ── debug log: pane snapshots + raw Telegram traffic, one correlated JSONL ──
// Debugging "session hung, can't reach it": what was rendered in the pane and
// what flowed through Telegram (in and out) around it, in one timeline.
// Entry types: screen | tg_in | tg_out. Last N entries kept.
// ponytail: full-file rewrite per event (~1000 entries ≈ a few MB); switch to
// append+logrotate if it ever shows up in profiles.
const SCREENLOG = join(STATE_DIR, 'screenlog.jsonl')
const SCREENLOG_MAX = 1000

// grammY's InputFile.toJSON throws by design, and JSON.stringify calls toJSON BEFORE any
// replacer — so a replacer can't save this, the values have to go before serialising. Without
// it every media send logged as "unserializable payload", blanking the one record of what
// actually went out (captions, album shape).
function stripInputFiles(v: unknown, depth = 0): unknown {
  if (v instanceof InputFile) {
    return '[InputFile]'
  }
  if (v === null || typeof v !== 'object' || depth > 6) {
    return v
  }
  if (Array.isArray(v)) {
    return v.map(x => stripInputFiles(x, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = stripInputFiles(val, depth + 1)
  }
  return out
}

function logDebugEvent(e: Record<string, unknown>): void {
  if (!DEBUG_LOG) {
    return // opt-in via TELEGRAM_DEBUG_LOG=1; off by default for the public plugin
  }
  let entry: string
  try {
    entry = JSON.stringify({ ts: new Date().toISOString(), ...(stripInputFiles(e) as object) })
  } catch (err) {
    entry = JSON.stringify({
      ts: new Date().toISOString(), type: e.type, method: e.method,
      error: `unserializable payload: ${err}`,
    })
  }
  let lines: string[] = []
  try {
    lines = readFileSync(SCREENLOG, 'utf8').split('\n').filter(Boolean)
  } catch {}
  lines.push(entry)
  try {
    writeFileSync(SCREENLOG, lines.slice(-SCREENLOG_MAX).join('\n') + '\n')
  } catch (e) {
    log(`screenlog write failed: ${e}`)
  }
}

function snapshotScreens(key: string, trigger: string, conns: Socket[]): void {
  void (async () => {
    for (const conn of conns) {
      const pane = router.get(conn)?.pane
      if (!pane) {
        continue
      }
      const screen = await capturePane(pane).catch(e => `<capture failed: ${e}>`)
      logDebugEvent({ type: 'screen', key, pane, trigger: trigger.slice(0, 120), screen })
    }
  })()
}

// bind/unbind/allow — admins only; everything else — admins and the binding's allow users
type OpsRequest = {
  cmd: OpsCommand
  arg?: string
  key: string
  chat_id: string
  threadId?: number
  senderId: string
  msgId?: number // the user's command message — /screen deletes it to keep history clean
}

async function handleOps({ cmd, arg, key, chat_id, threadId, senderId, msgId }: OpsRequest): Promise<void> {
  const L = t()
  const threadOpt = inTopic(threadId)
  const say = (html: string) =>
    bot.api.sendMessage(chat_id, html, { ...threadOpt, parse_mode: 'HTML' }).catch(() => {})
  const reg = loadBindings()
  const binding: BindingEntry | undefined = reg[key]

  // /lang — switch the UI language globally (admin), then re-register command descriptions.
  if (cmd === 'lang') {
    if (!isAdmin(senderId)) {
      return
    }
    const want = arg?.trim().toLowerCase()
    if (want !== 'en' && want !== 'ru') {
      void say(L.langUsage(getLang()))
      return
    }
    setLang(want as Lang)
    void say(t().langSwitched(want)) // t() re-reads the new lang
    void refreshCommands()
    return
  }

  // /reload — rescan plugins/skills and re-register bot commands (admin, global effect).
  if (cmd === 'reload') {
    if (!isAdmin(senderId)) {
      return
    }
    void say(L.rescanning)
    const summary = await refreshCommands()
    void say(summary)
    return
  }

  // /skills — button menu of THIS project's local skills (per-topic scope Telegram can't
  // give as native commands). Admin or an allowed user of this binding.
  if (cmd === 'skills') {
    if (!binding) {
      void say(L.noBinding)
      return
    }
    if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
      return
    }
    const skills = discoverProjectSkills(binding.dir, binding.agent)
    if (skills.length === 0) {
      void say(L.noProjectSkills(escHtml(binding.dir)))
      return
    }
    const token = String(++skillMenuSeq)
    const names = skills.map(s => s.name)
    skillMenus.set(token, { key, dir: binding.dir, names })
    void bot.api
      .sendMessage(chat_id, L.projectSkillsMenu(skills.length), {
        ...threadOpt, parse_mode: 'HTML', reply_markup: skillMenuKeyboard(token, names, 0),
      })
      .catch(() => {})
    return
  }

  if (cmd === 'pin' || cmd === 'unpin') {
    if (!isAdmin(senderId)) {
      return
    }
    if (!binding) {
      void say(L.noBinding)
      return
    }
    reg[key].pinned = cmd === 'pin'
    if (!reg[key].pinned) {
      delete reg[key].pinned
    }
    saveBindings(reg)
    if (cmd === 'pin') {
      markActivity([key]) // clear the "expired" timer so it doesn't unload right after /unpin→/pin
    }
    const on = IDLE_UNLOAD_MS > 0
    void say(
      cmd === 'pin'
        ? L.pinned(on ? '' : L.pinnedIdleOffNote)
        : L.unpinned(on ? L.unpinnedInNote(Math.round(IDLE_UNLOAD_MS / 60_000)) : L.unpinnedWhenOnNote),
    )
    return
  }

  if (cmd === 'bind' || cmd === 'unbind' || cmd === 'allow' || cmd === 'delete') {
    if (!isAdmin(senderId)) {
      void say(L.adminOnly(cmd))
      return
    }
    // /delete = teardown (unbind + tmux + worktree) AND remove the topic itself, in one go.
    // Telegram gives no topic-deleted event, so this is the clean way to delete + clean up
    // together. Reports to General, since the topic is gone by then.
    if (cmd === 'delete') {
      if (threadId == null) {
        void say(L.deleteOnlyInTopic)
        return
      }
      const { note, failed } = binding
        ? await teardownBinding(key, binding)
        : { note: L.noBindingInTopic(threadId, topicTitle(chat_id, threadId) ? escHtml(topicTitle(chat_id, threadId)!) : ''), failed: false }
      // Уборка провалилась — топик НЕ удаляем и биндинг возвращаем: иначе воркри со стендом
      // остаются жить, а жалоба уезжает в General, где её никто не читает (так и набились слоты).
      if (failed && binding) {
        const back = loadBindings()
        back[key] = binding
        saveBindings(back)
        void say(`${note}\n${L.deleteKeptOnCleanupFail}`)
        return
      }
      let delNote: string
      try {
        await bot.api.deleteForumTopic(chat_id, threadId)
        delNote = L.topicDeletedShort(threadId)
      } catch (e) {
        delNote = L.topicDeleteFail(escHtml(e instanceof Error ? e.message : String(e)))
      }
      void bot.api.sendMessage(chat_id, `${note}\n${delNote}`, { parse_mode: 'HTML' }).catch(() => {})
      return
    }
    if (cmd === 'bind') {
      if (!arg) {
        void say(L.bindUsage(codePath(PROJECTS_DIR)))
        return
      }
      try {
        const spec = parseBindSpec(arg)
        const dir = resolveProjectDir(spec.path, PROJECTS_DIR)
        const replacesAutoTopic = autoTopicBindings.has(key) || settingUp.has(key)
        if (replacesAutoTopic) {
          cancelledAutoTopics.add(key)
          // If the auto path saved/started first, its binding is implementation state, not a
          // user-selected conversation. Never preserve its Claude argv/session into the manual
          // Codex binding, and kill its per-key tmux before publishing the replacement.
          if (binding) {
            await killTmuxSession(sessionName(key, binding.dir)).catch(() => {})
          }
        }
        // Rebinding changes only the requested target and adapter.  The rest of
        // the record is durable session/worktree state: dropping it would orphan
        // a conversation and prevent a worktree hook from cleaning up later.
        reg[key] = { ...(replacesAutoTopic ? {} : binding), dir, agent: spec.agent }
        saveBindings(reg)
        const boundText = binding
          ? L.rebound(
              escHtml(key),
              codePath(binding.dir),
              codePath(dir),
              binding.sessionId ? escHtml(binding.sessionId.slice(0, 8)) : undefined,
            )
          : L.bound(escHtml(key), codePath(dir))
        void bot.api
          .sendMessage(
            chat_id,
            boundText,
            { ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, reg[key]!) },
          )
          .catch(() => {})
      } catch (e) {
        void say(L.bindFail(escHtml(e instanceof Error ? e.message : String(e))))
      }
      return
    }
    if (cmd === 'unbind') {
      if (!binding) {
        void say(L.nothingBoundHere)
        return
      }
      void say((await teardownBinding(key, binding)).note)
      return
    }
    // allow
    if (!binding) {
      void say(L.bindFirst)
      return
    }
    if (!arg) {
      const current = binding.allow?.length ? `<code>${escHtml(binding.allow.join(', '))}</code>` : L.allowNobody
      void say(L.allowStatus(current))
      return
    }
    const ids = arg.split(/[\s,]+/).filter(s => /^\d+$/.test(s))
    if (ids.length === 0) {
      void say(L.allowUsage)
      return
    }
    binding.allow = [...new Set([...(binding.allow ?? []), ...ids])]
    saveBindings(reg)
    void say(L.allowSet(escHtml(binding.allow.join(', '))))
    return
  }

  if (!isAdmin(senderId) && !binding?.allow?.includes(senderId)) {
    return
  }

  let live = binding ? connsForBinding(key, binding.dir) : []
  const session = live.length > 0 ? router.get(live[0]) : undefined

  // /stand_up | /stand_down — stand hooks from the binding folder's `.tmux-channels.json`. The hook prints
  // `internal=…`/`external=…` — those are the links; the rest of the output is shown as a tail.
  if (cmd === 'stand_up' || cmd === 'stand_down') {
    if (!binding) {
      void say(L.noBindingBindFirst)
      return
    }
    const kind = cmd === 'stand_up' ? 'up' : 'down'
    void say(kind === 'up' ? L.standUpProgress : L.standDownProgress)
    const res = await runStandCommand(binding.dir, kind)
    if (!res) {
      void say(
        L.noStandConfig(codePath(binding.dir), PROJECT_CONFIG_FILE, kind),
      )
      return
    }
    const links = parseStandLinks(res.out)
    const tail = standLogTail(res.out, res.err)
    const head = res.ok
      ? kind === 'up'
        ? L.standUpOk
        : L.standDownOk
      : L.standHookFail(escHtml(kind))
    const linkLines = [
      links.external ? `🌍 ${escHtml(links.external)}` : '',
      links.internal ? `🏠 ${escHtml(links.internal)}` : '',
    ].filter(Boolean)
    void say(
      [head, ...(linkLines.length ? ['', ...linkLines] : []), ...(tail ? ['', `<pre>${escHtml(tail)}</pre>`] : [])].join('\n'),
    )
    return
  }

  // /fork [директива] — ветка разговора в СВОЁМ топике: та же история до этой точки, дальше
  // живёт отдельно (--fork-session). Оригинал не трогаем: он остаётся в своём топике как был.
  // Встроенный /fork у CLI отдаёт ветку фоновому агенту, с которым из чата не поговорить —
  // поэтому команду перехватываем здесь.
  if (cmd === 'fork') {
    if (!binding) {
      void say(L.noBindingBindFirst)
      return
    }
    if (!binding.sessionId) {
      void say(L.forkNoConversation)
      return
    }
    if (threadId == null) {
      void say(L.forkNeedsTopic) // ветка = новый топик, в DM его не создать
      return
    }
    const name = forkTopicName(chat_id, threadId, binding.dir)
    void say(L.forkCreating(escHtml(name)))
    let newThreadId: number
    try {
      const topic = await bot.api.createForumTopic(chat_id, name)
      newThreadId = topic.message_thread_id
    } catch (e) {
      void say(L.forkTopicFailed(escHtml(String(e))))
      return
    }
    const newKey = messageKey({ chatType: 'supergroup', chatId: chat_id, threadId: newThreadId })
    recordTopic(chat_id, newThreadId, name, new Date().toISOString())
    const fresh = loadBindings()
    fresh[newKey] = {
      dir: binding.dir,
      ...(binding.agent ? { agent: binding.agent } : {}),
      sessionId: binding.sessionId, // точка разветвления; свой id ветка выучит при старте
      ...(binding.cmdline ? { cmdline: binding.cmdline } : {}),
      ...(binding.allow ? { allow: [...binding.allow] } : {}),
    }
    saveBindings(fresh)
    const sayFork = (html: string) =>
      void bot.api
        .sendMessage(chat_id, html, { message_thread_id: newThreadId, parse_mode: 'HTML' })
        .catch(() => {})
    sayFork(L.forkedFrom(threadId, escHtml(binding.sessionId)))
    await spawnSession(newKey, fresh[newKey]!, 'fork', sayFork)
    const conns = await waitForBinding(newKey, 30_000)
    if (conns.length === 0) {
      sayFork(L.sessionNotConnectedInTime)
      return
    }
    if (arg) {
      // директива — первое сообщение ветке; ждём готовности пейна, иначе неготовый CLI её теряет
      const forkSession = router.get(conns[0]!)
      await waitPaneReady(forkSession?.pane, PANE_READY_MS, forkSession ? adapterForSession(forkSession) : adapterForBinding(fresh[newKey]))
      const meta: Record<string, string> = {
        chat_id, user: senderId, user_id: senderId,
        ts: new Date().toISOString(), topic_id: String(newThreadId),
      }
      armPending(newKey, { dir: binding.dir, at: Date.now() })
      await deliverMessage(newKey, binding.dir, { op: 'event', kind: 'message', content: arg, meta }, arg)
    }
    return
  }

  // /resume <id|prefix> — bring up a SPECIFIC conversation, no picker and regardless of
  // whether tmux is alive (spawnSession brings it up itself). Kill the live session — else --resume forks.
  if (cmd === 'resume' && arg) {
    if (!binding) {
      void say(L.noBindingBindFirst)
      return
    }
    const want = arg.trim().toLowerCase()
    const hits = [...adapterForBinding(binding).sessionMtimes(binding.dir).keys()].filter(id => id.startsWith(want))
    if (hits.length !== 1) {
      void say(
        hits.length === 0
          ? L.noSessionNamed(escHtml(want), codePath(binding.dir))
          : L.prefixAmbiguous(escHtml(want), hits.length),
      )
      return
    }
    // A directory can intentionally have several topic bindings, but a concrete
    // conversation id may have only one owner.  Resuming another topic's id
    // would create two agents writing the same history (and a later revive
    // would make that fork look legitimate), so reject it before stopping the
    // caller's live session.
    const chosenId = hits[0]!
    const owner = sessionOwner(loadBindings(), binding.dir, chosenId, key)
    if (owner) {
      const target = keyToTarget(owner)
      const title = target.thread_id != null ? topicTitle(target.chat_id, target.thread_id) : undefined
      const label = target.thread_id != null
        ? `<code>#${target.thread_id}</code>${title ? ` «${escHtml(title)}»` : ''}`
        : `<code>${escHtml(owner)}</code>`
      void say(L.sessionOwnedByTopic(escHtml(chosenId), label))
      return
    }
    if (!(await stopLiveSessions(key, binding))) {
      void say(L.couldntStopCurrentScreen)
      return
    }
    // stopLiveSessions may wait for Claude's background-task confirmation.  Do
    // not save the `reg` snapshot captured before that await: an incoming turn
    // in another topic can learn its session id in the meantime.  Reload and
    // touch only this key, otherwise `/resume` silently rolls that other update
    // back (LM16).
    const latest = loadBindings()
    const latestBinding = setSessionId(latest, key, chosenId)
    if (!latestBinding) {
      void say(L.noBindingBindFirst)
      return
    }
    saveBindings(latest)
    await spawnSession(key, latestBinding, 'resume', html => void say(html))
    return
  }

  if (cmd === 'status') {
    if (!binding) {
      void say(L.statusNotBound(escHtml(key)))
      return
    }
    const branch = await gitBranch(binding.dir)
    const lines = [
      `📊 <b>${escHtml(key)}</b>`,
      '',
      `📁 ${codePath(binding.dir)}${branch ? ` <i>(${escHtml(branch)})</i>` : ''}`,
      '',
    ]
    const adapter = adapterForBinding(binding)
    if (session) {
      const pidState = session.pid
        ? alive(session.pid) ? L.pidAlive(session.pid) : L.pidDead(session.pid)
        : L.pidUnknown
      const tmuxName = sessionName(key, binding.dir)
      lines.push(
        `🤖 ${adapter.displayName}: ${pidState}`,
        `🪟 tmux: <code>${escHtml(tmuxName)}</code>${session.pane ? ` <i>(${escHtml(session.pane)})</i>` : ''}`,
      )
      if (binding.sessionId) {
        lines.push(`🆔 session: <code>${escHtml(binding.sessionId)}</code>`)
      }
    } else {
      lines.push(`⚫ ${adapter.displayName}: disconnected`)
      const name = sessionName(key, binding.dir)
      const tmuxState = (await hasTmuxSession(name)) ? L.tmuxHas : L.tmuxNone
      lines.push(L.statusTmux(escHtml(name), tmuxState), '', L.statusResumeHint)
    }
    if (binding.pinned) {
      lines.push('', L.statusPinned)
    } else if (IDLE_UNLOAD_MS > 0) {
      lines.push('', L.statusIdleUnload(Math.round(IDLE_UNLOAD_MS / 60_000)))
    }
    // Stand — only if the project can probe it at all (`.tmux-channels.json` → stand.status).
    const stand = await runStandCommand(binding.dir, 'status')
    if (stand) {
      const links = parseStandLinks(stand.out)
      const url = links.external ?? links.internal
      lines.push(
        '',
        stand.ok
          ? L.statusStandUp(url ? escHtml(url) : '')
          : L.statusStandDown,
      )
    }
    const cachedStatus = adapter.cachedStatusLines(binding.dir, Date.now())
    if (cachedStatus.length) {
      lines.push('', ...cachedStatus.map(escHtml))
    }
    // Codex exposes quota/context only through its own `/status` panel.  This is deliberately
    // an on-demand read (not a polling side effect) and it refuses to touch a non-empty local
    // composer, so a person using the tmux pane cannot lose a draft to a Telegram refresh.
    if (session?.pane && adapter.statusPanelCommand) {
      const panel = await readLiveStatusPanel(adapter, session.pane)
      if (panel) {
        const telemetry = formatLiveStatusPanel(panel)
        if (telemetry.length) {
          lines.push('', ...(panel.model ? [`🧠 ${escHtml(panel.model)}`] : []), ...telemetry)
        }
      } else {
        lines.push('', L.statusQuotaUnavailable)
      }
    }
    if (binding.allow?.length) {
      lines.push('', L.statusAccess(escHtml(binding.allow.join(', '))))
    }
    void say(lines.join('\n'))
    return
  }

  if (!binding) {
    void say(L.nothingBoundBindFirst)
    return
  }

  if (cmd === 'compact' || cmd === 'clear' || cmd === 'esc' || cmd === 'enter' || cmd === 'restart' || cmd === 'model' || cmd === 'stop' || cmd === 'screen' || cmd === 'last') {
    if (live.length === 0) {
      // Сессию мог остановить idle-unload — для пользователя она «просто есть», он не обязан
      // знать про выгрузку. Команды, осмысленные на поднятой сессии, поднимают её сами (как
      // это делает обычное сообщение). /esc и /stop не поднимаем: прерывать/останавливать
      // нечего, подъём ради немедленной остановки — абсурд.
      // /clear на ВЫГРУЖЕННОЙ сессии: поднимать старую бессмысленно — историю всё
      // равно выбрасываем. Стартуем свежую: результат тот же, но без промпта
      // «сессия большая, возобновить из саммари?» и без трат на возобновление.
      if (cmd === 'clear' && binding.sessionId) {
        void say(L.clearStartsFresh)
        await spawnSession(key, binding, 'new', html => void say(html))
        return
      }
      const revivable = cmd !== 'esc' && cmd !== 'stop'
      if (revivable && binding.sessionId) {
        void say(L.revivingForCommand(cmd))
        await spawnSession(key, binding, 'resume', () => {})
        live = await waitForBinding(key, 30_000)
        const pane = live.length > 0 ? router.get(live[0])?.pane : undefined
        // Здесь срок НАМЕРЕННО короче PANE_READY_MS: это не ожидание доставки, а проба —
        // не готов за 12 с, значит сессия о чём-то спрашивает, и пользователю надо сказать
        // об этом сейчас, а не через минуту молчания. Не сводить к общей константе.
        if (!(await waitPaneReady(pane, 12_000, adapterForBinding(binding)))) {
          void say(L.sessionAsksFirst(cmd)) // кнопки уже отправил picker bridge
          return
        }
      }
      if (live.length === 0) {
        void say(revivable ? L.noLiveSession : L.nothingToInterrupt)
        return
      }
    }
    for (const conn of live) {
      const s = router.get(conn)
      if (!s?.pane) {
        void say(L.notInTmuxControl)
        continue
      }
      try {
        if (cmd === 'compact') {
          await sendKeys(s.pane, '/compact', 'Enter')
          void say(L.compactSent)
        } else if (cmd === 'clear') {
          await sendKeys(s.pane, '/clear', 'Enter')
          void say(L.historyCleared)
        } else if (cmd === 'esc') {
          // Interrupt the current turn AND drain the input queue. After an interrupt Claude Code
          // immediately starts the NEXT queued message, so a lone Escape looks like it "did
          // nothing" when a queue is feeding (the prod runaway couldn't be stopped this way).
          // Escape a few times to drain a short queue, then Ctrl-U to clear the input line.
          for (let i = 0; i < 3; i++) {
            await sendKeys(s.pane, 'Escape')
            await new Promise(r => setTimeout(r, 500))
          }
          await sendKeys(s.pane, 'C-u')
          // Escape подряд открывает Rewind — наш же дренаж оставлял на экране диалог, который
          // потом съедает ввод и подсовывает picker'у нумерованные списки из вывода агента.
          // Закрываем то, что сами открыли (интервал не спасает: клавиши доезжают пачкой).
          for (let i = 0; i < 2; i++) {
            if (!hasPickerFooter(await capturePane(s.pane).catch(() => ''))) {
              break
            }
            await sendKeys(s.pane, 'Escape')
            await new Promise(r => setTimeout(r, 400))
          }
          void say(L.escSent)
        } else if (cmd === 'enter') {
          // Submit whatever is already in the pane's input line (e.g. a /compact that got
          // typed but not sent) — a bare Enter, without typing anything.
          await sendKeys(s.pane, 'Enter')
          void say(L.enterSent)
        } else if (cmd === 'screen') {
          // Universal 1:1 view of the pane — the escape hatch for any TUI state the picker
          // bridge doesn't recognize. Live, self-updating message with a Close button (deletes
          // it) instead of a one-shot photo, so the debug view doesn't pile up in history.
          await startLiveScreen(chat_id, threadId, s.pane)
          // drop the "/screen" command itself too (works where the bot can delete — groups; a
          // DM won't let a bot delete the user's message, hence best-effort).
          if (msgId != null) {
            void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
          }
        } else if (cmd === 'last') {
          // Same live view as /screen but text-only (paneDigest) — readable recent output +
          // live bottom, no image render at all. Self-updating with a Close button.
          await startLiveScreen(chat_id, threadId, s.pane, 'text')
          if (msgId != null) {
            void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
          }
        } else if (cmd === 'model') {
          // Typed as real keystrokes (not a message-event) so the CLI opens its
          // native picker — pollScreens/detectPicker below turns it into buttons.
          await sendKeys(s.pane, '/model', 'Enter')
          void say(L.modelSent)
        } else if (cmd === 'stop') {
          if (!s.pid) {
            void say(L.stopNoProc)
            continue
          }
          void say(L.stopping)
          expectedDisconnect.add(key)
          void stopSession(s.pane, s.pid, log)
            .then(ok => {
              if (!ok) {
                return void say(L.procNotDead)
              }
              // straight into the what-next choice — same keyboard as after /bind
              void bot.api
                .sendMessage(chat_id, L.sessionStopped, {
                  ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, binding),
                })
                .catch(() => {})
            })
            .catch(e => say(L.stopFail(escHtml(String(e)))))
            .finally(() => setTimeout(() => expectedDisconnect.delete(key), 90_000))
        } else {
          if (!s.pid || !s.cmdline?.length) {
            void say(L.restartNoProc)
            continue
          }
          void say(L.restarting)
          expectedDisconnect.add(key)
          const restartKeys = s.bindingKeys?.length ? s.bindingKeys : [key]
          const adapter = adapterForSession(s)
          const restart = adapter.capabilities.nativeInboundTransport
            ? restartSession(s.pane, s.pid, s.cmdline, restartKeys, log)
            : stopSession(s.pane, s.pid, log).then(async ok => {
                if (!ok) throw new Error('process did not stop')
                await new Promise(r => setTimeout(r, 1000))
                await typeLine(s.pane!, adapter.launchEnvPrefix(restartKeys) + ' ' + memoryCapPrefix() + adapter.buildLaunch(s.cmdline, 'resume', binding.sessionId))
              })
          void restart
            .then(() => say(L.restartSent))
            .catch(e => say(L.restartFail(escHtml(String(e)))))
            .finally(() => setTimeout(() => expectedDisconnect.delete(key), 90_000))
        }
      } catch (e) {
        void say(L.cmdFail(escHtml(cmd), escHtml(String(e))))
      }
    }
    return
  }

  // resume | new
  if (live.length > 0) {
    // `/new` means a genuinely fresh conversation even if the current agent is
    // still connected.  Merely refusing here left no way to do that from
    // Telegram except the awkward two-step `/stop` → button flow.  Stop first:
    // launching another CLI into the same pane would otherwise become input to
    // the live agent instead of a process replacement.
    if (cmd === 'new') {
      if (!(await stopLiveSessions(key, binding))) {
        void say(L.couldntStopCurrentScreen)
        return
      }
      await new Promise(r => setTimeout(r, 1000))
      await spawnSession(key, binding, 'new', html => void say(html))
      return
    }
    const liveAdapter = adapterForBinding(binding)
    if (cmd === 'resume' && !liveAdapter.capabilities.liveResumePicker) {
      // Codex 0.147 accepts `/resume` as ordinary composer text while a
      // conversation is open; it has no selectable in-place history screen.
      // Keep the current process intact until the user taps a concrete
      // Telegram choice, which then follows the existing rs: stop→resume path.
      void bot.api
        .sendMessage(chat_id, L.whichSessionRaise, {
          ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, binding),
        })
        .catch(e => log(`resume picker send failed: ${e}`))
      return
    }
    if (cmd === 'resume' && session?.pane) {
      // Live session → open the CLI's own /resume list and mirror EXACTLY what
      // it shows; taps drive it with arrow keys (nr: callback). In-place switch,
      // no process restart. Positions can't drift: buttons ARE the TUI's rows.
      const pane = session.pane
      await sendKeys(pane, '/resume', 'Enter')
      // ponytail: the list loads asynchronously ("Loading conversations…") — poll up to 12s instead of a fixed 3s
      let list: ReturnType<typeof parseResumeList> = undefined
      for (let i = 0; i < 12 && !list?.rows.length; i++) {
        await new Promise(r => setTimeout(r, 1000))
        list = parseResumeList(await capturePane(pane).catch(() => ''))
      }
      if (!list?.rows.length) {
        await sendKeys(pane, 'Escape').catch(() => {}) // don't leave the picker open in someone else's pane
        log(`resume picker parse failed for pane ${pane}`)
        void say(L.sessionListFail)
        return
      }
      // ponytail: small TUI viewport — scroll with arrows and collect up to 10; if it all fit, don't scroll
      const wanted = Math.min(list.count, 10)
      const all: (ResumeRow | undefined)[] = list.rows.length >= wanted ? [...list.rows] : []
      all[list.pos - 1] = list.rows[list.cursor]
      for (let g = 0; list.pos < wanted && all.filter(Boolean).length < wanted && g < 12; g++) {
        await sendKeys(pane, 'Down')
        await new Promise(r => setTimeout(r, 200))
        const next = parseResumeList(await capturePane(pane).catch(() => ''))
        if (!next) {
          break
        }
        list = next
        all[list.pos - 1] = list.rows[list.cursor]
      }
      for (let g = 0; list.pos > 1 && g < 12; g++) {
        await sendKeys(pane, 'Up')
        await new Promise(r => setTimeout(r, 200))
        const prev = parseResumeList(await capturePane(pane).catch(() => ''))
        if (!prev) {
          break
        }
        list = prev
      }
      const rows: ResumeRow[] = []
      for (const r of all) {
        if (!r || rows.length >= wanted) {
          break // a gap = parse failure at this position; button indices must match the absolute ones
        }
        rows.push(r)
      }
      const kb = new InlineKeyboard()
      rows.forEach((r, i) => {
        kb.text(`${r.title.slice(0, 40)} · ${r.meta.split('·')[0].trim()}`, `nr:${key}:${i}:${fnv1a(r.title)}`).row()
      })
      kb.text(L.btnCancel, `nr:${key}:esc:00000000`).row()
      void bot.api
        .sendMessage(chat_id, L.switchSessionHdr(escHtml(list.total)), {
          ...threadOpt, parse_mode: 'HTML', reply_markup: kb,
        })
        .catch(e => log(`native resume picker send failed: ${e}`))
      return
    }
    void say(L.alreadyConnected(session?.pane ? `<code>${escHtml(session.pane)}</code>` : L.alreadyConnectedNoTmux))
    return
  }
  const foreign = forkRiskPids(binding)
  if (foreign.length > 0) {
    void say(
      L.foreignClaude(foreign.join(', ')),
    )
    return
  }
  // /resume with several past sessions → picker (like claude --resume, but with
  // buttons); tap lands in the rs:/ns: callbacks below. /new and single-session
  // /resume keep the old instant path.
  if (cmd === 'resume') {
    const recent = adapterForBinding(binding).recentSessions(binding.dir, 5)
    if (recent.length > 1) {
      void bot.api
        .sendMessage(chat_id, L.whichSessionRaise, {
          ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, binding),
        })
        .catch(e => log(`resume picker send failed: ${e}`))
      return
    }
    // No conversation exists in this folder.  `--continue` is not a harmless
    // default: Claude exits with “No conversation found”, leaving the topic
    // apparently resumed but with an empty shell.  Starting fresh is the only
    // actionable interpretation of `/resume` here.
    if (recent.length === 0) {
      await spawnSession(key, binding, 'new', html => void say(html))
      return
    }
  }
  await spawnSession(key, binding, cmd === 'resume' ? 'resume' : 'new', html => void say(html))
}

// "🆕 new or ⏪ which past session" keyboard — shown after /bind and on /resume.
// Непривязанный чат админа: предложить папки вместо молчания. Личка — основной
// канал работы с Claude, и «пишешь, а он как будто мёртв» — худший из вариантов.
const bindPromptAt = new Map<string, number>()
const BIND_PROMPT_COOLDOWN_MS = 10 * 60 * 1000

function projectFolders(limit = 12): string[] {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e: { isDirectory(): boolean; name: string }) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: { name: string }) => e.name)
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

// Where an unbound message is plausibly an invitation to bind: a DM with the bot, or a group
// deliberately pointed at a project. In someone else's work chat the bot is just a member —
// answering there is an interruption, so it stays silent, as it did before offers existed.
// Telegram gives users positive ids and chats negative ones, so the sign is the test.
// `/bind` is dispatched earlier, so it still works anywhere.
const bindOffersWelcome = (chatId: string): boolean => !chatId.startsWith('-') || chatId in loadTrustedGroups()

function offerBind(key: string, chatId: string, threadId: number | undefined): void {
  const now = Date.now()
  if (now - (bindPromptAt.get(key) ?? 0) < BIND_PROMPT_COOLDOWN_MS) {
    return // не долбим подсказкой на каждое сообщение
  }
  bindPromptAt.set(key, now)
  const kb = new InlineKeyboard()
  for (const name of projectFolders()) {
    kb.text(`📁 ${name}`, `bindto:${key}:${name}`).row()
  }
  void bot.api
    .sendMessage(chatId, t().noBindingPickFolder, {
      ...inTopic(threadId),
      parse_mode: 'HTML',
      ...(kb.inline_keyboard.length > 0 ? { reply_markup: kb } : {}),
    })
    .catch(() => {})
}

function startChoiceKeyboard(key: string, binding: BindingEntry): InlineKeyboard {
  const kb = new InlineKeyboard()
  kb.text(t().btnNewSession, `ns:${key}`).row()
  for (const r of adapterForBinding(binding).recentSessions(binding.dir, 5)) {
    const when = new Date(r.mtime).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    kb.text(`⏪ ${when} · ${r.snippet.slice(0, 40) || r.id.slice(0, 8)}`, `rs:${key}:${r.id}`).row()
  }
  return kb
}

bot.on('my_chat_member', ctx => {
  recordChat(String(ctx.chat.id), ctx.chat.type, chatLabel(ctx.chat), new Date().toISOString())
})

bot.on('message:forum_topic_created', ctx => {
  const chat_id = String(ctx.chat.id)
  const cfg = loadTrustedGroups()[chat_id]
  if (!cfg) {
    return
  }
  const threadId = ctx.message.message_thread_id ?? ctx.message.message_id
  const topicName = ctx.message.forum_topic_created.name
  recordTopic(chat_id, threadId, topicName, new Date().toISOString())
  if (isExcludedTopic(cfg, threadId, topicName)) {
    return
  }
  const key = messageKey({ chatType: ctx.chat.type, chatId: chat_id, threadId })
  // Топик мог создать сам хаб уже с папкой (/fork) — спрашивать нечего. Гонки нет: /fork
  // пишет binding без единого await после createForumTopic, апдейт обрабатывается позже.
  if (loadBindings()[key]) {
    return
  }
  const say = (html: string) =>
    void bot.api
      .sendMessage(chat_id, html, { message_thread_id: threadId, parse_mode: 'HTML' })
      .catch(() => {})

  // Always ask, even with a single mode: otherwise the topic silently starts in the default folder
  // and there's no way to pick another (and autostart also races with a manual /resume).
  armMode(key, { cfg, topicName, say }, chat_id, threadId)
  void bot.api
    .sendMessage(chat_id, modePromptText(cfg, t().howRaiseTopic), {
      message_thread_id: threadId,
      parse_mode: 'HTML',
      reply_markup: modeKeyboard(key, cfg),
    })
    .catch(() => {})
})

// renames — group title arrives as a service message, a topic's only ever here
bot.on('message:new_chat_title', ctx => {
  recordChat(String(ctx.chat.id), ctx.chat.type, ctx.message.new_chat_title, new Date().toISOString())
})

bot.on('message:forum_topic_edited', ctx => {
  const threadId = ctx.message.message_thread_id
  const name = ctx.message.forum_topic_edited.name
  if (threadId == null || !name) {
    return // icon-only edit
  }
  recordTopic(String(ctx.chat.id), threadId, name, new Date().toISOString())
})

bot.on('message:text', async ctx => handleInbound({ ctx, text: ctx.message.text }))

bot.on('message:photo', async ctx => {
  const downloadImage = async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) {
        return undefined
      }
      const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      log(`photo download failed: ${err}`)
      return undefined
    }
  }
  await handleInbound({ ctx, text: ctx.message.caption ?? '(photo)', downloadImage })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? `(document: ${name ?? 'file'})`,
    attachment: { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name },
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const path = await doDownload({ file_id: voice.file_id }).catch(() => undefined)
  const transcript = path ? await transcribeVoice(path) : undefined
  await handleInbound({
    ctx,
    text: transcript ?? ctx.message.caption ?? '(voice message)',
    attachment: { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type },
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`,
    attachment: { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name },
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? '(video)',
    attachment: {
      kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type,
      name: safeName(video.file_name),
    },
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound({
    ctx,
    text: '(video note)',
    attachment: { kind: 'video_note', file_id: vn.file_id, size: vn.file_size },
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  await handleInbound({
    ctx,
    text: `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})`,
    attachment: { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size },
  })
})

bot.on('callback_query:data', async ctx => {
  const sc = /^scrclose:(\S+)$/.exec(ctx.callbackQuery.data)
  if (sc) {
    const v = closeLiveScreen(sc[1])
    // Живые просмотры лежат в памяти, поэтому после рестарта хаба токен неизвестен —
    // но кнопка на старом сообщении остаётся рабочей у пользователя. Берём координаты
    // из самого апдейта, иначе Close отвечал бы "Closed", ничего не закрывая.
    const chatId = v?.chatId ?? String(ctx.callbackQuery.message?.chat.id ?? '')
    const msgId = v?.msgId ?? ctx.callbackQuery.message?.message_id
    if (chatId && msgId != null) {
      await bot.api.deleteMessage(chatId, msgId).catch(() => {})
    }
    await ctx.answerCallbackQuery({ text: t().toastClosed }).catch(() => {})
    return
  }
  // skpg:<token>:<page> — flip the /skills menu to another page (edit keyboard in place).
  const sp = /^skpg:(\d+):(\d+)$/.exec(ctx.callbackQuery.data)
  if (sp) {
    const menu = skillMenus.get(sp[1]!)
    if (!menu) {
      await ctx.answerCallbackQuery({ text: t().toastMenuStale }).catch(() => {})
      return
    }
    await ctx.editMessageReplyMarkup({ reply_markup: skillMenuKeyboard(sp[1]!, menu.names, Number(sp[2])) }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  // skrun:<token>:<idx> — run a project skill picked from the /skills menu.
  const sr = /^skrun:(\d+):(\d+)$/.exec(ctx.callbackQuery.data)
  if (sr) {
    const menu = skillMenus.get(sr[1]!)
    const name = menu?.names[Number(sr[2])]
    if (!menu || !name) {
      await ctx.answerCallbackQuery({ text: t().toastMenuStale }).catch(() => {})
      return
    }
    const senderId = String(ctx.from.id)
    const binding = loadBindings()[menu.key]
    if (!binding || (!isAdmin(senderId) && !binding.allow?.includes(senderId))) {
      await ctx.answerCallbackQuery({ text: t().toastNoAccess }).catch(() => {})
      return
    }
    const conns = connsForBinding(menu.key, menu.dir)
    if (conns.length === 0) {
      await ctx.answerCallbackQuery({ text: t().toastNoLiveResume }).catch(() => {})
      return
    }
    const msg = ctx.callbackQuery.message
    const agent = binding.agent ?? 'claude'
    const ok = await injectSkillToPanes(
      conns, skillInvocation(agent, name), menu.key, menu.dir, String(ctx.chat?.id ?? ''),
      msg?.message_thread_id, undefined, agent,
    )
    await ctx.answerCallbackQuery({ text: ok ? t().toastRun(name) : t().toastNotInTmux }).catch(() => {})
    if (ok && msg) {
      await ctx.editMessageText(t().skillLaunched(escHtml(name)), { parse_mode: 'HTML' }).catch(() => {})
    }
    return
  }
  const th = /^topicharness:(.+)$/.exec(ctx.callbackQuery.data)
  if (th) {
    const [, key] = th
    const pending = pendingModeChoice.get(key!)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: t().toastAlreadyChosen }).catch(() => {})
      return
    }
    if (!isAdmin(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: t().toastNoRights }).catch(() => {})
      return
    }
    // По кругу: следующий харнесс из настроенных. Сообщение не пересоздаём — правим клавиатуру
    // на месте, чтобы выбор режима остался тем же одним тапом.
    const choices = harnessChoices(pending.cfg)
    const cur = pending.agent ?? pending.cfg.agent ?? choices[0]!
    const next = choices[(choices.indexOf(cur) + 1) % choices.length]!
    pendingModeChoice.set(key!, { ...pending, agent: next })
    await ctx.answerCallbackQuery({ text: agentAdapter(next).displayName }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: modeKeyboard(key!, pending.cfg, next) }).catch(() => {})
    return
  }
  const tm = /^topicmode:(.+):(folder|worktree)(?::(\d+))?$/.exec(ctx.callbackQuery.data)
  if (tm) {
    const [, key, modeStr, baseIdx] = tm
    const mode = modeStr as TrustedGroupMode
    const pending = pendingModeChoice.get(key)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: t().toastAlreadyChosen }).catch(() => {})
      return
    }
    if (!isAdmin(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: t().toastNoRights }).catch(() => {})
      return
    }
    disarmMode(key)
    await ctx.answerCallbackQuery({ text: modeLabel(mode) }).catch(() => {})
    await ctx.editMessageText(t().modeChosen(modeLabel(mode))).catch(() => {})
    const base = baseIdx !== undefined && pending.cfg.dir
      ? worktreeBases(pending.cfg.dir)[Number(baseIdx)]
      : undefined
    beginTopicSession(key, pending.cfg, mode, pending.topicName, pending.say, base, pending.agent)
    return
  }
  const td = /^topicdir:(.+)$/.exec(ctx.callbackQuery.data)
  if (td) {
    const [, key] = td
    const pending = pendingModeChoice.get(key)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: t().toastAlreadyChosen }).catch(() => {})
      return
    }
    if (!isAdmin(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: t().toastNoRights }).catch(() => {})
      return
    }
    disarmMode(key)
    await ctx.answerCallbackQuery({ text: ownDirLabel() }).catch(() => {})
    await ctx.editMessageText(t().modeChosen(ownDirLabel())).catch(() => {})
    pending.say(t().sendFolderPromptShort(codePath(PROJECTS_DIR)))
    pendingTopics.set(key, { cfg: pending.cfg, mode: 'folder', topicName: pending.topicName, say: pending.say })
    return
  }
  // nr:<key>:<idx|esc>:<title-hash> = drive the CLI's own /resume list by arrows
  const bt = /^bindto:(.+):([^:]+)$/.exec(ctx.callbackQuery.data)
  if (bt) {
    const [, key, folder] = bt
    const senderId = String(ctx.from.id)
    if (!isAdmin(senderId)) {
      await ctx.answerCallbackQuery({ text: t().toastNoAccess }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const t2 = keyToTarget(key!)
    await handleOps({
      cmd: 'bind', arg: folder!, key: key!, chat_id: t2.chat_id,
      ...(t2.thread_id != null ? { threadId: t2.thread_id } : {}), senderId,
    })
    return
  }

  const nr = /^nr:(.+):(\d+|esc):([0-9a-f]{8})$/.exec(ctx.callbackQuery.data)
  if (nr) {
    const [, key, idxStr, hash] = nr
    const senderId = String(ctx.from.id)
    const binding = loadBindings()[key]
    if (!binding) {
      await ctx.answerCallbackQuery({ text: t().toastBindingGone }).catch(() => {})
      return
    }
    if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: t().toastNoAccess }).catch(() => {})
      return
    }
    const conn = connsForBinding(key, binding.dir)[0]
    const pane = conn ? router.get(conn)?.pane : undefined
    if (!pane) {
      await ctx.answerCallbackQuery({ text: t().toastSessionGoneResume }).catch(() => {})
      return
    }
    if (idxStr === 'esc') {
      await sendKeys(pane, 'Escape')
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageText(t().closedShort).catch(() => {})
      return
    }
    const idx = Number(idxStr)
    const stale = async (why: string) => {
      await ctx.answerCallbackQuery({ text: why }).catch(() => {})
    }
    let list = parseResumeList(await capturePane(pane).catch(() => ''))
    if (!list || idx >= list.count) {
      return stale(t().staleListChanged)
    }
    // move cursor to the row (absolute position from the "(N of M)" header — the row may
    // be outside the viewport), re-verify what's actually highlighted, only then Enter
    const moves = idx + 1 - list.pos
    for (let i = 0; i < Math.abs(moves); i++) {
      await sendKeys(pane, moves > 0 ? 'Down' : 'Up')
      await new Promise(r => setTimeout(r, 150))
    }
    await new Promise(r => setTimeout(r, 400))
    list = parseResumeList(await capturePane(pane).catch(() => ''))
    if (!list || list.pos !== idx + 1 || fnv1a(list.rows[list.cursor].title) !== hash) {
      return stale(t().staleCursorMiss)
    }
    const title = list.rows[list.cursor].title
    await sendKeys(pane, 'Enter')
    await ctx.answerCallbackQuery({ text: t().toastSwitching }).catch(() => {})
    await ctx.editMessageText(t().switchedTo(escHtml(title)), { parse_mode: 'HTML' }).catch(() => {})
    return
  }
  // rs:<key>:<uuid> = resume that session; ns:<key> = start fresh
  const start = /^rs:(.+):([0-9a-f-]{36})$/.exec(ctx.callbackQuery.data) ?? /^ns:(.+)$/.exec(ctx.callbackQuery.data)
  if (start) {
    const [, key, sessionId] = start
    const senderId = String(ctx.from.id)
    const reg = loadBindings()
    const binding = reg[key]
    if (!binding) {
      await ctx.answerCallbackQuery({ text: t().toastBindingGone }).catch(() => {})
      return
    }
    if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: t().toastNoAccess }).catch(() => {})
      return
    }
    if (sessionId) {
      binding.sessionId = sessionId
      saveBindings(reg)
    }
    await ctx.answerCallbackQuery({ text: sessionId ? t().toastRaising : t().toastLaunching }).catch(() => {})
    // a live session in the way → graceful stop before switching
    const liveConns = connsForBinding(key, binding.dir)
    if (liveConns.length > 0) {
      expectedDisconnect.add(key)
      setTimeout(() => expectedDisconnect.delete(key), 90_000)
      for (const conn of liveConns) {
        const s = router.get(conn)
        if (s?.pane && s.pid) {
          await ctx.editMessageText(t().stoppingCurrentSession, { parse_mode: 'HTML' }).catch(() => {})
          const ok = await stopSession(s.pane, s.pid, log).catch(() => false)
          if (!ok) {
            await ctx.editMessageText(t().couldntStopCurrentTmux, { parse_mode: 'HTML' }).catch(() => {})
            return
          }
        }
      }
    }
    await ctx
      .editMessageText(
        sessionId ? t().resumingId(sessionId.slice(0, 8)) : t().launchingNew,
        { parse_mode: 'HTML' },
      )
      .catch(() => {})
    const target = keyToTarget(key)
    await spawnSession(key, binding, sessionId ? 'resume' : 'new', html =>
      void bot.api.sendMessage(target.chat_id, html, {
        ...inTopic(target.thread_id),
        parse_mode: 'HTML',
      }).catch(() => {}),
    )
    return
  }
  const pick = parseCallback(ctx.callbackQuery.data)
  if (pick) {
    await handlePickCallback(ctx, pick)
    return
  }
  await ctx.answerCallbackQuery().catch(() => {}) // unmatched callback — ack so the client stops spinning
})

bot.catch(err => log(`handler error (polling continues): ${err.error}`))

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  log('shutting down')
  stateRepo.flush() // persist pending markers synchronously before exit
  // A replacement hub writes its PID before the old poller finishes reacting to SIGTERM.
  // Do not let this old process unlink the replacement's socket: that race made newly started
  // stubs/hooks silently lose their transport after a Docker/service restart.
  let ownsPollerSlot = false
  try {
    ownsPollerSlot = parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid
    if (ownsPollerSlot) rmSync(PID_FILE)
  } catch {}
  if (ownsPollerSlot) {
    rmQuiet(SOCK_PATH)
    rmQuiet(SPAWN_LOCK)
  }
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
// Единственная точка, где хаб выходит наружу: до её вызова импорт модуля ничего не делает —
// не занимает сокет, не убивает чужой поллер, не заводит таймеров и не ходит в Telegram.
// Ради этого всё и разносилось: без импортируемого модуля логику хаба нечем тестировать.
export async function start(): Promise<void> {
  if (!TOKEN) {
    log(`TELEGRAM_BOT_TOKEN required — set in ${ENV_FILE}`)
    process.exit(1)
  }
  if (ADMINS.length === 0) {
    log(`WARNING: TELEGRAM_ADMINS is empty — nobody can bind or converse`)
  }
  process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
  process.on('uncaughtException', err => log(`uncaught exception: ${err}`))
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  claimPollerSlot()
  listenForStubs()
  startScreenPoll()
  await pollForever()
}

async function pollForever(): Promise<void> {
  // grammY invokes onStart after every successful long-poll reconnect. Command
  // registration is a boot task, not a reconnect task: repeating it during a
  // 409 conflict hammers deleteMyCommands/setMyCommands and turns one poller
  // conflict into a long Telegram 429 cooldown.
  let commandsBootstrapped = false
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          rmQuiet(SPAWN_LOCK)
          log(`polling as @${info.username}`)
          void reviveBoundSessions() // host reboot: tmux died with it — bring sessions back
          // A pending marker that survived a restart: the turnend that would have forwarded its
          // answer may have fired while we were down, so re-check each once (reads the transcript,
          // forwards a fresh unanswered answer, disarms). Delay so sessions/transcripts settle.
          if (pendingAnswer.size > 0) {
            log(`reply-fallback: rechecking ${pendingAnswer.size} pending marker(s) recovered from disk`)
            setTimeout(() => { for (const key of [...pendingAnswer.keys()]) void forwardFallbackReply(key) }, 8000)
          }
          if (!commandsBootstrapped) {
            commandsBootstrapped = true
            // scoped lists (e.g. from an old bot) override the default in DMs/groups — clear them
            void bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } }).catch(e => log(`deleteMyCommands: ${e}`))
            void bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } }).catch(e => log(`deleteMyCommands: ${e}`))
            void refreshCommands() // ops + global-skill commands; async plugin scan, don't block polling
          }
        },
      })
      return
    } catch (err) {
      if (shuttingDown) {
        return
      }
      if (err instanceof Error && err.message === 'Aborted delay') {
        return
      }
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= MAX_409_ATTEMPTS) {
        log(`409 Conflict persists after ${attempt} attempts — another poller holds the token. Exiting.`)
        process.exit(1)
      }
      const delay = Math.min(1000 * attempt, MAX_BACKOFF_MS)
      log(`${is409 ? '409 Conflict' : `polling error: ${err}`}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

if (import.meta.main) {
  void start()
}
