# Feature: skills (slash-injection + /skills menu)

**Цель.** Глобальные скиллы (user + включённые плагины) становятся командами бота; отправка
`/<skill>` впечатывает слэш-команду в пейн сессии. `/skills` — меню проектных скиллов кнопками
(с пагинацией). Инъекция — через `typeSlashCommand` (текст → Escape [гасит `/`-автодополнение,
текст остаётся] → Enter [сабмит литерала]).

**Код.** `skills.ts` (`discoverGlobalSkills`/`discoverProjectSkills`/`mangleCmd`/`tgDescription`),
`typeSlashCommand`/`injectSlashToPanes` (`tmux-ops.ts`/`hub.ts`), слэш-роутинг + `globalSkillMap`,
`/skills` меню (`skpg:`/`skrun:` callbacks).

**Предусловие.** Контейнер, живая сессия (bypass ок).

---

## Позитив

**SK1. Глобальный скилл как команда бота инжектится литералом.**
- Шаги: `/<зарегистрированный-скилл>` в топик.
- Ожидаемо: в пейне впечаталась ровно `/<real-name>` и сабмитнулась; скилл запустился.
- Смотреть: пейн (`capture-pane`), `screenlog.jsonl`, чат.

**SK3. `/skills` — меню проектных скиллов.**
- Шаги: `/skills`.
- Ожидаемо: сообщение со списком проектных скиллов кнопками; пагинация (`skpg:`) листает
  на месте; тап (`skrun:`) впечатывает выбранный скилл в пейн.
- Смотреть: API (кнопки/страницы), пейн.

## Негатив / швы / регрессия

**SK2. 🎯 Регрессия прод-баги: инъекция слэша = ЛИТЕРАЛ, не фаззи-матч.** `[СПЕЦ]`
- Шаги: отправить `/oh` (несуществующая, но похожая на префикс других) в топик.
- Ожидаемо: в пейне «Unknown command: /oh» (или предложение), т.е. впечатан ЛИТЕРАЛ `/oh` —
  Enter НЕ выбрал подсвеченный фаззи-вариант из `/`-попапа.
- Fail-режим (прод-бага 8f0d050): Enter выбирал подсвеченный (`/implement`→`/claude-mem:oh-my-issues`).
- Смотреть: пейн (какая команда реально ушла), `screenlog.jsonl`.

**SK4. Мэнглинг имени в валидную bot-команду.**
- Шаги: скилл с двоеточием/спецсимволом (`plugin:skill`) → команда бота.
- Ожидаемо: имя приведено к валидному (`mangleCmd`), а `globalSkillMap` мапит обратно на реальное
  при инъекции.
- Смотреть: список команд бота, инъекция в пейн.

**SK5. Шов: ops vs skill precedence.**
- Шаги: `/status` (ops) — не должен уйти как скилл-инъекция.
- Ожидаемо: ops-команды перехватываются раньше (см. `handleInbound`), скиллом не трактуются.
- Смотреть: чат (ops-ответ), пейн (ничего не впечатано).

## Юниты
- `tests/core.test.ts`: `parseOpsCommand` (ops vs не-ops). Мэнглинг/скилл-парсинг — кандидаты в юниты.

## Лог прогона
- **2026-08-17 (Codex, Docker+MTProto) — SK3 ✅ (menu + run):** `/skills` в topic 515 показал
  кнопку project skill `telegram-e2e`. Tap дал Telegram toast `▶ /telegram-e2e`, а pane получил
  совместимую с Codex явную инструкцию «Read and follow … skill named \"telegram-e2e\"».
  Скилл прочитал свой `SKILL.md`, открыл tool-approval picker, после `Allow for this session`
  отправил в тот же topic msg960 `TTC_CODEX_SKILL_E2E_OK`. Подтверждение — Telegram API и pane.
- **2026-08-17 (Codex, Docker+MTProto) — SK3 pagination ✅:** в isolated test project добавлены
  девять minimal skill fixtures, итого 10 skills. `/skills` в Telegram отрисовал page 1/2 с
  восемью skills и `▶`; tap обновил *то же* сообщение до page 2/2 (`page-skill-09`,
  `telegram-e2e`, `◀`). Проверено через `list_inline_buttons`; fixtures после прогона удалены.
- **2026-08-17 (Codex, Docker+MTProto) — SK4 ✅:** Docker-only global skill с настоящим именем
  `fixture-plugin:skill` после `/reload` дал `refreshCommands … skills 1`. Команда
  `/fixture_plugin_skill` в Telegram была сопоставлена обратно с исходным именем: pane прямо
  показал `fixture-plugin:skill`, прочитал его `SKILL.md` и отправил msg971
  `TTC_SK4_MANGLE_OK` в тот же topic. Fixture после прогона перемещён в тестовую корзину.
- **2026-07-18 (проход 1)** —
  - **SK2 ✅ (регрессия прод-баги):** `/oh` в топик → пейн «● Unknown command: /oh. Did you mean /cd?»
    — впечатан ЛИТЕРАЛ, Enter не выбрал фаззи-вариант. Guard прод-баги 8f0d050 закрыт (e2e).
  - **SK3 ✅ (edge):** `/skills` на sandbox (нет проектных скиллов) → «📂 Нет проектных скиллов…
    Глобальные — набирай как команды». Корректный пустой стейт.
  - **SK1 ~✅:** механизм инъекции подтверждён SK2 (слэш идёт через `injectSlashToPanes`/`typeSlashCommand`).
  - **SK5 ✅ (шов, по наблюдению):** `/status` и др. ops стабильно отвечают как ops, не инжектятся скиллом.
  (`plugin:skill`→bot-cmd→обратно); юнит на мэнглинг/скилл-парсинг.
