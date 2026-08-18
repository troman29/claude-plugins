# Agent feature matrix

This is the parity contract for the Claude Code and Codex adapters. A row is complete only when
both implementations have an automated contract/integration test and the live smoke checklist has
passed. `native` describes implementation, not reduced UX: a non-native Codex transport still has
to expose the same Telegram behavior.

| User-visible capability | Claude adapter | Codex adapter | Required evidence |
|---|---|---|---|
| Create, bind, unbind, delete topic session | existing native channel | tmux + transcript/hooks | binding lifecycle integration |
| Deliver plain text/media while idle or busy | channel notification + ack | tmux input + transcript ack | idle and queued delivery scenarios |
| Agent text/file/voice reply and edit/react | MCP reply tools | transcript final + hub operations | outbound contract scenarios |
| Permission prompts as Telegram buttons | native permission RPC + picker | TUI picker | allow/deny integration |
| `/new`, `/resume [id]`, `/fork`, `/restart`, `/stop` | CLI adapter | CLI adapter | launch argv contract + live smoke |
| `/compact`, `/clear`, `/esc`, `/enter`, `/queue` | TUI adapter | TUI adapter | captured-pane fixtures |
| `/model` and `AskUserQuestion` buttons | Claude picker | Codex picker | picker fixtures + drive tests |
| `/status`, `/screen`, `/last`, limits/context/errors | statusline cache + pane parsers | on-demand `/status` modal + pane parsers | real 0.147 status fixture; refuses a non-empty local composer |
| compaction progress/lifecycle | TUI percentage bar | `PreCompact`/`PostCompact` lifecycle hooks | parser fixture + normalized auto/manual hook events |
| task/todo/subagent/skill/background status | Claude hooks | Codex hooks | normalized hook-event contract |
| global and project skill commands | Claude discovery | Codex discovery | discovery fixtures |
| worktree/folder modes and stand hooks | shared hub | shared hub | existing + two-adapter scenarios |
| durable binding/session identity and idle revive | JSON state + transcript | JSON state + transcript | restart/revive integration |

## Product comparison

This is a product-level inventory, not a release gate. `Hub` means telegram-tmux-channels as a
whole, across both adapters. The CCGram column was checked against CCGram commit `b7088fd`
(2026-08-16); it describes documented behavior and local source/tests, not evidence produced by
this repository.

Legend: ✅ supported, ◐ partial or materially different, — not found in the reviewed version.

| User-visible capability | Hub | CCGram | Material difference |
|---|---:|---:|---|
| One Telegram forum topic per independent agent session | ✅ | ✅ | Hub uses one isolated tmux session per binding; CCGram uses a tmux window or guarded Herdr session. |
| Claude Code and Codex | ✅ | ✅ | Hub has explicit adapter parity gates and native Claude channel delivery; CCGram drives both through the multiplexer/transcripts. |
| Gemini, Pi, Antigravity, and plain shell providers | — | ✅ | CCGram has provider adapters and per-topic provider selection. |
| Bind/unbind/delete and automatic topic setup | ✅ | ✅ | Hub supports trusted-group folder/worktree policies; CCGram offers a directory/provider browser and auto-detects tmux windows. |
| Telegram directory and provider browser | — | ✅ | Hub binding is command/config driven. |
| Folder and git-worktree topic modes | ✅ | ✅ | Hub supports project-specific create/delete hooks and stand hooks; CCGram offers an interactive branch/worktree picker. |
| Inbound text and media while the agent is idle or busy | ✅ | ✅ | Hub has native delivery acknowledgement for Claude and transcript-correlated acknowledgement for Codex. |
| Reply context from Telegram replies | ✅ | ◐ | Hub forwards replied message id, author, bounded text/caption, and media labels; CCGram documents General-chat reply support but no equivalent inbound envelope contract. |
| Outbound text, files, voice, edits, and reactions initiated by the agent | ✅ | ◐ | Hub exposes these as agent MCP tools; CCGram relays agent output and supports bot-side files/TTS/status edits/reactions. |
| Voice transcription | ✅ | ✅ | Hub forwards the transcription immediately; CCGram presents Send/Discard confirmation first. |
| Text-to-speech replies | ✅ | ✅ | Hub uses OpenAI TTS; CCGram supports Edge or OpenAI TTS. |
| Permission and interactive-question buttons | ✅ | ✅ | Both bridge terminal/agent prompts to Telegram buttons. |
| Restart-safe interactive buttons and message edits | ✅ | ◐ | Hub persists typed interaction records and restores live views/drafts; CCGram handles stale callbacks but does not document the same restart contract for every interaction. |
| `/new`, `/resume`, `/restart`, and `/stop` lifecycle control | ✅ | ✅ | Both recover dead sessions; Hub also has a first-class `/fork` that creates a separate Telegram topic. |
| `/fork` into a new independent topic | ✅ | — | CCGram may forward provider `/fork`; no equivalent topic-branch lifecycle was found. |
| `/compact`, `/clear`, `/esc`, and `/enter` terminal control | ✅ | ✅ | CCGram exposes common actions through its toolbar as well as commands. |
| Queue/follow-up without steering the active turn | ✅ | ◐ | Hub provides provider-neutral `/queue`; CCGram documents `/followup` for Pi. |
| Model picker | ✅ | ✅ | Hub drives Claude and Codex native pickers; CCGram exposes provider-specific mode/model actions. |
| Status, limits/context, task progress, and typing state | ✅ | ✅ | The data sources and provider coverage differ; both combine hooks, transcripts, and terminal state. |
| Live terminal image | ✅ | ✅ | Hub `/screen` is a self-updating PNG with Close; CCGram has `/screenshot` plus a configurable auto-refreshing live view. |
| Recent terminal/output as text (`/last`) | ✅ | ✅ | Both provide a Telegram-readable text view. |
| Workspace file delivery from Telegram | ◐ | ✅ | Hub `/send` means literal inbound text; files are sent by the agent's `reply` tool. CCGram `/send` browses/globs/searches workspace files for download. |
| Agent/provider command discovery and Telegram command menu | ◐ | ✅ | Hub discovers global/project skills; CCGram also maintains provider command catalogs and dynamic provider discovery. |
| Session dashboard | ◐ | ✅ | Hub `/status` is binding-local; CCGram `/sessions` lists sessions across topics. |
| Topic name/status emoji synchronization | — | ✅ | CCGram synchronizes window/topic names and exposes configurable status emoji. |
| Configurable action toolbar | — | ✅ | CCGram provides provider-specific and TOML-configurable buttons. |
| Multiplexer abstraction beyond tmux | — | ✅ | CCGram supports Herdr as an alternative backend. |
| Optional web dashboard | — | ✅ | CCGram documents an xterm.js mini-app with transcript search and a multi-pane grid. |
| Project stand-up/stand-down hooks | ✅ | — | Hub can call project-defined dev-environment lifecycle commands. |
| Idle unload and automatic quiet revival | ✅ | ◐ | Hub explicitly unloads inactive sessions and revives them on demand; CCGram provides crash/session recovery and auto-close behavior. |
| Read-only `/doctor` diagnostics | ✅ | ✅ | Hub checks Telegram, binding, process, tmux/pane, resume identity, MCP routing, and voice setup; CCGram has CLI/provider-aware diagnostics. |

The table is deliberately descriptive rather than a parity backlog. A CCGram-only row should be
implemented here only when it solves a concrete Hub use case and fits Hub's native-channel,
agent-tool architecture.

## Live release gate

1. `bun run check` passes with no skipped or weakened legacy tests.
2. Every matrix row has tests for both adapters.
3. One real Claude Code session and one real Codex session each receive a Telegram message, expose
   a permission or question interaction, and return the final answer to the same topic.
4. Resume both sessions by captured id and repeat one message/answer round trip.
5. In the Codex topic, run `/status` while its composer is empty and verify context and every
   displayed quota bucket; verify the pane returns to its prompt. A local draft must cause the
   refresh to be skipped rather than submitted.
6. Trust the installed Codex hooks once through `/hooks`, then run a manual compaction and verify
   the Telegram message changes from “Compaction” to “Compaction done”. Codex 0.147 does not
   support `async` command hooks, so these hooks intentionally use short synchronous commands.

## Latest Docker MTProto evidence

The isolated Docker harness was exercised against the configured test bot and a real MTProto
test account on 2026-08-15 and 2026-08-16. Claude and Codex each completed an inbound Telegram →
agent → same-topic reply round trip, including an explicit resume by captured session id. The
current Codex run on 2026-08-16 delivered `TTC_CODEX_LIVE_20260816` to topic `515`; Docker logged
the delivery and a live stub subscription. Its real TUI exposed two Telegram-driven permission
pickers (skill-file read, then `telegram.reply`); selecting “Allow for this session” produced
same-topic `TTC_CODEX_LIVE_OK` (message `791`) and synchronized the binding session id. A Telegram
`/status` then rendered live model, context, quota bucket, session id, tmux pane and directory
(message `793`), while the captured pane showed the native Codex status modal rather than a
submitted composer command. A manual `/compact` in the earlier run fired real `PreCompact` and
`PostCompact` hooks and left the Telegram lifecycle message as “Compaction done”.

On 2026-08-17 the same Docker+MTProto Codex session also passed a real `/fork` smoke: topic 515
created topic 977, started its own tmux session with `codex fork <parent-id>`, persisted distinct
session id `01a00f49…`, delivered the first branch directive, and emitted same-topic fallback
`fork-ok`. The parent binding remained untouched.
