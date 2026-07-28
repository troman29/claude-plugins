---
name: configure
description: Set up the Telegram channel — register the MCP stub, save the bot token and admin ids. Use when the user pastes a Telegram bot token, asks to configure Telegram, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(claude mcp *)
  - Bash(systemctl --user *)
  - Bash(launchctl *)
---

# /telegram:configure — Telegram Channel Setup

Cross-platform (Linux + macOS).

**Answer in the user's language** — this skill talks to a human. If they write in Russian,
reply in Russian; the bot's own UI language is a separate setting (`TELEGRAM_LANG` / `/lang`).

Arguments passed: `$ARGUMENTS`

## State

Everything lives in `~/.claude/channels/telegram/` (override with `TELEGRAM_STATE_DIR`):

| File | What it is |
|---|---|
| `.env` | Token, admins, all options below. `chmod 600` — it holds a secret |
| `bindings.json` | chat/topic → project dir. Hub-managed via `/bind`; hand-editable, hot-reloaded |
| `known-chats.json` | Every chat and forum topic the bot has seen — handy for looking up ids |
| `trusted-groups.json` | Optional: groups where a new topic binds itself (see the README) |
| `lang` | Current UI language, written by `/lang` |

Runtime bits you can ignore: `hub.sock`, `bot.pid`, `hub.spawnlock`, `inbox/`, `screenlog.jsonl`.

## Options in `.env`

Required:

- `TELEGRAM_BOT_TOKEN` — from @BotFather.
- `TELEGRAM_ADMINS` — comma-separated Telegram user ids. Admins talk to every binding, get
  permission buttons, and are the only ones allowed to `/bind`, `/unbind`, `/allow`, `/delete`,
  `/pin`, `/unpin`, `/reload`.

Optional (all have working defaults — mention them only if asked):

- `TELEGRAM_LANG` (`en`) — initial UI language; `/lang en|ru` changes it at runtime.
- `TELEGRAM_PROJECTS_DIR` (`$HOME/projects`) — where `/bind <name>` looks.
- `TELEGRAM_LAUNCH_CMD` (`claude --permission-mode bypassPermissions`) — launch command for
  `/new` and `/resume`; channel flags are appended automatically.
- `TELEGRAM_IDLE_UNLOAD_MINUTES` (`0` = off) — stop sessions idle this long, freeing ~0.5 GB
  each; the next message resumes them with full history. `/pin` exempts a topic.
- `TELEGRAM_CONTEXT_WARN_PCT` (`80`) — warn under a reply when the context window fills up.
- `TELEGRAM_HUB_AUTOSPAWN` (`1`) — set `0` only if the hub runs as a service.
- `TELEGRAM_DEBUG_LOG` (`0`) — record all hub traffic to `screenlog.jsonl`. Off by default on
  purpose: it captures message contents.
- `OPENAI_API_KEY` — enables voice (transcribing incoming notes, speaking replies). Without it
  voice is silently off. Tuning: `STT_OPENAI_MODEL`, `TTS_OPENAI_MODEL`, `TTS_OPENAI_VOICE`,
  and `*_BASE_URL` for an OpenAI-compatible endpoint.

## No args — report status

1. Read `.env` (**mask the token** — first 10 chars, then `…`) and `bindings.json`.
2. Check the stub is registered: `claude mcp list | grep telegram`.
3. Report: token set or not, admins, current bindings, whether the hub is reachable
   (`ls ~/.claude/channels/telegram/hub.sock`).
4. Point at the first missing step — don't dump the whole setup if only one thing is absent.

## First-time setup

1. **Find the stub**:
   `ls -d ~/.claude/plugins/cache/*/telegram-tmux-channels/*/src/stub.ts | tail -1`
2. **Register it for every session**:
   `claude mcp add --scope user telegram -- bun run <that stub.ts path>`
   Needs [Bun](https://bun.sh); tmux is needed too for session control (see the README).
3. **Token** — validate the shape `/^\d+:[\w-]+$/`, then
   `mkdir -p ~/.claude/channels/telegram`, merge `TELEGRAM_BOT_TOKEN=<token>` into `.env`
   (keep existing lines), `chmod 600` it.
4. **Admin id** — ask the user for theirs ([@userinfobot](https://t.me/userinfobot) replies with
   it) and write `TELEGRAM_ADMINS=<id>`.
5. **Start a session** in a project:
   `claude --dangerously-load-development-channels server:telegram`
   The hub autospawns on the first connect — no service required.
6. **Bind from Telegram** — in the target topic or DM, an admin sends `/bind <folder>`.

If the bot will live in a group: privacy mode **off**, topics **on**, and the bot must actually
be added to the group — otherwise it sees nothing.

## Optional always-on hub

Autospawn keeps the hub up only while a session exists. To have the bot answer with nothing
running, install a service from `examples/`:

- Linux: `examples/telegram-hub.service` (systemd user unit)
- macOS: `examples/dev.windbit.claude-telegram.plist` (launchd agent)

Fill in the absolute paths inside, then enable. Whichever process holds the socket wins, so
sessions connect to the service instead of spawning their own hub.

## Gotchas

- **One token, one poller.** Two hubs on the same bot fight over `getUpdates` — the second one
  steals updates and messages go missing. If a service is running, don't start a second hub.
- **Changed the token?** Restart the hub: `systemctl --user restart telegram-hub`,
  `launchctl kickstart -k …`, or just kill it — the next session respawns it.
- **`.env` is a secret.** Keep it `600`, never paste it back into chat unmasked.
