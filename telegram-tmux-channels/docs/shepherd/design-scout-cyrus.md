# Scout: Cyrus fork on homelab (2026-11-11)

Paths below are on `homelab`, repo root `~/projects/cyrus` (R). `P` = `R/packages`. `EW` = `P/edge-worker/src/EdgeWorker.ts`.

## 0. Verdict (read this first)
Cyrus has had ZERO sessions since ~2026-09-21 for three stacked reasons, and the GitHub path is a poor router as-is:
1. GitHub App `agentek-bot` (id 4594901) is subscribed ONLY to `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `repository`
   (verified via GET /app with app JWT). No pull_request, check_run, check_suite, push, status -> those events never leave GitHub.
2. nginx allowlist (`/etc/nginx/snippets/webhook-allow-github.conf`, snapshot 2026-08-14) is stale: current api.github.com/meta `hooks` adds
   9.234.106.48/28, 9.234.98.160/28, 9.234.98.176/28. GitHub now delivers mostly from 9.234.x -> nginx 403. /cyrus/github-webhook totals (all rotated logs):
   1096x200, 419x403. On 10.11 ~85% of Cyrus deliveries were 403 (e.g. 140.82.115.x=200 only 5; 9.234.x=403 ~48). App delivery log (last 100): 64 ok, 31 x 403, 1 x 502.
   Same list guards /mirror/github-webhook (homelab-admin): 1139x403 vs 1622x204 on 10.11.
3. Even delivered events are dropped by code: issue_comment needs literal `@agentek-bot` in body (EW:1274-1283); pull_request_review needs state==changes_requested
   (EW:1243-1251) AND PR author == GITHUB_BOT_USERNAME (`agentek-bot`) when prReviewOwnPullRequestsOnly=true (EW:1262-1272). PRs are opened by `thomas5788`, so always dropped.
   Journal 09.11-10.11: 173 "Received" lines (168 issue_comment, 7 pull_request_review... plus 2 on 08.11), 0 "Processing GitHub webhook". All drops are log level debug (invisible; no CYRUS_WEBHOOK_DEBUG/log level set).
   Last session created ~2026-09-21 (agentek-console#853); state file savedAt 2026-11-01; state has 9 sessions.
No errors in journal. Service up since 09.11 14:24 MSK (restart). Version 0.2.68, listens 0.0.0.0:3456 (nginx proxies 127.0.0.1:3456).

## 1. Package layout, webhooks
Monorepo (pnpm 10.33.1, workspace `apps/*`, `packages/*`): apps/cli (`cyrus-ai` bin, entry apps/cli/src/app.ts), apps/f1 (test-drive harness);
packages: core, edge-worker (the brain, EdgeWorker.ts 7513 lines), claude-runner, codex-runner, cursor-runner, gemini-runner, simple-agent-runner,
github-/gitlab-/linear-/slack-event-transport, config-updater, mcp-tools, cloudflare-tunnel-client.

Receipt (single Fastify server, SharedApplicationServer, port CYRUS_SERVER_PORT=3456):
- GitHub: `P/github-event-transport/src/GitHubEventTransport.ts` `register()` :110 -> POST /github-webhook, rawBody:true.
  Mode chosen at EW:902-917: signature if CYRUS_HOST_EXTERNAL=true && GITHUB_WEBHOOK_SECRET set (our case, log "signature mode"), else proxy (Bearer CYRUS_API_KEY).
  Signature: HMAC-SHA256 of rawBody vs `x-hub-signature-256`, timingSafeEqual: GitHubEventTransport.ts:147-189, :318-333. IP allowlist optional (:153) - disabled by WEBHOOK_IP_VALIDATION=false.
- Event whitelist: GitHubEventTransport.ts:242-251 -> only issue_comment, pull_request_review_comment, pull_request_review, push; anything else = 200 {ignored:true} + debug log.
  Action filter :259-278: push always; pull_request_review only `submitted`; the rest only `created`.
  Types: types.ts:62 `GitHubEventType`, payload interfaces types.ts:202-286.
- Emits "event" (legacy, still the one that does the work) and "message" (translated InternalMessage via GitHubMessageTranslator.ts; handleSessionStartMessage/handleUserPromptMessage in EW:3312-3340 are logging-only TODO stubs).
- Wiring: EW:919-964 (event -> handleGitHubPushWebhook for push, else handleGitHubWebhook).
- "Not a PR -> drop": EW:1216-1219 `isCommentOnPullRequest` (github-webhook-utils.ts:211, checks issue.pull_request). Other gates in handleGitHubWebhook (EW:1209-1590): bot self-comment skip :1233, review state :1243, prReviewTrigger :1254, own-PRs-only :1262, @mention :1274.
- Dedup: NONE. No delivery-id cache in transport. Session id = `github-${deliveryId}` (EW:1473); GitHub redelivery reuses same GUID but nothing checks it. Concurrent-branch check only warns (EW:1456-1462).
- Linear: `P/linear-event-transport/src/LinearEventTransport.ts` POST /linear-webhook (:102) + deprecated /webhook; `linear-signature` HMAC (:151). Direct mode (LINEAR_DIRECT_WEBHOOKS=true).
- Also gitlab (/gitlab-webhook, EW ~1995-2240, near-copy of the github handler), slack (/slack-webhook). Extra routes: /status, /version, /mcp/cyrus-tools, /api/update/*, /callback.
- Public path: nginx wh.lab.windbit.dev `/cyrus/github-webhook` -> 127.0.0.1:3456/github-webhook (homelab repo hosts/homelab/reverse-proxy/nginx/sites-available/wh.lab.windbit.dev.conf), includes the stale allowlist snippet.

## 2. Runner ("harness") abstraction
- Interface `IAgentRunner`: `P/core/src/agent-runner-types.ts:223` - supportsStreamingInput, start(prompt), startStreaming?(prompt), addStreamMessage?(text), completeStream?, isStreaming?, stop(), interrupt?, isWarm?, getPendingWork?, isRunning(), getMessages() (+ events via config callbacks). Config: `AgentRunnerConfig` :444 (workingDirectory, allowedTools, resumeSessionId, systemPrompt, mcp, hooks...).
- Implementations: ClaudeRunner (P/claude-runner/src/ClaudeRunner.ts; Agent SDK `query`, resume at :706, startStreaming :430, addStreamMessage :437, session_id captured :788), CodexRunner, CursorRunner, GeminiRunner (+ Simple*Runner variants for one-shot).
  Factory: `createRunnerForType` EW:5352 (switch claude|gemini|codex|cursor). Type enum: core/src/config-schemas.ts:7 `RunnerTypeSchema`; selection by labels/config `defaultRunner` (config-schemas.ts:367, RunnerSelectionService.ts). Runner config assembly: `buildAgentRunnerConfig` EW:~6450 + RunnerConfigBuilder.ts.
- Start/resume: new GitHub session -> `runner.start(taskInstructions)` (EW:1570) with resumeSessionId undefined (EW:1540) - GitHub path never resumes a prior claude session. Linear path: `resumeAgentSession` EW:~7255-7330 picks `session.claudeSessionId|geminiSessionId|codexSessionId|cursorSessionId` and calls startStreaming.
- Inject prompt into running session: `handlePromptWithStreamingCheck` EW:~7060-7100: if runner.isRunning() && supportsStreamingInput -> addStreamMessage(prompt), on throw fall back to resume. Same pattern for base-branch push notifications (handleGitHubPushWebhook EW:1598-1690, finds sessions via AgentSessionManager.getSessionsByBaseBranch :1424).
- Worktrees: GitService.createGitWorktree (P/edge-worker/src/GitService.ts:580; single repo -> createSingleRepoWorktree :702) at `<repo.workspaceBaseDir>/<issue.identifier>`; GitHub path via createGitHubWorkspace EW:1777 with synthetic identifier `PR-<n>` -> ~/cyrus-workspaces/<repo>/PR-<n>. Existing worktree for branch reused (findWorktreeByBranch GitService.ts:~347). NB state shows some old sessions with workspace = ~/projects/agentek-console/.claude/worktrees/... (branch already checked out elsewhere).
- Persisted state: `~/.cyrus/state/edge-worker-state.json` (v4.0, PersistenceManager core/src/PersistenceManager.ts:85-120; written by EW.savePersistedState :6868). Keys: agentSessions{id->{issueContext, issue{id,identifier,branchName}, repositories[{repositoryId,branchName,baseBranchName}], workspace{path,isGitWorktree}, claudeSessionId, status, metadata}}, agentSessionEntries, childToParentAgentSession, issueRepositoryCache. GitHub session key = `github:<owner/repo>#<pr>` (extractSessionKey utils:223). Per-session transcripts: ~/.cyrus/logs/<repo>#<pr>/session-<claudeId>-<ts>.{jsonl,md}.
- Not a pluggable-by-config thing: runners are in-process Node classes. No HTTP/CLI runner exists.

## 3. Where to add things
(a) New GitHub events (check_run/check_suite/pull_request closed|synchronize/mergeable conflicts):
 1. GitHub App settings: subscribe events + permissions (checks:read, pull_requests:read already write, statuses/actions:read optional) - needs manual approval of new perms on install. NOT done.
 2. Transport whitelist + action filters: GitHubEventTransport.ts:242-278; add to GitHubEventType (types.ts:62) and payload types (types.ts ~200-286); extractors in github-webhook-utils.ts (head.ref available directly in check_run.pull_requests[].head.ref / check_suite.head_branch / pull_request.head.ref).
 3. Dispatch in EW:930-952 (the "event" listener) - add a branch before handleGitHubWebhook, like the `push` branch. This is the cleanest hook point for a router: bypass sessions entirely.
 4. For `issue_comment` on PR without @mention: relax gate at EW:1274; PR-author gate at EW:1262 (isSameGitHubLogin vs thomas5788, or drop the check since owner lookup replaces it). issue_comment payload lacks PR head ref: use fetchPRBranchRefs EW:~1716 (GET /pulls/n via app token).
(b) External-runner: simplest = implement `IAgentRunner` (start/stop/isRunning/getMessages/supportsStreamingInput=false/addStreamMessage) that POSTs to hub HTTP/CLI, add "external" to RunnerTypeSchema (config-schemas.ts:7) and a case in createRunnerForType (EW:5352) -> but the whole session machinery (worktree creation, prompts, GitHub reply posting postGitHubReply EW:1912) then still runs. Leaner (recommended, "ponytail"): a new small module `EventRouter` called from the EW:930 listener that: normalizes event -> {repo, prNumber, branch, kind, summary text} -> POST to hub (`/route` with branch, repo, pr, event, text) -> hub injects into the tmux Claude session owning branch. No Cyrus session, no worktree, no runner. Fork diff then ~150 lines in github-event-transport + one file in edge-worker.
(c) branch -> owner: Cyrus has no such mapping for external sessions. Only agentSessions[].issue.branchName / repositories[].branchName (getActiveSessionsByBranchName AgentSessionManager.ts:1412). Put the map in the hub (branch|PR# -> Claude session/tmux window, registered when the session opens the PR); Cyrus just forwards `repo, head.ref, pr number, author`. Filter "author == thomas5788" at the router (payload pull_request.user.login; for check_run use PR via API).

## 4. Why zero sessions 11.10-11.11
See section 0. Evidence: journalctl --user -u cyrus.service (cat): 09.11: 87 Received, 10.11: 86; types only issue_comment/pull_request_review; "Processing GitHub webhook"=0. Config: GITHUB_BOT_USERNAME=agentek-bot (~/.cyrus/.env), prReviewOwnPullRequestsOnly=true. 11.11 (till 02:22): 4 x 200, 1 x 403 at nginx. App deliveries (GET /app/hook/deliveries): last 100 over 10.11 10:20Z-23:17Z: issue_comment/created 64x200 30x403 1x502; pull_request_review submitted 3x200 1x403, dismissed 1x200. No 5xx from Cyrus, no ERROR lines. (Also: CYRUS_HOST_EXTERNAL=true & WEBHOOK_IP_VALIDATION=false are set; sandbox disabled.) Fix for 403s: refresh snippet from `curl -s https://api.github.com/meta | jq -r '.hooks[]'` (or drop allowlist; HMAC is authoritative) - NOT changed.

## 5. Build / test / second instance / fork diff
- Build: `cd ~/projects/cyrus && pnpm install && pnpm build` (pnpm -r build; edge-worker: tsc + copy-prompts). Service: `systemctl --user restart cyrus` (~/.local/bin/cyrus symlinks into apps/cli/dist). Tests: `pnpm test` (vitest per package), `pnpm --filter cyrus-edge-worker test:run` (name may be cyrus-edge-worker; check package.json), `pnpm typecheck`, `pnpm lint` (biome). Existing tests for the fork: packages/edge-worker/test/EdgeWorker.pr-review-own-prs.test.ts (251 lines - good template for handleGitHubWebhook tests). Husky + lint-staged run biome on commit.
- Second instance: CLI flag `--cyrus-home <path>` (apps/cli/src/app.ts:49) + env `CYRUS_SERVER_PORT=3457` + its own `<home>/.env` and `<home>/config.json`, e.g.
  `CYRUS_HOME=/tmp/cyrus-test; mkdir -p $CYRUS_HOME; node ~/projects/cyrus/apps/cli/dist/src/app.js start --cyrus-home /tmp/cyrus-test` with .env: CYRUS_SERVER_PORT=3457, CYRUS_HOST_EXTERNAL=true, GITHUB_WEBHOOK_SECRET=test, WEBHOOK_IP_VALIDATION=false (no GITHUB_APP_ID needed). Feed signed payloads with curl + `openssl dgst -sha256 -hmac test` (header x-hub-signature-256, x-github-event, x-github-delivery). State dir becomes <home>/state so prod is untouched. Verify flag/env precedence in Application.ts:35-62,157 first.
- Fork divergence: origin only (troman29/cyrus); no `upstream` remote configured. Merge-base = f68a67a (upstream 2026-08-12, v0.2.68). Fork commits: 55194cf (2026-08-21, skip session in empty worktree for git-crypt/repos without Linear; PromptBuilder/GitService/RunnerConfigBuilder) and e77e4c7 (2026-09-17, prReviewOwnPullRequestsOnly: EdgeWorker +16, config-schemas +9, github-webhook-utils extractPullRequestAuthor/isSameGitHubLogin, ConfigManager, WorkerService, schemas JSON; 15 files +519/-9 across the last 2). Upstream HEAD is unreachable-from-here check: `git remote add upstream https://github.com/cyrusagents/cyrus && git fetch upstream && git log --oneline HEAD..upstream/main`. (git ls-remote of upstream HEAD worked: 325010bd...; local main is "ahead 1" of origin, i.e. e77e4c7 not pushed.)

## 6. GitHub App
App `agentek-bot` (slug), id 4594901, installation 153726171, key ~/.cyrus/github-app.pem. Hook url https://wh.lab.windbit.dev/cyrus/github-webhook, json, secret = GITHUB_WEBHOOK_SECRET, insecure_ssl 0.
Permissions: contents write, issues write, pull_requests write, repository_hooks write, metadata read. Events: issue_comment, pull_request_review, pull_request_review_comment, repository. (Matches manifest in R/skills/cyrus-setup-github/SKILL.md:156-168.)
To inspect: sign RS256 JWT (iat now-60, exp +<=10min, iss=APP_ID) with the pem (same as createAppJwt in P/github-event-transport/src/GitHubAppTokenProvider.ts), then GET https://api.github.com/app, /app/hook/config, /app/hook/deliveries (shows status codes; POST /app/hook/deliveries/{id}/attempts redelivers). Installation token: POST /app/installations/153726171/access_tokens. Changing events/permissions = app settings page (or PATCH /app/hook/config only covers url/secret) - requires owner approval; not touched.
Gotcha: `thomas5788` is a user account, not the app; the app's PRs would be `agentek-bot[bot]`. Event subscription is per-app, so adding check_run/check_suite/pull_request needs the permission "Checks: read" (check_*), "Pull requests" already there.

## Other homelab refs
docs/research/tracker-orchestrators-2026-08.md (chose Linear+Cyrus; notes GitHub mode "weaker: handler drops non-PR first line", no dashboard/HTTP API, process-per-event with --resume); hosts/homelab/services/user/cyrus.service (unit + env docs); reverse-proxy README/nginx; docs/map.md, domains.md, paths.md, backups.md, reproduce.md; scripts/backup.sh. Also homelab-admin mirrors GitHub webhooks (/mirror/github-webhook -> :9120) - same allowlist problem.
