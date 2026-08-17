# Feature: picker-bridge

**Цель.** TUI-промпты сессии (`AskUserQuestion`, `/model`, permission-диалог, «Exit anyway»)
скрейпятся из пейна и превращаются в Telegram-кнопки; тап → кейстроки в пейн. Trust/dev-промпты
авто-акаются (не всплывают кнопками).

**Код.** `picker.ts` (`parsePicker`/`checkedIndexes`/`buildKeyboard`), `detectPicker`,
`handlePickCallback`, `isAutoAckPrompt`, `awaitingCustom` (кастом-ответ), `pollScreens`.

**Предусловие.** Контейнер, живая сессия.

---

## Позитив

**PB1. Single-select → кнопки → тап → ответ агенту.** ✅ (покрыто RP3)
- Ссылка: `restart-persistence.md` RP3 — `AskUserQuestion` (Красный/Синий) → кнопки → тап →
  «✅ Красный», агент получил ответ. Single-select работает.

**PB2. `/model` → нативный пикер моделей кнопками.**
- Шаги: `/model`.
- Ожидаемо: бот шлёт «жди меню», в пейне открывается CLI-пикер моделей, `detectPicker` рисует
  его кнопками в топике.
- Смотреть: пейн, API (кнопки со списком моделей).

**PB3. Custom-ответ («✍️ Свой вариант»).**
- Шаги: на пикере с кастом-опцией тап «✍️ Свой вариант» → бот просит текст → прислать текст.
- Ожидаемо: бот «Пришли ответ сообщением», `awaitingCustom` армится; присланный текст
  впечатывается в поле (`typeLine`) и сабмитится; пикер-сообщение → «✅ <текст>».
- Смотреть: пейн, чат.

**PB4. Multi-select (чекбоксы + Submit).**
- Шаги: `AskUserQuestion` с multiSelect → тапы по опциям (toggle) → «Отправить».
- Ожидаемо: тап опции шлёт цифру (toggle), клавиатура перерисовывается с ✓; «Отправить» →
  Right → Submit; сообщение → «✅ a, b».
- Смотреть: пейн (чекбоксы), API (клавиатура обновляется).

## Негатив / швы

**PB5. Trust/dev-промпт авто-акается, НЕ всплывает кнопками.** `[СПЕЦ]`
- Шаги: свежая сессия (`/new`) — стартовые «I trust this folder» / «local development».
- Ожидаемо: хаб авто-жмёт (ackStartupPrompts), в топик кнопки НЕ шлются (`isAutoAckPrompt`).
- Смотреть: чат (нет пикера на trust), пейн (промпт закрылся).

**PB6. Пикер закрыт в терминале → сообщение резолвится «отвечено в терминале».**
- Шаги: пикер открыт → ответить в TUI (не через кнопки).
- Ожидаемо: `detectPicker` видит, что пикера нет → правит сообщение на «<i>отвечено в терминале</i>».
- Смотреть: чат.

**PB7. Non-hub сессия не хайджекает пикеры топика.**
- Шаги: ручной `claude` в той же папке (без bindingKeys).
- Ожидаемо: `pickerChatFor` без ключа → пикеры не уходят в топик.
- Смотреть: чат.

## Лог прогона
- **2026-07-18 (проход 1)** —
  - **PB1 ✅** single-select (через RP3: `AskUserQuestion` Красный/Синий → тап → ответ агенту).
  - **PB2 ✅** `/model` → нативный пикер моделей кнопками (msg89: Default/Sonnet/Fable/Opus/Haiku),
    тап «Default» разрулил.
  - **PB5 — БЫЛО ошибочно ✅ «по наблюдению», оказалось 🔴** — 2026-07-20 прод завис на
    «I am using this for local development»: старый `ackStartupPrompts` жал Enter ОДИН раз и не
    перепроверял, проглоченное нажатие вешало сессию навсегда. Пометка «✅ по наблюдению» это
    скрыла. Починено переносом ack в screen-loop (жмёт, пока промпт не исчез; видит пейны без
    подключённого stub) — **теперь PB5 ✅ по реальному e2e**: пейн, застрявший на промпте без
    stub, хаб сам разблокировал (`startup prompt auto-acked`). См. regression-checklist.
- **2026-08-15 (Docker + настоящий MTProto, Claude topic 464)** —
  - **PB3 ✅** single-select `Red/Blue/Other`: tap «✍️ Custom option» → бот запросил текст;
    `TTC_CUSTOM_VALUE_20260815` был введён в TUI как ответ и Claude подтвердил его обратно в
    Telegram. После завершения старое picker-сообщение не содержало кнопок.
  - **PB4 ✅** multi-select `Alpha/Beta/Gamma/Other`: taps `Alpha` и `Gamma` перерисовали
    клавиатуру с `✅`; `Submit` доставил Claude ровно `Alpha, Gamma`, что агент подтвердил
    сообщением `Выбор получен: Alpha, Gamma`.
  - **PB3+PB4 custom multi ✅**: Telegram выбрал `Alpha` → «Свой вариант» →
    `TTC_CUSTOM_FINAL_VALUE` → Submit. Хаб ввёл строку прямо в inline-поле Claude
    `Type something` (не через `$EDITOR`), сохранил один Telegram picker и подтвердил
    review+submit. Claude получил ровно `Alpha, TTC_CUSTOM_FINAL_VALUE` и ответил
    `TTC_CUSTOM_FINAL_OK`.
  - **PB6 ✅** picker `Red or Blue?` (msg650) был отвечен непосредственно в Claude TUI (`Red`),
    после чего та же Telegram bubble стала `answered in the terminal`; агент получил `Red`, а
    fallback дослал итог `Выбор получен: Red` (msg651).
  - **PB7 ✅** в той же папке запущен отдельный Claude pane `%4` без `TELEGRAM_BINDING_KEYS`;
    он открыл `Alpha or Beta?` в TUI, но hub не написал `picker sent` и бот не создал bubble.
