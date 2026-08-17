# Feature map

Карта функциональных зон хаба. По каждой заводим `features/<id>.md` (по шаблону из README) в момент
прохода. Статус: ⬜ не начато · 🟡 сценарии написаны · 🟢 прогнано+зелёное · 🔴 есть открытые баги.

| # | Фича (id) | Что покрывает | Ключевой код | Статус |
|---|---|---|---|---|
| 1 | `binding-routing` | `/bind` `/unbind` `/allow`, ключ чата→`bindings.json`→папка→сессии, hot-reload, доступ (admin/allow) | `hub.ts` роутинг, `bindings.ts`, `registry.ts` | 🟡 (BR1 bind ✅, BR2 роутинг при общей папке ✅ e2e, BR3 unbind+kill ✅; BR4/BR5 доступ ⬜ — нужен не-админ аккаунт) |
| 2 | `trusted-groups` | авто-бинд новых топиков, режимы folder/worktree, хук `wt.py`, транслит кириллицы, выбор режима | `pendingTopics`/`pendingModeChoice`, `runAutoTopic` | 🟡 (TG1 авто-бинд ✅ e2e, TG3 exclude ✅; юниты translit/exclude/merge ✅; TODO worktree+хук, TG4) |
| 3 | `session-lifecycle` | `/resume` `/new` `/restart` `/stop`, автоспавн хаба, авто-ack стартовых промптов, не-двойной-старт, `reviveBoundSessions` | `spawnSession`, `restartSession`, `stopSession` | 🟡 (SL4 restart+контекст ✅, SL5 не-двойной ✅, SL6 restart мёртвой Codex-сессии ✅; SL1-3 ещё требуют отдельных E2E) |
| 4 | `death-notice` | 💀 при пропаже tmux/процесса без `/restart`, грейс | `notifyUnexpectedDeath` | 🟡 (DN1 kill→💀 ✅ e2e; DN2 ⬜ — было «по наблюдению»; TODO DN3) |
| 5 | `core-messaging` | входящее→сессия (только reply, не транскрипт), `reply`/`react`/`edit_message`, очередь при спавне | `handleInbound`, `enqueueForTopic`/`flushQueued` | 🟢 (CM1–CM6: reply/роутинг/очередь, `react`, `edit_message`, и явный no-egress→только fallback подтверждены Docker+MTProto) |
| 6 | `picker-bridge` | `AskUserQuestion`/`/model`→кнопки, single/multi/custom, тап→кейстроки, авто-ack trust-промптов | `detectPicker`, `picker.ts`, `handlePickCallback` | 🟢 (PB1-7 ✅; PB3 custom и PB4 multi подтверждены Docker+MTProto 2026-08-15) |
| 7 | `permissions` | разрешение тула → picker Yes/No в топике (канальный 🔐-путь убран) | picker-мост (`detectPicker`) | 🟢 (канальный путь удалён 0a9619c; picker — единственный UX, проверено e2e) |
| 8 | `status-posts` | ОДИН самообновляемый пост: агенты/задачи/тудушки/фон/скиллы (PerTurnEditablePost) | `PerTurnEditablePost`, `status-render.ts`, `subagent-hook.ts` | 🟡 (SP1/SP3/SP5/SP6 ✅, SP4 ✅; TODO SP2 агенты, SP7 фоновый агент) |
| 9 | `ops-commands` | `/compact` `/clear` `/esc`(дренаж очереди) `/enter` `/status` `/model` | ops-диспатч в `hub.ts`, `parseOpsCommand` | 🟡 (OC3 esc-прерывание ✅, OC4 compact ✅, OC1/OC2/OC7 ✅; TODO clear/enter) |
| 10 | `live-views` | `/screen`(PNG) `/last`(текст), one-per-pane, Закрыть, авто-стоп, 5с | `startLiveScreen`, `paneDigest`, `ansi-image.ts` | 🟢 (P1/P3/P4/N1/N2/N3 ✅; остаётся P2, N4 рестарт-шов) |
| 11 | `voice` | STT входящих, TTS `reply(voice:true)` | STT/TTS в `hub.ts`/`stub.ts` | 🟡 (V2 TTS→sendVoice ✅, V3 no-key→текст ✅; V1 STT-in — механизм доказан, e2e-инъекция в топик TODO) |
| 12 | `skills` | глобальные скиллы как команды бота, меню `/skills` (пагинация), инъекция слэша (фаззи-фикс) | `skills.ts`, `typeSlashCommand`, `injectSlashToPanes` | 🟢 (SK1–SK5: literal injection, empty/menu/run/pagination, mangled global name and ops precedence are E2E-confirmed) |
| 13 | `reply-fallback` | добор ответа из транскрипта на turnend, если агент не отправил | `forwardFallbackReply`, `session-id.ts` | 🟢 (RF1 авто-досыл ✅ e2e, RF2/RF3/RF4 ✅) |
| 14 | `restart-persistence` | Stage 1 посты / Stage 2 fallback / Stage 3 пермишены+пикеры через рестарт | `state-repo.ts`, hydrate в `hub.ts` | 🟡 (RP3 пикеры ✅ end-to-end, RP1 fallback-маркер ✅; RP5 пермишены — нужна non-bypass сессия) |
| 15 | `context-badge` | `⚠️ Контекст: NN%` ПОД ответом при пороге | `parseContextPct`, `TELEGRAM_CONTEXT_WARN_PCT` | 🟡 (CB1 ✅ на проде: реально уходили 81–93%; парсер на живом пейне ✅; guard ✅; CB2 «0 выключает» ⬜) |
| 16 | `pane-detectors` | детект компакции/воркфлоу/ошибок в `pollScreens` | `handleCompaction`/`handleWorkflow`/`handleErrors` | 🟡 (PD1 компакция прогресс→готово ✅ e2e, PD4 анти-ложняк ✅ юнит; PD2 ошибки / PD3 workflow — e2e ⬜, парсеры юнитами ✅) |
| 17 | `debug-log` | `screenlog.jsonl` — таймлайн, кольцо 1000, финальный текст | `logDebugEvent` | 🟡 (DL1 типы ✅, DL2 финальный payload ✅ — решил баг в voice, DL3 кольцо 1618→1000 ✅; DL4 off-by-default / DL5 несериализуемый — ⬜) |
| 18 | `lifecycle-matrix` | сквозной жизненный цикл: матрица (биндинг × tmux × режим × папка × источник) и переходы `/bind` `/unbind` `/delete` `/resume` `/new` `/restart` `/stop`, удаление топика, ребут; + UX-разбор текстов | `spawnSession`, `teardownBinding`, `onTopicGone`, `reviveBoundSessions`, `handleOps`, `forkRiskPids` | 🟡 (LM7/LM49/LM51 ✅ Docker+MTProto; 4 P0 и остальные строки матрицы ещё требуют прогона) |

Порядок прохода — по приоритету/свежести (сначала то, что недавно трогали и где уже были баги:
`live-views`, `restart-persistence`, `skills`, `picker-bridge`).
