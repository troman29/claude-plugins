# PR shepherd: архитектура

Статус: дизайн, код не писался. Основано на scout-hub / scout-cyrus / scout-github (11.11.2026) и беглой проверке `ctl.ts` / `handleControl` на homelab.

## 0. Принцип разделения

- **Cyrus (форк) = приёмник.** Проверяет HMAC, дедуплицирует delivery id, грубо фильтрует (тип события, репо, свой/бот-отправитель), нормализует в маленький JSON и отправляет в сокет хаба. Cyrus не запускает claude, не создаёт worktree, не постит в GitHub.
- **Хаб = мозг и исполнитель.** Всё остальное лежит в новом модуле `src/shepherd/`: владелец PR, агрегация CI, debounce, идемпотентность, запросы к `gh`, рендер промпта, доставка (idle/busy/unloaded/spawn). Хаб уже знает bindings, живость, busy, очередь, worktree и топики.
- Минимальный дифф в форке: один новый каталог плюс около 30 строк правок в существующих файлах. Это снижает дрейф от апстрима.

```
GitHub (App agentek-bot: pull_request, pull_request_review(+_comment), issue_comment,
        check_suite, push)
   |  HTTPS, x-hub-signature-256
   v
nginx wh.lab.windbit.dev  /cyrus/github-webhook  (без IP-allowlist, limit_req, лимит body)
   v
Cyrus :3456  GitHubEventTransport (HMAC, whitelist)
   v  EdgeWorker "event" listener
shepherd/EventRouter  -- dedup(delivery id) -> coarse filter -> normalize
   |  NDJSON {op:'control',command:'pr-event',args:{...}}  (unix socket, 0600, один user)
   v
Hub hub.sock  handleControl -> src/shepherd/
   dedup(idem key) -> classify -> [debounce CI] -> enrich (gh api) -> stale-check
   -> resolve owner (branch/dir/cache) -> render prompt
   -> deliver:  live+idle   -> deliverMessage now
                live+busy   -> hold до Stop (механизм /queue)
                unloaded    -> enqueueForTopic + spawnSession(resume)
                no owner    -> spawn worktree + новый форум-топик + первый промпт
   v
tmux окно `agents:<tmux>` (Claude/Codex)  <->  Telegram forum topic (Рома видит всё)
```

## 1. События и фильтрация

Подписки GitHub App (см. раздел 8) и что с ними делаем:

| Событие / action | Решение | Класс |
|---|---|---|
| `pull_request` closed + merged=true | принять | terminal (будит unloaded) |
| `pull_request` closed + merged=false | принять | terminal (будит unloaded; прислать "закрыт без merge") |
| `pull_request` reopened | принять | normal |
| `pull_request` synchronize / opened / edited / labeled / auto_merge_* / ready_for_review | дроп `ignored_action` (synchronize не нужен: конфликты ловим через push) | - |
| `check_suite` completed, conclusion in failure, timed_out, action_required | принять, агрегировать по head sha | normal |
| `check_suite` completed, success/neutral/skipped/cancelled | дроп `ci_green` (info-строка в логе). cancelled дропаем: concurrency-группы отменяют устаревшие прогоны | - |
| `check_run`, `workflow_run`, `status` | не подписываемся: суммарно шумно, `check_suite` покрывает | - |
| `pull_request_review` submitted: changes_requested | принять | normal |
| `pull_request_review` submitted: commented с непустым body | принять | normal |
| `pull_request_review` submitted: approved | принять как **info**: не будит и не спавнит, доставляется только живой сессии | info |
| `pull_request_review` dismissed / edited | дроп (dismissed сыплется на каждый push из-за require_last_push_approval) | - |
| `pull_request_review_comment` created | принять, если автор не бот и не thomas5788. Если комментарий в треде review, который уже пришёл, склеиваем через debounce 30s по (pr, review_id) | normal |
| `issue_comment` created на PR (`issue.pull_request` есть) | принять от людей; триггера `@agentek-bot` не требуем | normal |
| `push` в ветку из `base_branches` (по умолчанию dev, master, main) | не доставляется напрямую. Запускает проверку конфликтов открытых agent-PR на этой базе (ниже). Прочие push дропаем | internal |

### Конфликты
GitHub не шлёт событие "PR стал конфликтным". Детект:
1. Push в базу (Cyrus уже умеет `push`; whitelist и action-фильтр на 242-278 его пропускают).
2. Хаб: debounce 30s по (repo, ref), затем `gh pr list -R repo --base <ref> --state open --json number,headRefName,author,mergeable,mergeStateStatus`. `mergeable` в GitHub считается лениво: `UNKNOWN` перезапрашиваем 3 раза с интервалом 10s.
3. По каждому agent-PR с `mergeable=CONFLICTING` (или `mergeStateStatus=DIRTY`) создаём событие `conflict`. Idempotency key: `conflict:repo#pr:baseSha`, повторно не шлём, пока база не сменилась.
4. Страховка: раз в 30 минут таймер хаба обходит открытые agent-PR на allowlist-репо (это 1 запрос на репо). Покрывает потерянные push и мерж в базу через UI.

### Агрегация CI
- Триггер: `check_suite completed` с failure. Ключ `ci:repo#pr:headSha`.
- В `check_suite.pull_requests[]` PR может быть пуст (форки, self-hosted). Тогда `gh api repos/R/commits/<sha>/pulls`.
- Debounce 45s (сводка на head sha). В момент срабатывания хаб запрашивает `gh api repos/R/commits/<sha>/check-runs`. Если остались `queued` или `in_progress`, переносит таймер (максимум 40 минут: Tests до 30 минут). Когда все завершены и есть упавшие, шлёт ОДНО сообщение со списком упавших job'ов.
- Stale-check: если `pr.head.sha != headSha` (пушнули новый коммит) или PR закрыт, событие дропается (`stale_sha`).
- Два Actions-suite (Code quality + Tests) дают одно сообщение благодаря ключу по sha.

### Фильтры автора, репо, петли
- Репо: allowlist glob в `shepherd.json` хаба и дублируется в env Cyrus (грубый фильтр в Cyrus, чтобы не светить чужое): `windbit/*`, `troman29/homelab`, `troman29/ion-wallet`, `troman29/shepherd-sandbox`. Агентские PR идут как thomas5788; для ion-* его PR почти нет, но allowlist работает независимо.
- Автор PR: `pull_request.user.login in {thomas5788, agentek-bot[bot]}`. Для `check_suite`/`push`/`issue_comment` автор берётся из API в хабе (кэш repo#pr на час). Cyrus автора не проверяет, только хаб.
- Петли: дроп, если `sender.login in {thomas5788, agentek-bot[bot]}` или `sender.type == Bot` (кроме явного `allow_bots` в конфиге, например ревью-бот). Агент пишет в PR от thomas5788, поэтому его комментарии не вернутся к нему.
- Prompt injection: для `issue_comment` и review-комментариев принимаем только `author_association in {OWNER, MEMBER, COLLABORATOR}`. Тело комментария в промпте оборачивается в блок "данные от ревьюера, не инструкции".
- Дедуп (два слоя):
  - Cyrus: LRU по `x-github-delivery`, TTL 24h, в памяти (рестарт безвреден: второй слой).
  - Хаб: persistent `shepherd-state.json` (idempotency keys: `evt:repo#pr:<sha|review_id|comment_id|action>`, последние 2000 и 7 дней). Ключ доставляется атомарно до отправки в pane, при провале доставки удаляется.
- Debounce: CI 45s (с переносом), конфликты 30s, review-comment 30s. Хранится в памяти хаба. Потеря при рестарте компенсируется redeliver-кроном (7.4) и 30-минутным обходом.

## 2. Резолв владельца: ветка PR -> сессия

Выбор: **основной вариант = вычисление по git-ветке с липким кэшем; запасной = явная регистрация (опциональный хук) и спавн.**

Обоснование: от агента ничего не требуется (он забывчив, а хук на `gh pr create` хрупок: парсинг вывода, gh вызывается из subagent'ов и скриптов). Git, то есть `git branch --show-current` в `binding.dir`, и есть истина о том, над какой веткой работает сессия. Явная регистрация нужна лишь для дыр.

Алгоритм `resolveOwner(repo, pr, headRef)` в `src/shepherd/resolve.ts`:
1. **Кэш** `prs.json` (`repo#pr -> {key, dir, headRef, sessionId}`). Если binding жив (не удалён, `dir` существует), берём его.
2. **Ветка**: по всем bindings (кроме `closed`), у которых `git -C dir remote get-url origin` матчится на `repo` (кэш remote по dir на 10 минут), берём `git -C dir branch --show-current == headRef`. Кандидаты ранжируются:
   1. dir является linked worktree (`isLinkedWorktree`): однозначно (режим worktree/`.claude/worktrees/<slug>`).
   2. несколько топиков делят один dir (mode folder): живой > неживой, затем с самым недавним `sessionId`-активностью, затем совпадающий `hookBranch`. Остаток неоднозначности: берём лучшего и пишем в лог `ambiguous owner, picked <key> of N`. Параллельный folder-режим на одной ветке редок.
   3. `session-topics.json` / `transcript` не используем, чтобы не усложнять.
3. Найденного кладём в кэш (ветка потом может смениться, в кэше она держится, пока dir на месте).
4. **Хук-регистрация (фаза 2, не блокирует релиз)**: PostToolUse-хук на Bash `gh pr create` вызывает `tgc-ctl pr-bind <repo>#<n>` с `TELEGRAM_BINDING_KEYS` из env. Закрывает случай "агент создал PR из ветки, но сменил ветку". Пока не делаем.
5. **Нет владельца**:
   - PR создан с Mac (нет hub-сессии) или Codex: у Codex тот же binding (`agent=codex`), резолв тот же. С Mac PR остаётся без владельца: спавним сессию (раздел 3) для actionable-событий.
   - `closed` binding найден, но жизни нет: spawn нового.
   - Info и terminal merged без владельца: спавн НЕ делаем, только лог + короткое сообщение в служебный топик (ветка после merge уже удалена, делать нечего).

## 3. Семантика доставки

Класс события -> действие:

| Состояние владельца | normal (CI, review, comment, conflict, reopened) | terminal (merged/closed) | info (approved) |
|---|---|---|---|
| live + idle | доставить сразу | доставить сразу | доставить сразу |
| live + busy | удержать до Stop (механизм `/queue`, `keyIsWorking`, флаш на turnend), максимум 6h (MAX_HOLD_MS) | то же | то же |
| unloaded (idle-unload) | `enqueueForTopic` + `spawnSession(..., relaunchMode)` с `--resume`, `flushQueued` по subscribe | то же | молча в лог, не будим |
| closed / dead / нет владельца | spawn новой сессии | не спавним (лог + служебный топик) | не спавним |

Почему busy = удержание: Claude принимает сообщение посреди хода и ставит в очередь сам, но CI-отчёт посреди рефакторинга сбивает фокус; конкретно для Codex при открытой модалке `deliverMessage` и так возвращает 0 и держит.

### Spawn новой сессии (`spawnForPr`)
1. Репозиторий в локальную папку: `repos` в `shepherd.json` (`windbit/agentek-console -> /home/user/projects/agentek-console`), иначе поиск среди `bindings[*].dir` и trusted-groups по remote origin.
2. Worktree: `git fetch origin <headRef>`; `git worktree list --porcelain`: если ветка уже checked out, переиспользуем этот dir. Иначе создаём в том же корне, что и хаб, через `dir-resolve` (hook-проект даёт `.claude/worktrees/<slug>`, иначе сосед `<project>--<branch>`), `git worktree add -B <headRef> <dir> origin/<headRef>`.
3. Топик: `createForumTopic(shepherd.chatId, "PR #<n> <title≤40>")` (шаблон: `/fork`, hub.ts:5221-5275), binding `{dir, tmux: freeTmuxName(...), agent, cmdline, mode:'folder'}`, `saveBindings`, `spawnSession(...,'new')`, `waitForBinding`, `waitPaneReady`, первое сообщение. Агент: claude по умолчанию, если в закрытом binding был codex, то он.
4. Контекст холодный, поэтому первый промпт расширенный: заголовок и тело PR, `git diff --stat` против базы, последние 10 коммитов ветки, указание прочитать AGENTS.md, ссылка на старый топик (если был `closed` binding).

### Содержимое промпта (компактно, Markdown, до ~3 KB)
Заголовок: `[PR shepherd] windbit/agentek-console#1234 feat/x -> dev | <событие>` + ссылки (PR, run/job).
- **CI failure**: имена упавших job'ов и checks, conclusion, URL; хвост лога по каждому (до 3 job'ов, последние 60 строк, до 6 KB; хаб берёт `gh run view <run_id> --log-failed --job <id>` с обрезкой). Строка "head sha: <sha>; если уже пушил новый коммит и CI перезапущен, игнорируй".
- **Review**: автор, state, body (≤1500 символов), inline-комментарии `path:line` + 3 строки `diff_hunk`. Инструкция: ответить в треде через `gh api`, исправить, push, не делать force-push без нужды.
- **Conflict**: база, PR, подсказка "слей/ребейзни базу, разреши конфликты (skill `resolving-merge-conflicts`), push".
- **Merged**: кто смержил, sha. Напоминание про post-merge обязанности: закрыть issue (`Closes windbit/issues#N` из тела PR), проверить раскатку на dev, продолжить задачу.
- Всегда последняя строка: "Если ты уже обработал это событие сам (watch в фоне), коротко подтверди и продолжай работу".
- Meta сообщения: `user:'github'`, `source:'pr-shepherd'`; в топике сообщение видно Роме.

## 4. Изменения в хабе

Корень: `apps/claude-plugins/telegram-tmux-channels`.

1. `src/protocol.ts`: `ControlCommand = 'restart' | 'send' | 'spawn' | 'list' | 'pr-event'`; в `{op:'control'}` поле `key` делаем опциональным и добавляем `args?: Record<string, unknown>`. Старый `restart` совместим.
2. `src/hub.ts` `handleControl`: switch по command. Для `restart` код как есть. Новые ветки тонкие, вызывают `src/shepherd/*` через интерфейс `HubApi` (инъекция, как в `delivery-scenarios`):
   - `list {dir?, branch?, repo?}` -> JSON `[{key, dir, agent, sessionId, live, pane, tmux, working, unloaded, closed, branch}]`.
   - `send {key, text, when:'now'|'idle', meta?}`. Выделить хвост `handleInbound` (hub.ts:4337-4562: liveOrReconnecting -> revive+queue -> deliverMessage) в `deliverToKey(key, text, meta, when)`. Это единственный рефакторинг `hub.ts`, остальное в новых файлах.
   - `spawn {dir, chat, title, agent?, prompt?}` по шаблону `/fork`.
   - `pr-event {event}`: принимает нормализованный объект, отвечает сразу `accepted|duplicate|dropped:<reason>`, дальше обработка асинхронно (в Cyrus не держим HTTP-ответ).
3. Новые файлы `src/shepherd/`: `events.ts` (классификация, фильтры, ключи), `ci.ts` (агрегация/debounce), `resolve.ts`, `render.ts`, `gh.ts` (обёртка `Bun.spawn(['gh', ...])` с таймаутом 20s и ретраем), `state.ts` (`shepherd-state.json`, `prs.json`, формат как `state-repo.ts`), `config.ts` (`shepherd.json` в state dir, hot-reload: enabled, repos, authors, chatId, base_branches, allow_bots, spawn.enabled, dry_run), `index.ts` (оркестратор).
4. `bin/tgc-ctl` / `src/ctl.ts`: подкоманды `list [--branch b] [--dir d] [--json]`, `send <key> [--queue] (-|text)`, `spawn --dir --chat --title [--agent] [--prompt-file]`, `pr-event` (JSON со stdin; удобно для реплея фикстур). Обобщить parser, оставить `restart <key>`. Таймаут как у restart (180s) только для restart/spawn.
5. Авторизация: сокет `hub.sock` 0600 и один unix-пользователь. Cyrus работает под тем же пользователем (проверено: user-юнит). Доп. токена не вводим. Если Cyrus когда-нибудь уедет в контейнер, смонтировать сокет явно.
6. Тесты (`bun test`):
   - `shepherd-events.test.ts` (таблица: событие -> решение/ключ/дроп-причина по фикстурам).
   - `shepherd-ci.test.ts` (fake clock: debounce, перенос при in_progress, stale sha).
   - `shepherd-resolve.test.ts` (temp git repos с worktree: однозначный, folder-неоднозначность, кэш, нет владельца).
   - `shepherd-delivery.test.ts` (fake HubApi: idle/busy/unloaded/no-owner/spawn, info не будит, dedup).
   - `shepherd-render.test.ts` (снапшоты промптов, обрезка логов).
   - socket-level: `TELEGRAM_STATE_DIR=tmp`, паттерн `inbound-envelope.test.ts:44`.
   - `bun run check` (tsc + tests) обязателен.
7. **Исправление learnCmdline** (hub.ts:3045-3090), дёшево: учить argv только у owned-стаба (`session.bindingKeys?.length`), иначе пропуск. Дополнительно расширить `isHeadlessArgv` (tmux-ops.ts:208): первый позиционный аргумент после бинарника из набора `mcp|doctor|update|install|plugin|config|auth|setup-token|migrate-installer` = не интерактивная сессия. Тест: стаб без bindingKeys и argv `claude mcp list` не меняет `cmdline` binding'а в dir с несколькими топиками. Важно для шепарда: `claude mcp list` в рабочих dir больше не портит binding.

## 5. Изменения в Cyrus (форк troman29/cyrus)

Ветка `shepherd` от main. Файлы:
1. `packages/github-event-transport/src/types.ts` (~62, ~202-286): добавить в `GitHubEventType` значения `pull_request`, `check_suite`; интерфейсы `GitHubPullRequestPayload`, `GitHubCheckSuitePayload` (только используемые поля).
2. `packages/github-event-transport/src/GitHubEventTransport.ts` (:242-278): whitelist + action-фильтр: `pull_request: closed|reopened`, `check_suite: completed`, `issue_comment`/`pull_request_review_comment: created`, `pull_request_review: submitted`, `push` как сейчас. Дроп-ветки (unsupported event / action) логировать на **info**: `shepherd: dropped reason=event_not_supported evt=... delivery=...`.
3. Новый каталог `packages/edge-worker/src/shepherd/`:
   - `EventRouter.ts`: `handle(event) -> Promise<void>`: delivery-LRU, грубые фильтры (repo allowlist, sender self/bot), `normalize()`, вызов `hubClient.send()`.
   - `normalize.ts`: payload -> `{delivery, event, action, repo, pr?, headRef?, headSha?, base?, sender, senderType, authorAssoc, review?, comment?, checkSuite?, push?, url}` (JSON ≤ 8 KB, тело комментария обрезано до 4000).
   - `hubClient.ts`: NDJSON по unix-сокету (`net.connect`, ~25 строк, таймаут 5s, 3 ретрая с backoff). Альтернатива `exec tgc-ctl pr-event` отвергнута: лишний процесс bun на каждое событие и хуже обработка ошибок.
   - Юнит-тесты в `packages/edge-worker/test/shepherd/*.test.ts` (vitest, шаблон `EdgeWorker.pr-review-own-prs.test.ts`), фикстуры `test/fixtures/github/*.json`, fake-hub как `net.createServer`.
4. `EdgeWorker.ts` (:919-964, listener "event"): 3 строки: `if (this.shepherd) { await this.shepherd.handle(event); return }` до существующих веток (`push`/`handleGitHubWebhook`). Создание `this.shepherd` в конструкторе, если `SHEPHERD_ENABLED=1`. При включении старый @mention-путь полностью отключён (Cyrus не запускает claude). Linear/Slack не затронуты.
5. Конфиг только через env (не трогаем zod-схемы, меньше дрейфа): `SHEPHERD_ENABLED`, `SHEPHERD_HUB_SOCK` (по умолчанию `~/.claude/channels/telegram/hub.sock`), `SHEPHERD_REPOS` (glob через запятую), `SHEPHERD_SELF_LOGINS` (`thomas5788,agentek-bot[bot]`), `SHEPHERD_DRY_RUN`.
6. Ответ HTTP: 200 на accepted/duplicate/dropped; 503 если хаб недоступен после ретраев (GitHub пометит delivery как failed, крон переиграет).
7. Логи (уровень info), одна строка на событие:
   `shepherd: received evt=check_suite/completed repo=windbit/x delivery=<id>`
   `shepherd: dropped reason=<repo_not_allowed|self_sender|bot_sender|duplicate_delivery|ignored_action|not_pr> ...`
   `shepherd: forwarded -> hub accepted|duplicate|dropped:<reason> ...`
   Хаб добавляет `delivered|queued|revived|spawned|debounced|dropped(reason)` с `key=`.
8. Гигиена форка: `git push origin main` (сейчас e77e4c7 не запушен), `git remote add upstream https://github.com/cyrusagents/cyrus`, `git fetch upstream`. Сначала (отдельным шагом, до фичи) попытаться смержить `upstream/main` в main; при нетривиальных конфликтах остаться на 0.2.68. Ветка `shepherd` потом ребейзится на main. Тестовые команды: `pnpm --filter cyrus-edge-worker test:run`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## 6. Инфра и эксплуатация

1. **nginx**: рекомендую **убрать IP-allowlist** с `/cyrus/github-webhook`. Причина: GitHub регулярно меняет диапазоны (уже 30% 403), а HMAC-SHA256 с `timingSafeEqual` даёт эквивалент безопасности. Взамен в location: `limit_req zone=gh burst=30`, `client_max_body_size 5m`, только POST. Для `/mirror/github-webhook` (homelab-admin): сначала проверить, что он валидирует HMAC. Если да, то же самое. Если нет, оставить allowlist, но генерировать: скрипт `scripts/refresh-gh-allowlist.sh` (`curl api.github.com/meta | jq -r '.hooks[]' | sed 's/.*/allow &;/'` -> snippet, `nginx -t && systemctl reload nginx`), systemd-timer раз в сутки, в лог пишется diff. Сразу разовая ручная правка: добавить 9.234.106.48/28, 9.234.98.160/28, 9.234.98.176/28.
2. **Systemd**: `cyrus.service` получает `Environment=SHEPHERD_*` (через `~/.cyrus/.env`). Хаб: `shepherd.json` в state dir (hot-reload, `enabled`, `dry_run`). Юниты не новые.
3. **Redeliver-крон** (`scripts/gh-redeliver.sh` на homelab, timer 10 минут): JWT приложения -> `GET /app/hook/deliveries?per_page=100`, для `status_code>=400` младше 2 часов и ещё не переигранных, `POST /app/hook/deliveries/{id}/attempts`. Безопасно из-за дедупа. Закрывает 403/502 и рестарты.
4. **Порядок раскатки**:
   1. Хаб: learnCmdline-фикс + control-ops + `src/shepherd/` с `enabled=false`. Деплой, restart хаба (окно: ~1 минута, живые сессии не трогаются).
   2. Форк: push, upstream, код за флагом (выключен). Сборка.
   3. Второй экземпляр Cyrus (порт 3457) + dev-хаб, прогон фикстур (раздел 7).
   4. nginx: снять allowlist, reload.
   5. GitHub App: Роман включает события и права (раздел 8), принимает новые права на установках.
   6. Prod: `SHEPHERD_ENABLED=1`, `repos=troman29/shepherd-sandbox`, `dry_run=1` в хабе (логирует решения, ничего не доставляет), затем `dry_run=0` на sandbox, затем расширение репо: delovar-ai -> agentek-deploy -> agentek-console.
   7. Включить redeliver-крон.
5. **Откат**: `SHEPHERD_ENABLED=0` + `systemctl --user restart cyrus` (возврат к текущему поведению, где фактически всё дропается); `shepherd.json: enabled=false` в хабе гасит обработку без рестарта; control-ops аддитивны, откат хаба `git revert`/checkout и restart. Allowlist nginx: вернуть snippet из бэкапа.
6. **Наблюдаемость**:
   - Одна строка `shepherd:` на событие в Cyrus (journalctl `-u cyrus | grep shepherd:`) и в хабе (`-u telegram-hub | grep shepherd:`) с одним и тем же `delivery=`.
   - `~/.claude/channels/telegram/shepherd.jsonl` (append-only, по строке на решение: ts, delivery, evt, repo, pr, outcome, reason/key) для разбора постфактум.
   - Недоставляемые actionable-события (нет владельца и spawn выключен, ошибка gh, лимиты) хаб постит в служебный топик `shepherd.chatId`. Тишина не допускается.
   - GitHub: Advanced -> Recent Deliveries приложения. Сверка: счётчик 403/5xx за сутки в nginx.

## 7. План тестирования

1. **Юнит**:
   - Cyrus (vitest): таблица "фикстура -> решение" для каждого события/action, dedup LRU, self/bot, репо-фильтр, нормализация (снимать JSON-снапшот), hubClient против fake-сервера (ретраи, 503).
   - Хаб (bun test): см. 4.6.
2. **Фикстуры**: существующие issue_comment / pull_request_review берём из `GET /app/hook/deliveries/{id}` (содержит request payload). Новые (`pull_request`, `check_suite`, `push`) записываем после включения подписок на sandbox-репо (или собираем по документации и сверяем с первой реальной доставкой).
3. **Интеграция на homelab**:
   - Второй Cyrus: `node apps/cli/dist/src/app.js start --cyrus-home /tmp/cyrus-test`, `.env`: `CYRUS_SERVER_PORT=3457`, `CYRUS_HOST_EXTERNAL=true`, `GITHUB_WEBHOOK_SECRET=test`, `WEBHOOK_IP_VALIDATION=false`, `SHEPHERD_ENABLED=1`, `SHEPHERD_HUB_SOCK=/tmp/hubdev/hub.sock`. Подписанные curl-ом фикстуры (`openssl dgst -sha256 -hmac test`).
   - Dev-хаб: официальный Docker-харнес (compose, тестовый бот, отдельный state dir). Живой хаб рядом нельзя: один getUpdates на токен, `tmux` сессия `agents` захардкожена (mux/tmux.ts:6).
   - Проверки: каждая строка таблицы раздела 3 (idle, busy, unloaded, closed, no-owner/spawn), CI-агрегация с in_progress, stale sha, конфликт через push, дедуп повторной отправки одной фикстуры, redeliver.
4. **Live E2E** на песочнице **публичный** репо `troman29/shepherd-sandbox` (на приватных free-репо нет rulesets, а значит нет required checks и работающего auto-merge; публичный решает; App установлен и на нём):
   - workflow `ci.yml` падает, если в файле `FAIL` есть строка;
   - ruleset: required check + 1 approval (Роман/второй аккаунт), auto-merge включён;
   - сценарий: сессия в хабе создаёт ветку и PR от thomas5788, `gh pr merge --auto`, уходит в фон -> CI красный -> приходит сводка в топик -> агент фиксит, push -> CI зелёный -> Роман approve -> auto-merge -> приходит `merged` -> агент продолжает без "смержил".
   - Варианты: (a) сессия unloaded в момент падения CI; (b) топик закрыт -> spawn нового; (c) PR с Mac; (d) конфликт через второй PR; (e) changes_requested с inline-комментарием; (f) busy-сессия.
5. Критерии выхода: нет дублей на redelivery, нет доставки в чужой топик, каждый дроп виден в логе с причиной, ни один процесс claude не запущен Cyrus'ом.

## 8. Настройки GitHub App `agentek-bot` (для Ромы)

Settings -> Developer settings -> GitHub Apps -> agentek-bot (id 4594901):
- **Permissions** (Repository): Pull requests: Read & write (есть); Checks: **Read** (новое); Issues: Read & write (есть); Contents: есть; Metadata: Read; Commit statuses: Read (опц.). Actions: Read не нужен (логи берёт `gh` от thomas5788).
- **Subscribe to events**: Pull request, Pull request review, Pull request review comment, Issue comment, **Check suite**, **Push**, Repository (оставить). Workflow run / Check run не включать.
- После сохранения новые права нужно **принять** на каждой установке (org windbit и аккаунт troman29, если ставилось отдельно; installation 153726171). Проверить, что приложение установлено на ВСЕ репо из allowlist (agentek-console, agentek-deploy, delovar-ai, agentek-hermes, agentek-litellm, ... и sandbox).
- Webhook URL / secret не менять (`https://wh.lab.windbit.dev/cyrus/github-webhook`, `GITHUB_WEBHOOK_SECRET`). "Active" включено, SSL verification включена.
- Проверка: Advanced -> Recent Deliveries, после тестового PR видны `pull_request`, `check_suite`, статус 200.

## 9. Риски и открытые вопросы

Риски:
- **Двойная обработка**: агент по правилу уже наблюдает CI и ревью в фоне, поэтому шепард может дублировать. Смягчение: идемпотентная формулировка промпта; шепард по смыслу страховка для умерших, unloaded и закрытых сессий. Если дубли будут мешать, добавить задержку 2 минуты и проверку "агент уже пушил после события".
- **Холодный spawn теряет контекст** прошлой сессии. Улучшение (фаза 2): `--fork-session` от sessionId закрытого binding.
- **Неоднозначность folder-режима** (несколько топиков на одном dir/ветке): эвристика ранжирования, в худшем случае уйдёт не в тот топик (виден в логе и в Telegram).
- **`mergeable` ленив** (UNKNOWN): ретраи, иначе пропуск до 30-минутного обхода.
- **Prompt injection** из комментариев: association-фильтр + обрамление блоком данных.
- **Дрейф форка** и 7.5k-строчный EdgeWorker: правки ограничены 3 строками, остальное в отдельном каталоге; upstream-merge отдельным шагом.
- **`hub.ts` монолит** 6.5k строк: рефакторинг ограничен выделением `deliverToKey`; модуль shepherd изолирован через интерфейс.
- **Утечка токенов в логи**: `gh` вывод логов CI может содержать секреты; обрезка и маскирование паттернов (`ghp_`, `Bearer`, `password=`) в `render.ts`.
- **Rate limit gh**: на 20 PR/день и ~1000 CI-прогонов/мес запросов мало; кэш PR-автора, один `check-runs` на sha.
- **Authentication thomas5788 PAT на homelab** должен иметь права read на все allowlist-репо; для ion-* и troman29/* проверить.
- Merged-PR после `delete_branch_on_merge`: ветка удалена, spawn для merged не делаем (см. 2.5).

Открытые вопросы к Роме:
1. Какой чат/группа для автотопиков (`shepherd.chatId`) и служебный топик для алертов?
2. Approved: доставлять живой сессии как info, или достаточно лога (auto-merge и так сработает)? В репо без auto-merge (agentek-deploy, delovar-ai) агент должен мержить сам. Подтвердить политику.
3. Нужен ли ответ шепарда обратно в PR (например, 👀-реакция на комментарий)? Сейчас нет: у Cyrus нет записи в GitHub.
4. Приложение установлено на `troman29/*` и `windbit/*` обеими установками? Какие репо в allowlist на старте?
5. Хук-регистрация на `gh pr create` (фаза 2) нужна, или хватит ветки?
6. Нужен ли публичный sandbox-репо (из-за ограничений free-плана) или есть платный приватный?
7. `/mirror/github-webhook` (homelab-admin): проверяет ли он HMAC? От ответа зависит, снимать ли там allowlist.
8. Для PR от Mac без hub-сессии: спавнить на homelab (нужна копия репо и ветка в origin, да) или только уведомлять?
