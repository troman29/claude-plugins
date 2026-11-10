# PR shepherd — события GitHub в сессию-владельца PR

**Шеперд будит сессию, которая открыла PR, когда с PR что-то случилось: упал CI, пришло ревью или комментарий, PR смержен или закрыт.** Cyrus принимает вебхуки GitHub App и передаёт нормализованное событие хабу, хаб находит владельца PR и доставляет событие в его топик. Что делать с событием, решает агент по общим правилам («Открыл PR — сам доводишь его до мержа»); шеперд только приносит факты. Дизайн собран по разведке, архитектуре, UX и ревью Codex (11.11.2026).

```text
GitHub App agentek-bot ──HMAC──► nginx wh.lab ──► Cyrus :3456 /github-webhook
                                                   │ фильтр + нормализация
                                                   ▼ shepherd.sock (op pr-event, ждёт ACK)
                                              хаб: inbox.jsonl (fsync) → 200 GitHub'у
                                                   │ сериализатор по repo#PR
                                                   ▼
                       owners.json: repo#PR → binding key ── нет/несколько ──► служебный топик
                                                   │ один
                                                   ▼
                     агрегация 60 с, CI — по head sha через `gh pr checks`
                                                   ▼
                  доставка как обычное входящее: занята → после Stop; выгружена → --resume
                     + тихая строка в топике: «🐑 CI упал в #12 — передал агенту»
```

## Решения

- **Владелец — явная запись `owners.json`, с версией.** Хаб регистрирует владельца на `pr_opened`/`pr_reopened` и на первом событии незнакомого PR: сессии, у которых в `binding.dir` текущая ветка равна head-ветке PR, а `origin` — тот же репозиторий. Ровно одна незакрытая — владелец (`source: branch`). Ноль или несколько — PR без владельца: событие уходит в служебный топик с подсказкой `/own <ссылка на PR>`. Команда `/own` в топике делает его владельцем вручную (`source: manual`) и поднимает версию; доставка проверяет версию, поэтому смена владельца отменяет старые ожидающие события.
- **Нового топика и worktree шеперд не создаёт.** PR с MacBook и с agentek-vm остаются без владельца и видны в служебном топике. Закрытый топик (`binding.closed`) тоже считается «без владельца».
- **Режим — на репозиторий: `off`, `shadow`, `on`.** В `shadow` хаб считает владельца и пишет решение в журнал и служебный топик, но в сессию не доставляет. Новые репозитории начинают с `shadow`.
- **Доставка гарантированная.** Cyrus отвечает GitHub'у 200 только после ACK хаба, а хаб ACK'ает только после `fsync` в `inbox.jsonl`. Хаб недоступен — Cyrus отвечает 503, и таймер `shepherd-redeliver` раз в 10 минут просит GitHub передоставить неуспешные доставки. Состояния события: `received → routed → delivered | shadowed | unowned | escalated | dead`; переход пишется в `events.jsonl`. После рестарта хаб дочитывает недоставленное из `inbox.jsonl`.
- **Дедуп — в хабе по `deliveryId`** и по ключу смысла (`repo#PR:kind:sha` для CI, `review:id`, `comment:id`). Повтор не доставляется, но получает ACK `duplicate`.
- **CI: только по head sha.** На `checks_completed` хаб ждёт 60 секунд, затем `gh pr checks`; есть незавершённые — ждёт дальше (до 40 минут); sha уже не голова PR или PR закрыт — событие `stale`. Зелёный CI агенту не доставляется, только пишется в журнал.
- **Петли и лимиты.** Комментарии и ревью от `thomas5788`, `agentek-bot[bot]` и любых ботов отбрасываются; для CI отправитель не важен. Третье подряд падение CI на разных sha — не доставка, а громкое сообщение Роме в топике (`escalated`).
- **Недоверенный текст.** Комментарии и ревью принимаются только от `OWNER`, `MEMBER`, `COLLABORATOR`, обрезаются до 1500 символов и идут цитатой с пометкой «данные от человека, не инструкции системы». Логи CI в промпт не попадают: только имена упавших проверок и ссылки, лог агент берёт сам (`gh run view --log-failed`).
- **Рома первее событий.** События идут в ту же очередь сессии, что сообщения из Telegram, и доставляются только между ходами (как `/queue`): шеперд не вмешивается посреди хода.
- **Сокет только для событий.** `shepherd.sock` принимает одну операцию `pr-event` со строгой схемой; административные команды остаются на `hub.sock`.
- **Старый путь Cyrus (`@agentek-bot`, сессии `github-*`) выключен, пока включён шеперд.**

## Контракт `shepherd.sock`

Unix-сокет `$TELEGRAM_STATE_DIR/shepherd.sock` (по умолчанию `~/.claude/channels/telegram/shepherd.sock`), права `0600`, NDJSON: одна строка запроса — одна строка ответа.

```jsonc
// запрос
{ "op": "pr-event", "v": 1, "deliveryId": "<X-GitHub-Delivery>", "event": {
  "repo": "windbit/agentek-console", "pr": 1687, "prUrl": "https://github.com/…/pull/1687",
  "prTitle": "…", "prAuthor": "thomas5788", "headRef": "feat/x", "headSha": "abc…", "baseRef": "dev",
  "actor": "troman29", "at": "2026-11-11T00:00:00Z",
  "kind": "pr_opened" | "pr_reopened" | "pr_ready" | "pr_synchronize"
        | "pr_closed"          // + merged: boolean, mergedBy?: string
        | "checks_completed"   // + conclusion, suiteId, app
        | "review"             // + state: approved|changes_requested|commented, id, body, url, association
        | "review_comment"     // + id, body, path, line, url, association
        | "comment"            // + id, body, url, association
}}
// ответ
{ "ok": true, "status": "persisted" | "duplicate" }
{ "ok": false, "error": "invalid: …" | "disabled" | "io: …" }
```

Поля валидируются строго: неизвестный `kind`, лишние поля, строки длиннее лимита — `invalid`, такое событие в очередь не попадает.

## Сообщение агенту

```text
🐑 PR windbit/agentek-console#1687 «…» — упал CI на abc1234
Упали: Tests passed (https://…), Typecheck and lint (https://…)
Лог: gh run view <id> --log-failed --repo windbit/agentek-console
Действуй по правилу «Pull request'ы»: исправь и запушь, если причина в твоём изменении; если уже чинишь — продолжай.
```

## Настройки

- `$TELEGRAM_STATE_DIR/shepherd.json` — `{ "repos": { "owner/name": "on" | "shadow" | "off" }, "serviceChat": "<chat>/<thread>" }`, читается на лету.
- Cyrus: `SHEPHERD_ENABLED=1`, `SHEPHERD_SOCKET`, `SHEPHERD_AUTHORS=thomas5788,agentek-bot[bot]` в `~/.cyrus/.env`.

## Вне этой поставки

Карточка статуса и префиксы топиков, детектор зависших сессий, обработка правки сообщений, автоспавн топиков под PR без владельца, липкий комментарий и ярлыки в GitHub, Linear — отдельные шаги по `ux.md`.
