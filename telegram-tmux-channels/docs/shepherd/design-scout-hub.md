# Scout: telegram-tmux-channels hub (homelab)

Root: ~/projects/homelab/apps/claude-plugins/telegram-tmux-channels (all paths below relative to it; hub.ts = src/hub.ts, 6535 lines; ~12k lines src total).
State dir: ~/.claude/channels/telegram (override: TELEGRAM_STATE_DIR, src/paths.ts:4). Live unit: ~/.config/systemd/user/telegram-hub.service -> `/usr/local/bin/bun run .../src/hub.ts`, Restart=always, running since 2026-11-09, PID 533813, 78 MB.

## 1. Architecture

Processes
- Hub (src/hub.ts): single process; only holder of bot token; grammY long-poll (pollForever hub.ts:6481); listens on unix socket `hub.sock` (listenForStubs hub.ts:809, chmod 0600). Writes bot.pid (claimPollerSlot :288, SIGTERMs any stale poller). start() :6455 is the only side-effecting entry (import is side-effect free, tests/hub-importable.test.ts).
- Stub (src/stub.ts): tiny MCP server living INSIDE every Claude/Codex session. Finds agent ancestor pid (src/proc.ts), reads cwd via /proc, env TELEGRAM_BINDING_KEYS + pane id (stub.ts:61-77), connects to hub.sock, sends `subscribe` with SessionInfo {agent,pane,pid,cmdline,cwd,bindingKeys} (src/protocol.ts:4). Exposes MCP tools reply/react/download_attachment/edit_message (stub.ts:241-325). Autospawns a hub if socket absent (TELEGRAM_HUB_AUTOSPAWN, set 0 by the systemd route / docker).
- Multiplexer (src/mux/{tmux,herdr}.ts): all agents are windows of ONE tmux session named `agents` (mux/tmux.ts:6), 200x100 manual size. Live: 7 windows (e.g. homelab-vpn, agentek-console-bitrix-mcp). TELEGRAM_MUX=herdr alternative.
- Launcher `bin/tgc-run` (symlinked to ~/.local/bin by installLauncher, src/launch.ts:40) -> src/launch-cli.ts builds `cd dir; export TELEGRAM_BINDING_KEYS...; exec <argv>` from bindings.json (adapter.buildLaunch). Hub prints only `tgc-run <key> new|resume|fork [id]` into the pane (launchLine launch.ts:15).

Topic -> pane mapping
- Key = "<chat_id>/<thread_id>" (src/bindings.ts messageKey/keyToTarget). bindings.json[key] = {dir, tmux, agent?, cmdline, sessionId, mode, allow, hookBranch, pinned, unloaded, closed, standAsleep} (BindingEntry src/registry.ts:19-37). tmux window name = binding.tmux (sessionName hub.ts:3175; slug of project+topic via tmuxSessionName tmux-ops.ts:139; freeTmuxName avoids collisions).
- Router (src/router.ts): Map<socket, SessionInfo>; byBindingKey(key) is the ONLY way a message finds its live session (connsForBinding hub.ts:3100; deliberately no cwd fallback). verifyClaimedKeys (hub.ts:2882) drops bindingKeys whose registered dir != stub cwd (realpath compared).
- Live: 34 bindings (1 codex), dirs = homelab, agentek-school, agentek-console + 5 `.claude/worktrees/<slug>` worktrees, delovar-ai. Several topics may share a dir (mode folder); sessionId uniqueness enforced per dir (sessionOwner registry.ts:105).

Message injection (inbound), handleInbound hub.ts:4231 -> deliverMessage hub.ts:4613
- Claude: "nativeInboundTransport" = hub sends `{op:'event',kind:'message',content,meta}` over socket; stub forwards as MCP notification `notifications/claude/channel` (stub.ts:97-105) (needs `--dangerously-load-development-channels server:telegram`). Stub acks (`ack` op) so hub knows delivery succeeded; hub waits for pane "ready" first (waitPane/PANE_READY_MS).
- Codex: no channel; hub types the envelope into the TUI with tmux send-keys (typeInboundUnlocked hub.ts:4569, submitDraft retries Enter until draft gone); delivery verified via rollout transcript with a delivery_id needle.
- Slash text ("/skill args") is typed into the pane as a real command (injectSkillToPanes, hub.ts:~4400). Envelope: src/inbound-envelope.ts; meta carries chat_id,message_id,user,user_id,ts,topic_id,reply_to_*.
- watchDelivery (src/delivery.ts, hub.ts:4704): checks transcript saw the message, resends ONCE, then posts "delivery lost".
- No live session: message enqueued (enqueueForTopic hub.ts:3869, persisted in hub-state.json, 6h expiry MAX_HOLD_MS), spawnSession, flushQueued on stub subscribe. Message gets reaction 😴 queued, 👀 delivered.

Replies out
- Agent calls MCP tool `reply` (chat_id, thread_id, text md, files, voice) -> stub RPC -> hub handleRpc hub.ts:415 -> doReply :519 (assertBoundChat checks chat belongs to session's bindings). Markdown->HTML or Rich Message (src/md-html.ts).
- Fallback: if agent ends a turn without calling reply, Stop hook "turnend" triggers forwardFallbackReply (hub.ts:1935) reading the transcript (pendingAnswer in hub-state.json).
- Hooks (hooks/hooks.json -> stub.ts hook mode, src/hook-normalize.ts) feed ops subagent/task/todo/skill/bg/compaction/turnfail (protocol.ts) -> one self-editing status message per turn.

Harnesses: Claude Code and Codex only (src/agents/{claude,codex}.ts, AgentAdapter in agents/types.ts, selectable per binding `agent`; `/bind codex <folder>`). CCGram-style gemini/pi etc not supported (docs/agent-feature-matrix.md).

Lifecycle
- Create: `/bind`, or trusted-group auto-topic: forum_topic_created -> mode picker (folder/worktree/own folder) -> runAutoTopic hub.ts:3997 (resolveModeDir creates git worktree via hook or `git worktree add`, src/dir-resolve.ts) -> writes binding -> spawnSession hub.ts:3484 (ensureTmuxSession, typeLine tgc-run ..., armBringUp watchdog; if recent sessions exist in dir it first asks which to resume).
- Restart: `/restart` or `tgc-ctl restart <key>` -> restartLiveSession hub.ts:4868 (stopSession then tgc-run resume with binding.sessionId); no live session -> reviveForControl :4923.
- /new, /resume [id], /fork (new topic via bot.api.createForumTopic hub.ts:5221, new binding, `--fork-session`), /close, /compact, /clear, /esc, /queue, /pin, /unbind, /delete (tears down worktree via hook), /restart_all.
- Idle-unload (TELEGRAM_IDLE_UNLOAD_MINUTES, maybeIdleUnload hub.ts:2630, isIdleToUnload tmux-ops.ts:151): graceful stop, binding.unloaded=true; next message revives with --resume. Held if pinned or a cron/loop exists (unloadHold :2601). Boot: reviveBoundSessions hub.ts:3615 re-launches sessions whose tmux died (reboot) unless closed/unloaded.
- Dead resume ids (jsonl cleaned) -> falls back to fresh start (spawnSession ~:3510).
- Session id kept honest: hook events carry sessionId -> syncSessionId hub.ts:2909 (ignores headless -p runs); launch capture for fresh starts; incoming-envelope correlation.

Persistence (state dir)
- bindings.json (registry.ts; hot-reloaded each call via loadBindings, atomic tmp+rename saveBindings, mode 0600; unknown fields preserved; malformed rows rejected individually). Example live entry:
  `"-1004495746357/6865": {"dir":"/home/user/projects/homelab","tmux":"homelab-ierarkhiya-konteksta","cmdline":["claude","--permission-mode","bypassPermissions","--dangerously-load-development-channels","server:telegram","--resume","6436d1a1-..."],"mode":"folder","sessionId":"6436d1a1-...","unloaded":true}`
- hub-state.json (src/state-repo.ts: pending answers, queued inbound, fallbacks, pickers, interactions), known-chats.json (chat/topic titles), session-topics.json (sessionId->key, survives unbind), trusted-groups.json (per-group {dir, modes, agents, cmdline, exclude, hook}), codex-index.json, limits/, screenlog.jsonl (only with TELEGRAM_DEBUG_LOG=1), inbox/ (downloaded attachments), .env (token/admins).
- Per-project: <project>/.tmux-channels.json (stand up/down/sleep/wake, worktree.base, hooks).

Locking / turn-taking / busy vs idle
- updateLanes (src/update-lanes.ts): serial per-topic lane for Telegram updates, parallel across topics. paneInput lanes (hub.ts:~360): anything typing into a pane takes the pane in turn (typeInbound runs under paneInput.run).
- spawningBindings/settingUp/pendingModeChoice => isComingUp(key) hub.ts:3844 -> inbound is queued rather than delivered. flushing set guards single drain.
- Claude is NOT blocked while busy: plain message is injected right away mid-turn (Claude queues it, "ctrl+x ctrl+s to send now"; /now sends it). `/queue` holds until turn end: keyIsWorking hub.ts:2466 = subagent/status state live (keyIsBusy :1412) OR pane scrape paneIsWorking (tmux-ops.ts:63, regex of spinner "…(  <digits>" in last 8 lines; pollScreens :2484 captures panes every TELEGRAM_SCREEN_POLL_MS=300ms into lastPaneText). Codex: if modal/picker open, deliverMessage returns 0 -> held (hub.ts:4551-4560).
- Turn end signal = Stop hook (`subagent action:turnend`), failure = StopFailure (`turnfail`).

## 2. Control surface

Existing:
- `tgc-ctl restart <chat_id/thread_id>` (bin/tgc-ctl -> src/ctl.ts): NDJSON `{op:'control',id,command:'restart',key}` over hub.sock, reply `{op:'result',ok,result|error}`; handleControl hub.ts:4895. ONLY `restart` exists (ctl.ts:6 COMMANDS).
- Unix socket protocol (src/protocol.ts) is the only IPC; no HTTP API, no auth beyond 0600 file perms. Ops: subscribe, rpc(reply/react/edit_message/download_attachment/permission_request), subagent/task/skill/todo/bg/compaction, ack, control.
- MCP tools exposed to sessions: reply, react, download_attachment, edit_message (stub.ts:241). No tool to list sessions, spawn sessions, or message another session.
- Telegram commands (admin-only for bind etc.) are the rich surface; Cyrus has no handle on them except by impersonating a user (not possible with bot).

No existing "spawn session" API callable from another process. In-process functions: spawnSession(key, binding, mode, notify) hub.ts:3484; runAutoTopic :3997; deliverMessage(key,dir,payload,needle) :4613 (needs HubToStub event + armPending); handleInbound(Inbound) needs a grammY ctx (not synthesizable cheaply); createForumTopic only used in /fork (hub.ts:5221).

Cleanest seam (recommendation): add new `control` commands to the existing socket protocol, same style as `restart` (protocol.ts ControlCommand union + handleControl switch + ctl.ts COMMANDS). Cyrus then calls the socket directly (NDJSON, ~10 lines) or shells out to tgc-ctl. Suggested commands:
 (a) `send <key> <text> [--queue]`: build meta {chat_id, topic_id, user:'cyrus', ts...}, enqueueForTopic-or-deliverMessage. Cleanest = reuse handleInbound path by fabricating a minimal Inbound, OR call the tail of handleInbound (hub.ts:4337-4562: liveOrReconnecting -> revive+queue -> deliverMessage); factor that tail into `deliverToKey(key, text, meta)`. Wait-for-idle semantics: use keyIsWorking(key,dir) to choose queue vs now.
 (b) `spawn --dir <worktree> --chat <id> --title <name> [--agent claude|codex] [--prompt text]`: createForumTopic(chat, title) -> reg[key]={dir,tmux:freeTmuxName(...),agent,cmdline,mode:'folder'} (copy block hub.ts:5233-5246 of /fork) -> saveBindings -> spawnSession(...,'new') -> waitForBinding -> optional first message via deliverMessage (fork code hub.ts:5258-5275 is a ready template incl. waitPaneReady).
 (c) `list [--cwd p] [--branch b]`: iterate loadBindings() + router; return JSON {key,dir,agent,sessionId,live,pane,tmux,working}. Branch must be computed (see 3).
Cheaper alternative with zero hub code: Cyrus edits bindings.json itself (hot-reloaded, hand-edit documented) + `tmux`/tgc-run — but then no Telegram topic gets created and queue/liveness bookkeeping is bypassed; not recommended except for lookup (read-only bindings.json lookup by dir works today).
Gotcha: ControlCommand handlers must return a string; handleControl rejects if spawningBindings has key. Topic creation needs the bot (hub only).

## 3. Does hub know cwd / branch / worktree?
- cwd: yes. binding.dir (bindings.json) for every topic; live session.cwd from stub (protocol.ts SessionInfo.cwd, = agent's /proc cwd). Worktrees are just separate dirs: `/home/user/projects/agentek-console/.claude/worktrees/<slug>` (hook-created) or `<project>--<branch>` sibling (plain worktree, dir-resolve.ts worktreeDirFor).
- Branch: NOT stored anywhere. Computed on demand only for /status: gitBranch(dir) = `git -C dir branch --show-current` (dir-resolve.ts:~20, called hub.ts:5439). `hookBranch` in binding (registry.ts:27) is the branch the worktree hook created (only set when a hook created it). `mode` = folder|worktree... records how dir was made. isLinkedWorktree / isPlainWorktreeDir helpers (dir-resolve.ts:146+) detect worktrees via git-dir vs common-dir.
- => PR-branch -> session lookup must be done by Cyrus (or a new `list` command): for each binding run `git -C dir branch --show-current` and compare to PR head ref; or match on worktree path. Topics sharing a dir (mode folder) are ambiguous for branch matching.
- Topic title -> slug -> branch name rules (README "Naming"): title ending `#name` sets branch exactly.

## 4. Known bugs / relevant behavior
- "Иерархия контекста" = topic -1004495746357/6865, dir /home/user/projects/homelab, tmux homelab-ierarkhiya-konteksta, unloaded:true. CURRENT cmdline in bindings.json is healthy (`claude ... --resume 6436d1a1-...`); no binding currently holds `claude mcp list`. Root cause is still present in code: learnCmdline (hub.ts:3045-3090). A stub with NO bindingKeys (e.g. MCP stub spawned by `claude mcp list`, which starts every configured MCP server incl. telegram stub with claude ancestor argv `claude mcp list`) is "unowned": keys = keysForDir(reg, cwd) = EVERY binding sharing that dir (homelab has ~6+ topics), and mayLearn(owned=false, same agent) (agents/index.ts:36) allows argv overwrite. The only guard is isHeadlessArgv (tmux-ops.ts:208) = argv contains -p/--print; it does NOT catch subcommands like `mcp list`, `doctor`, `plugin ...`. Fix candidates: in learnCmdline require owned (session.bindingKeys) for argv learning, or treat any argv with a non-flag first arg after `claude` (mcp/doctor/update/...) as headless; also unverified-keys log "subscribe: dropped unverified keys [...] for cwd=/tmp/pp-research" shows stray stubs reach the hub regularly. Related past fixes: 79a176b, 6c0498c, 454baec, fd81e31 (git log). Backups of bindings.json exist (.bak-*) in state dir. Relevant to Cyrus: do NOT run `claude`/`codex` subcommands or `claude -p` in a bound dir without TELEGRAM_BINDING_KEYS unset-safe; headless -p is ignored for sessionId and cmdline.
- Stall/heartbeat: there is no per-session heartbeat/stall detector. Mechanisms present: (1) Telegram long-poll stall: getUpdates gets its own AbortSignal.timeout (timeout+15s) so dead TCP reconnects (hub.ts:~340, POLL_GRACE_MS; commits fd319c5, c4ebf69 "restart hub when long-poll stalls", latest HEAD fd319c5). 409 conflict retry up to 8 then exit(1). (2) Bring-up watchdog: armBringUp/reportStuckBringUp hub.ts:1015-1050 posts "bring-up stuck" if no stub subscribe within BRING_UP_GRACE_MS. (3) Stub socket close => notifyUnexpectedDeath hub.ts:782 (💀 notice, unless expectedDisconnect). (4) Delivery watchdog (resend once, then warn). (5) Auto-ack of startup trust prompts. A hung-but-connected agent (no output, stub alive) is not detected; paneIsWorking is a regex on the spinner only.
- Edited-message duplication: no handler for `edited_message` (bot.on list hub.ts:5897-6070 is only message:*, callback_query, forum events; grammY `message:text` does not match edited updates), so a user's edit in Telegram is silently ignored (not re-delivered, not duplicated). update-lanes.ts:25 only uses edited_message to pick a lane. I found no code/test/doc about an edited-duplication bug; if this refers to agent-side edit_message (doEdit hub.ts:647) or editable status posts (src/editable-post.ts, tests/editable-post.test.ts), I did not trace a defect. Ask the user which symptom.
- Other: hub.ts is a 6.5k-line monolith; user-facing strings are Russian/English via src/i18n. Logs via journalctl --user -u telegram-hub.

## 5. Tests / dev mode
- Run: `cd <root> && bun test` (package.json "test"; `bun run check` = tsc --noEmit + tests). 393 tests / 43 files pass in ~4s on homelab (I ran it; live bindings.json/hub-state.json mtimes unchanged, tests use mkdtemp state dirs via TELEGRAM_STATE_DIR). Covers parsers, delivery scenarios (tests/delivery-scenarios.test.ts), launch argv (launch.test.ts), registry/state-repo, session-topics, codex adapters, hub import smoke. Fixtures in tests/fixtures, tests/e2e-fixtures/codex-project.
- Isolated dev hub (does not disturb live): needs a separate bot token (one getUpdates per token, claimPollerSlot kills the other poller) + separate state dir + separate tmux server:
  `TELEGRAM_STATE_DIR=/tmp/hubdev TELEGRAM_BOT_TOKEN=<test bot> TELEGRAM_ADMINS=<id> TELEGRAM_HUB_AUTOSPAWN=0 TELEGRAM_PROJECTS_DIR=... bun run src/hub.ts`. State dir isolates hub.sock, bot.pid, bindings, .env. CAVEAT: tmux session name `agents` is hardcoded (mux/tmux.ts:6) and ~/.local/bin/tgc-run,tgc-ctl symlinks are (re)written by installLauncher on start (same source, harmless on same checkout; would point at test checkout otherwise). Also stub reads hub socket from the STATE_DIR env of the agent process, so launched agents inherit; to isolate tmux use `tmux -L` is NOT supported - run on a separate user/container, or set TELEGRAM_MUX=herdr with a different TELEGRAM_HERDR_SESSION.
- Officially supported isolation = Docker harness (docker-compose.yml, Dockerfile, docker.env with test bot token/admin; `docker compose up -d claude-tmux`; docs/testing/README.md methodology; scripts/reset-stand.sh, scripts/smoke.py drive it as a Telegram user; "release gate"). Compose sets TELEGRAM_HUB_AUTOSPAWN=0, mounts plugin source.
- For Cyrus integration testing without Telegram: a unit test against a hub function factored out (like delivery-scenarios) plus socket-level test with TELEGRAM_STATE_DIR=tmp (see inbound-envelope.test.ts:44 pattern).

## Pointers
README.md (commands, config table, "How it works" l.462), docs/agent-feature-matrix.md, docs/testing/{README,feature-map,regression-checklist}.md, CLAUDE.md (only a Telegram bold-header formatting rule).
