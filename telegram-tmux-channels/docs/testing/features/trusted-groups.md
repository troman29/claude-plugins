# Feature: trusted-groups (авто-бинд топиков)

**Цель.** Группа, описанная в `trusted-groups.json`, авто-биндит **любой новый форум-топик** без
`/bind`: хаб предлагает режим (`folder` — общая папка проекта / `worktree` — свой git-worktree+ветка
на топик, с хуком `{create,delete}`), поднимает сессию. Имя топика → slug ветки/tmux-сессии
(кириллица транслитерируется). Топики можно исключать (`exclude.topicIds` / `nameContains`).

**Код.** `trusted-groups.ts` (`loadTrustedGroups`/`mergeGroupConfig`/`isExcludedTopic`/
`slugFromTopicName`), `pendingModeChoice`/`pendingTopics`, `beginTopicSession`/`runAutoTopic`,
`resolveModeDir` (`dir-resolve.ts`).

**Предусловие.** Контейнер; `trusted-groups.json` для тест-группы `-1004355407865`.

---

## Юниты (есть, настоящие) ✅
`tests/core.test.ts`: `isExcludedTopic` (по id / подстроке / мимо), `slugFromTopicName`
(санитайз, слэши, фолбэк `topic`, **транслит кириллицы** `продать BTC`→`prodat-BTC`),
`mergeGroupConfig` (override группы поверх defaults). Это покрывает чистую логику — e2e ниже
проверяет только то, что юнитом не поймать.

## Позитив

**TG1. 🎯 Новый топик → предложение режима → сессия.** `[СПЕЦ]`
- Шаги: создать новый форум-топик в trusted-группе.
- Ожидаемо: хаб постит в топик выбор режима (кнопки `folder`/`worktree`); тап `folder` → создаётся
  биндинг с `dir` группы, поднимается tmux-сессия, приходит «🚀 Запускаю/Возобновляю».
- Fail-режим: тишина (топик не подхвачен); биндинг без dir; сессия не поднялась.
- Смотреть: чат нового топика (кнопки), `bindings.json` (появился ключ), пейн/`tmux ls`.

**TG2. Кириллическое имя топика → ASCII-slug в имени tmux/ветки.**
- Шаги: топик с русским названием.
- Ожидаемо: tmux-сессия/ветка получают транслит (`prodat-BTC`), не мусор и не кириллицу.
- Смотреть: `tmux ls`, имя ветки (в worktree-режиме).

## Негатив / швы

**TG3. Исключённый топик не биндится.**
- Шаги: топик с именем из `exclude.nameContains` (или id из `topicIds`).
- Ожидаемо: хаб его игнорирует, выбора режима нет.
- Смотреть: чат (тишина), `bindings.json` (ключ не появился).

**TG4. Сообщение, присланное до выбора режима, не теряется.**
- Шаги: новый топик → НЕ нажимая режим, написать сообщение.
- Ожидаемо: сообщение придерживается (👌) и доставляется после подъёма сессии (`flushQueued`).
- Смотреть: реакция 👌, затем ответ агента.

**TG5. `worktree`-режим создаёт свой worktree/ветку через хук.** `[СПЕЦ]`
- Предусловие: git-репо + рабочий `hook.create`.
- Ожидаемо: отдельная папка-worktree + ветка по slug; `/unbind` гоняет `hook.delete`.
- Смотреть: `git worktree list`, папка.

## Лог прогона
- **2026-08-17 (Docker+MTProto) — TG2/TG5 ✅ (plain worktree):** в отдельном Docker-only git
  repo с initial commit включены `folder`+`worktree`; topic `984` «ТТС worktree продать BTC»
  получил выбор режима. Tap `🌿 Worktree` создал binding на
  `/tmp/ttc-worktree-repo--TTS-worktree-prodat-BTC`, branch `TTS-worktree-prodat-BTC` и tmux.
  `/unbind` удалил только linked worktree; main repo `/tmp/ttc-worktree-repo` на `master` остался.
- **2026-08-17 (Docker+MTProto) — TG5 hook.create/delete ✅:** в той же isolated fixture topic
  `993` выбрал worktree с group hook. `create` создал marker и вернул
  `/tmp/ttc-hook-wt-TTC-hook-E2E`; binding сохранил именно `hookBranch: TTC-hook-E2E`.
  `/unbind` вызвал `delete`: есть delete-marker, worktree и binding исчезли, main остался.
- **2026-07-20 (проход 1)** — в контейнер положил `trusted-groups.json` на тест-группу
  (`dir=/home/user/projects/sandbox`, modes folder+worktree, `exclude.nameContains:["noauto"]`).
  - **TG1 ✅ ПОЛНЫЙ:** создал форум-топик «продать BTC» (id 129) → хаб сам предложил режим
    (msg130: 📁 Папка / 🌿 Worktree / ✏️ Своя папка) → тап «Папка» → в `bindings.json` появился
    `-1004355407865/129` с `dir` и cmdline, поднялась tmux-сессия `sandbox---1004355407865-129`.
  - **TG3 ✅ (негатив):** топик «noauto служебный» (id 134) — биндинг НЕ создан, выбора режима нет
    (ключи остались только `/3` и `/129`). Исключение работает.
  - **TG2:** транслит покрыт настоящим юнитом (`продать BTC`→`prodat-BTC`); e2e-проявление —
    только в worktree-режиме (в folder-режиме имя tmux берётся из ключа, не из имени топика).
- **TODO:** TG4 (сообщение до выбора режима придерживается и досылается).
