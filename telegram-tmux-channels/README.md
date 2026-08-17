# telegram-tmux-channels

Run Claude Code or Codex from Telegram. One bot, many sessions — each forum topic is its own project.

```
You  → #frontend:  fix the login redirect
Bot  → #frontend:  Done — the guard now waits for the session. PR #481.

You  → #infra:     why is staging down?
Bot  → #infra:     Postgres hit max_connections. Raised to 200, staging is back.
```

Two topics, two folders, two independent Claude sessions. Same bot. Nothing gets crossed.

A fork of the official `telegram@claude-plugins-official`. Linux and macOS.

## Why this and not a mirror

Tools like ccgram stream the whole transcript into chat. This one doesn't: **only the final
answer or an explicit `reply` tool call** shows up; intermediate tool chatter stays in the TUI.
Your phone stays readable while the agent grinds through 40 tool calls.

What you get beyond plain messaging:

- **The CLI's own prompts become buttons.** `AskUserQuestion` and `/model` show up as real
  inline keyboards; tapping one types the answer into the session.
- **Voice both ways.** Send a voice note — it's transcribed. Ask for a spoken reply — you get one.
- **Tables and the rest of Markdown actually render.** A reply containing something plain
  Telegram formatting can't express — a table, a collapsible block, a footnote, a formula — goes
  out as a Rich Message (Bot API 10.1) and arrives as itself.
- **Live status.** Subagents, tasks, the todo list and skill calls all share ONE self-updating
  message per turn, so work in progress costs you a single notification. Backgrounded shells get
  their own, kept until the last of them finishes — they outlive the turn that started them.
- **Full session control from the phone.** Restart, compact, interrupt, switch model, peek at
  the terminal — see [Commands](#commands).

## Quick start

You need [Bun](https://bun.sh), tmux, and a bot from [@BotFather](https://t.me/BotFather).
In a group the bot needs privacy mode **off**, topics **on**, and to actually be a member.

<details>
<summary><b>Installing tmux</b> (Linux / macOS)</summary>

```bash
# Debian / Ubuntu
sudo apt install tmux

# Fedora / RHEL
sudo dnf install tmux

# Arch
sudo pacman -S tmux

# macOS — Homebrew (https://brew.sh)
brew install tmux
```

Check it: `tmux -V`. Anything from **2.9** on is fine — that's when `new-session -x/-y` landed,
which the hub uses to give detached sessions a usable size.

No `~/.tmux.conf` needed. The hub creates its sessions detached at 200×100 itself, so Claude
Code's TUI has room to render and `/screen` isn't a squashed 80×24 snapshot. Your own tmux
config is left alone — sessions are separate and named after the bound folder.

Without tmux the channel still works (messages in, replies out), but everything that drives the
terminal is gone: `/new`, `/resume`, `/restart`, `/compact`, `/screen`, `/last`, and the button
bridge for `AskUserQuestion` / `/model`.

</details>

```
/plugin marketplace add <git-url of this marketplace>
/plugin install telegram-tmux-channels@<marketplace>
/telegram:configure <bot-token>
```

`configure` registers the MCP stub, saves the token and asks for your Telegram user id
(that makes you the admin). Then start a session inside any project folder:

```
claude --dangerously-load-development-channels server:telegram
```

The dev flag is required — third-party channels aren't on Claude Code's approved allowlist.
That's a platform rule, not ours. The hub starts itself on the first session; no service to set up.

Now in Telegram: create a topic, send `/bind myproject`, and talk to it.

### Codex setup

Codex uses the same hub, MCP tools, hooks, tmux sessions and state. Installing the Codex plugin
registers its bundled Telegram MCP server automatically. For a standalone checkout without a
plugin installation, register the stub once using its absolute path:

```bash
codex mcp add telegram -- bun run /absolute/path/to/telegram-tmux-channels/src/stub.ts
```

Codex reads hooks from its own config layer, not from the plugin, so materialise them once:

```bash
python3 scripts/install-codex-hooks.py     # writes ~/.codex/hooks.json with absolute paths
```

Skip it and Codex never fires `Stop`; the hub then never learns the turn ended, so the agent's
answer stays in the terminal and Telegram sees nothing at all. On the next start Codex asks to
review the new hooks — answer **Trust all and continue**, otherwise they don't run.

Review and trust the plugin hooks, then check the MCP server with `/mcp` in Codex. Bind a topic
explicitly to Codex:

```text
/bind codex myproject
```

Legacy `/bind myproject` continues to select Claude Code. The choice is persisted per topic, so
session lifecycle commands and idle revive keep using the selected agent.

### Docker integration test

The Docker harness is the release gate: it has its own bot, Telegram state and home volume. For
the Codex half of the smoke test, set either `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` in
`docker.env`; do not mount the host's `~/.codex` into the container. The image installs both CLIs
and its entrypoint registers the same Telegram MCP stub for each.

## Commands

Sent in a bound topic or DM. These are handled by the bot and never reach the agent.

**Binding**

| Command | What it does |
|---|---|
| `/bind [claude\|codex] <folder>` | Bind this topic to a folder and agent (Claude by default) |
| `/unbind` | Unbind and kill the tmux session it created |
| `/allow <id…>` | Let another Telegram user into this binding |
| `/delete` | Unbind, tear down the worktree, and delete the topic itself — one move |
| `/pin` · `/unpin` | Protect this session from idle-unload, or release it |

**Session**

| Command | What it does |
|---|---|
| `/status` | Folder, branch, tmux name, session id, selected agent state, and supported usage/context data |
| `/resume` | Bring the session back. `/resume <id>` picks one specific past conversation — works even with tmux down |
| `/new` | Start fresh |
| `/restart` · `/stop` | Graceful restart / stop |
| `/compact` · `/clear` | Compact or clear the conversation |
| `/esc` · `/enter` | Interrupt the current turn / submit what's sitting in the input line |
| `/queue <text>` · `/q` | Hold the text until the current turn ends instead of cutting into it. A plain message reaches the agent right away, mid-turn — this one waits its turn (👌 while held). With the session idle it goes straight through |
| `/model` | The CLI's model picker, as buttons |

**Looking inside**

| Command | What it does |
|---|---|
| `/screen` | Live PNG of the terminal, refreshing every 5s, with a Close button |
| `/last` | The same view as text — useful when you just want to read it |
| `/skills` | Project skills of this folder, as tappable buttons |
| `/stand_up` · `/stand_down` | Bring this project's dev stand up or down (see [project config](#per-project-config)) |
| `/lang en\|ru` | Interface language, for the whole bot |
| `/reload` | Re-scan plugin skills and refresh the bot's command list |

Live views stop refreshing eventually — `/screen` after 3 minutes (each refresh re-uploads a photo),
`/last` after 30; the message stays.

## Who can use it

- **Admins** (`TELEGRAM_ADMINS`) talk to every binding, get permission buttons, and are the
  only ones who can bind, unbind or grant access.
- **Everyone else** must be added per topic with `/allow <id>`. No allow list means admins only.

## Trusted groups: a topic per branch

Point a group at a project once (`trusted-groups.json`) and every new topic in it becomes a
working session automatically — no `/bind` needed. Two modes:

- **folder** — all topics share one project directory.
- **worktree** — each topic gets its own git worktree and branch. Hand it a `{create, delete}`
  shell hook (e.g. a script that also provisions a per-branch database) or let it run plain
  `git worktree add`.

A new topic always asks first — mode buttons, plus **✏️ own folder** for a one-off path — so
nothing starts in the wrong directory behind your back. List more than one harness for the group
and the same message grows a toggle on top:

```jsonc
"agents": ["claude", "codex"]   // in trusted-groups.json, per group or in defaults
```

```
[ 🔄 Claude Code ]      ← tap flips it in place, no new message
[ 📁 Default folder ]
[ ✏️ Own folder ]
```

Tapping the harness rewrites that one button; tapping a mode then starts the session with
whatever harness is showing. One harness (or none listed) — no extra row, as before. A group
`cmdline` is carried into the binding only when it belongs to the chosen harness, so a Codex
topic can't inherit a `claude …` command line. Cyrillic topic names are transliterated
before they become branch and tmux-session names.

Name the new topic like one you closed months ago and the branch name collides. The bot never
reuses the old branch — it takes the next free name (`name-2`, `name-3`, …), cuts it fresh from
the base, and says so in the topic. Reusing would silently stack today's work on a month-old
state, which is exactly how a PR ends up 700 commits behind.

**Where the branch is cut from** is the project's business, so it lives in its
`.tmux-channels.json`:

```jsonc
"worktree": { "base": "dev" }              // one base — used silently
"worktree": { "base": ["dev", "master"] }  // several — the mode picker offers one button per base
```

With several bases the picker shows `🌿 worktree from dev` / `🌿 worktree from master` instead of
a single worktree button — same one tap, no extra question. Unset, the base is the branch the
main checkout happens to be on.

The bot fetches first and cuts from `origin/<base>`, so the new branch starts from the *remote*
state, not from whatever is stale on disk. **The main checkout is never touched** — no `checkout`,
no `pull`: it can stay on another branch with uncommitted work and nothing happens to it. The new
branch is created with `--no-track`, so `git push -u` later creates its own remote branch instead
of arguing with `origin/dev`. Hooks get the choice as `TELEGRAM_BASE_BRANCH`.

## Per-project config

Drop a `.tmux-channels.json` in a project root to teach the bot about that project. Both keys
are optional:

```jsonc
{
  // /stand_up, /stand_down, and the stand line in /status
  "stand": {
    "up":     "docker compose up -d && echo internal=http://localhost:8080",
    "down":   "docker compose down",
    "status": "curl -fsS localhost:8080 >/dev/null"   // exit 0 = up
  }
}
```

Print `internal=<url>` / `external=<url>` from a stand hook and the bot posts those links back.
`{branch}` and `{dir}` are substituted; hooks run with stdin closed, so nothing hangs on a prompt.

### Worktree hooks

In `worktree` mode every topic gets its own branch. By default the bot just runs
`git worktree add` — fine until a branch needs more than a directory: its own database, an
`.env`, seeded fixtures, a free port. Then hand it your own script:

```jsonc
{
  "worktree": {
    "create": "scripts/wt.py new {branch} --db clean",
    "delete": "scripts/wt.py rm {branch}"          // optional
  }
}
```

**The contract for `create` is one line: print the path of the new worktree as the last line of
stdout.** That's what the bot binds the topic to. Everything else you print is treated as log
noise, so you can be as chatty as you like above it:

```bash
#!/usr/bin/env bash
set -e
branch="$1"
dir="$HOME/worktrees/$branch"

git worktree add "$dir" -b "$branch"      # be as chatty as you like...
createdb "app_$branch"
cp .env "$dir/.env"
echo "DATABASE_URL=postgres:///app_$branch" >> "$dir/.env"

echo "$dir"                                # ...the LAST line is the path
```

How it's run:

- `sh -c` from the group's base directory, with **stdin closed** — an interactive prompt can't
  hang the topic, your script just gets non-interactive defaults.
- `{branch}` and `{dir}` are substituted in the command string; the same values also arrive as
  `TELEGRAM_TOPIC_BRANCH` and `TELEGRAM_GROUP_DIR` environment variables, which is easier to
  quote correctly.
- A non-zero exit aborts the topic setup and the error text goes to the chat — nothing is bound
  to a half-built worktree.
- `delete` runs on `/unbind` and `/delete`. Skip it and the bot falls back to
  `git worktree remove` — which will leave your database behind, so define it if you created one.
- A project's own `.tmux-channels.json` wins over the group-level hook in `trusted-groups.json`:
  one group can hold several repos, each with its own way of making a branch.

## Idle-unload: stop paying for sessions you're not using

An idle Claude session still holds ~0.5 GB with its MCP children. Set
`TELEGRAM_IDLE_UNLOAD_MINUTES` and the bot gracefully stops sessions that have gone quiet —
no messages, no terminal activity, not mid-turn. Your next message brings the session back with
its full history (`--resume`), announced by one quiet line.

`/pin` exempts a topic. Unset (the default) means the plugin never stops anything.

## Configuration

Environment, in `~/.claude/channels/telegram/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token (required) |
| `TELEGRAM_ADMINS` | — | Admin user ids, comma-separated |
| `TELEGRAM_LANG` | `en` | Initial UI language (`en`/`ru`); `/lang` overrides at runtime |
| `TELEGRAM_PROJECTS_DIR` | `$HOME/projects` | Where `/bind <name>` looks |
| `TELEGRAM_LAUNCH_CMD` | `claude --permission-mode bypassPermissions` | Claude launch command; Codex defaults to `codex` and learns its live argv |
| `TELEGRAM_IDLE_UNLOAD_MINUTES` | `0` | Idle minutes before a session is stopped; `0` disables |
| `TELEGRAM_MEMORY_MAX` | — | Per-session memory cap (`6G`) via `systemd-run --scope`, so a runaway session dies alone instead of OOM-ing the host. Linux/systemd only |
| `TELEGRAM_CONTEXT_WARN_PCT` | `80` | Warn under a reply once the context window is this full; `0` disables |
| `TELEGRAM_HUB_AUTOSPAWN` | `1` | `0` if you run the hub as a service instead |
| `TELEGRAM_DEBUG_LOG` | `0` | `1` records all hub traffic to `screenlog.jsonl` (off by default — the plugin logs nobody's messages) |
| `OPENAI_API_KEY` | — | Enables voice; without it voice is silently off |
| `STT_OPENAI_MODEL` | `gpt-4o-transcribe` | Transcription model |
| `TTS_OPENAI_MODEL` | `gpt-4o-mini-tts` | Speech model for `reply(voice: true)` |
| `TTS_OPENAI_VOICE` | `onyx` | Voice |
| `STT_OPENAI_BASE_URL` · `TTS_OPENAI_BASE_URL` | OpenAI | Point at any OpenAI-compatible endpoint |

State lives next to it: `bindings.json` (topic → folder, hot-reloaded) and `known-chats.json`
(every chat and forum topic the bot has seen, so ids are one `cat` away).

## Keeping the bot up without a session

Autospawn keeps the hub alive only while at least one session exists. If you want the bot to
answer when nothing is running, install a service from `examples/` — `telegram-hub.service`
for systemd, `dev.windbit.claude-telegram.plist` for launchd. Whichever holds the socket wins,
so sessions will connect to your service instead of spawning their own hub.

## How it works

Two processes and a Unix socket:

- **Hub** (`src/hub.ts`) — the only thing holding the bot token and polling Telegram. It maps
  chat → binding → the live session in that folder, drives tmux, and renders buttons. Starts
  itself when the first session connects.
- **Stub** (`src/stub.ts`) — a tiny MCP server inside each Claude or Codex session. Tells the hub where
  the session lives (folder, tmux pane, pid) and relays `reply` / `react` / `edit_message`.

Two details worth knowing, because they explain most of the behaviour:

- **The picker bridge is a screen scraper.** The hub reads each tmux pane on a timer; when it
  recognizes a TUI prompt, it posts buttons, and a tap is replayed as real keystrokes. There's
  no API for those prompts — this is a diff of the terminal.
- **Agents write Markdown; the hub picks how to send it.** Most replies are rendered to Telegram
  HTML as they always were. A rich message is used only when `needsRich()` sees something that
  conversion would lose, because a rich message carries no plain `text` field — a client too old
  to know the type shows nothing at all, so it has to earn that risk. The agent doesn't choose:
  the decision is a function of the text, and a second tool would only be a second thing to
  forget. `format: 'rich'` forces it, mostly to get the 32768-character limit.
  Two things the rich parser does that cost you words, both found against the live API and now
  escaped up front: an unsupported HTML tag is dropped *silently* (`<Foo>` and no error to catch),
  and `#5` becomes a heading though GFM wants a space after the hashes.
- **Status messages are edited, not re-sent.** One message per turn accumulates subagents, tasks,
  todos and skill calls, with finished items marked ✅ instead of vanishing, so the message ends
  up being the history of that turn.
- **Background shells are tracked on their own clock.** They outlive their turn, so they get a
  separate message that lives until the last shell in the run finishes — putting them in the turn
  bubble meant either losing the line at the next turn or re-posting every unfinished shell into
  each new bubble. There is no "background shell finished" hook, but the `Stop` payload lists the
  shells still running: one we listed that `Stop` no longer names has finished. Claude Code feeds
  each completion back as a prompt, so another `Stop` follows within seconds and flips the line.

### Debugging

Set `TELEGRAM_DEBUG_LOG=1` and everything through the hub lands in `screenlog.jsonl` as one
timeline: pane snapshots, inbound updates, and the **final** payload actually sent to Telegram.
That last part matters — a `reply` call only returns `sent, id`, so when you're chasing "what
did the user actually see", read the log instead of guessing. Ring buffer, last 1000 entries.
