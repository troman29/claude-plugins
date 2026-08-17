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
