# Как устроена память у популярных ассистентов (октябрь 2026)

Собрано по справке производителей 24.10.2026. Нужно, чтобы выбрать модель памяти для Рядом.

## Сводка

| | Видимые записи «что я о тебе знаю» | Поиск по прошлым разговорам | Как забыть |
|---|---|---|---|
| **Claude** | Отдельные записи по категориям, пишутся во время разговора. Каждую можно открыть, поправить, удалить. «Пауза» и «Сброс» | Поиск по прошлым чатам (RAG, виден в чате как вызов инструмента), свой переключатель | Удаление чата не удаляет записи памяти из него, их удаляют отдельно |
| **ChatGPT** | «Saved memories»: короткие факты, удаляются по одному или все | «Reference chat history»: не виден и меняется со временем, свой переключатель | Чтобы забыть полностью, нужно удалить и запись, и разговор. **По пересказу поиска, официальная страница недоступна (403), проверить вручную:** [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq), [What is memory](https://help.openai.com/en/articles/8983136-what-is-memory) |
| **Gemini** | «Saved info»: факты, можно добавить, поправить, удалить | Опора на прошлые разговоры, включена по умолчанию | Разговоры удаляются в истории активности |
| **Replika** | Вкладка «Memory»: факты, можно поправить и удалить | «Глубокая» память по истории, не видна | Удаление фактов по одному |
| **AI Therapist** | Заметки по персонажу, «×» и «удалить все» | нет | «×» |
| **Рядом сейчас (агент 0.8.1)** | нет | Cognee по транскриптам, пересказ подмешивается в разговор | только всё сразу |

## Claude подробнее (на него ориентируемся)

По справке Anthropic «Use Claude's chat search and memory» и заметкам к выпускам:

- **Записи.** «Claude saves memory as a set of individual topics as you chat, rather than summarizing conversations after they end». С 10.07.2026: «individual, categorized entries that Claude reads and updates during your conversations».
- **Управление.** Settings → Your Claude → Manage: открыть запись, поправить, удалить. «Pause memory» — не использовать и не создавать, но хранить. «Reset memory» — удалить всё безвозвратно. Попросить в чате «запомни», «поправь», «забудь».
- **Чувствительное.** «By default, Claude does not store topics related to personal or sensitive subject matter, like your health». Включается «Include sensitive topics in memory». После этого о каждой такой записи показывается уведомление, а отказ удаляет запись. Никогда не сохраняются номера документов, финансовые счета, иммиграционный статус.
- **Поиск по чатам** — отдельно: «These searches use Retrieval-Augmented Generation (RAG) and will appear as tool calls». Свой переключатель «Search and reference chats».
- **Удаление чата:** «memory entries generated from it aren't removed».
- **Инкогнито:** не сохраняется ни в историю, ни в память, не ищется. Можно выключить память для одного чата, тогда он остаётся в истории и ищется.
- **По умолчанию** память включена для Free, Pro и Max, выключена для Team и Enterprise.
- **Импорт** из других ассистентов: вставить выгрузку текстом, Claude разложит её на записи.

## Что берём для Рядом

- Два слоя: заметки (PostgreSQL агента) и поиск по прошлым разговорам (Cognee).
- Запись по ходу разговора, правка и удаление по одной, пауза, сброс, «запомни», «забудь», «поправь».
- Чувствительное по согласию с уведомлением. Граница самочувствия — открытый вопрос: для приложения эмоциональной поддержки самочувствие — основной контекст.
- Отдельный переключатель поиска. «Удалить разговор» убирает его из поиска, заметки остаются.
- «Без памяти» = разговор, который не пополняет память и не использует её; сам он остаётся в журнале и живёт по общему сроку. Инкогнито конкурентов (текст не сохраняется) у нас отдельная галочка «Не сохранять этот разговор», `add-unsaved-dialog`.
- От конкурента: итог разговора. Карточку «В прошлый раз» мы не делаем: итог журнальный, в следующий разговор не попадает (D7).

## Источники

- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://support.claude.com/en/articles/12138966-release-notes
- https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude
- https://support.claude.com/en/articles/12260368-use-incognito-chats
- https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- https://support.google.com/gemini/answer/16413516
- https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work

## Дословные цитаты Anthropic (проверено 25.10.2026)

Источник, страница открыта целиком: [Use Claude's chat search and memory to build on previous context](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).

- Удаление чата: «When a conversation is deleted, including under a retention period, memory entries generated from it aren’t removed».
- Поиск по чатам отдельно от памяти: «These searches use Retrieval-Augmented Generation (RAG) and will appear as tool calls during your conversations.»
- Инкогнито: «Claude won’t remember your chats, so they won’t be saved to Claude’s memory» и «Claude won’t pull information from incognito chats when searching previous conversations.»
