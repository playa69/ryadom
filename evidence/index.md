# Доказательства: add-explicit-data-consent

- Ветка: `app/explicit-personal-data-consent`
- Коммит: `73a936f0`
- Стенд: `explicit-personal-data-consent`, слот 1 (веб-приложение http://127.0.0.1:20153, PWA http://127.0.0.1:20154)
- Снято: 2026-11-08 17:48 UTC
- Даты и время на снимках закрашены серым: снимок одного шага должен совпадать от прогона к прогону.

## desktop (1280×900)

Сценарий: app-account.spec.ts › путь аккаунта: регистрация, вход, смена пароля, удаление

### 01. В приложении регистрация закрыта без отметки

![app-register-consent-required](desktop/01-app-register-consent-required.png)

### 02. После отметки регистрация доступна

![app-register-consented](desktop/02-app-register-consented.png)

### 03. Страница «Голос агента»: открыта на мужских голосах

![voice-male-tab](desktop/03-voice-male-tab.png)

Замечания по вёрстке: overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Сергей" by 28x16px; overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Андрей" by 28x14px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Андрей" by 28x14px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Иван" by 28x16px; overlap: a.item-link "person_2_fillЛюди рядом" overlaps a.link.icon-only "Прослушать: Иван" by 28x12px; text-overlap: p.rd-profile-email "account-1794159934138-8533@e" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: span "Дмитрий" is printed over div.item-title "Николай"; text-overlap: p.rd-caption "Применится со следующего раз" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-caption "Просто говори: шар сам поймё" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-caption "Просто говори: шар сам поймё" is printed over div.item-title "Кирилл"

### 04. Вкладка женских голосов: у каждого можно прослушать пример

![voice-female-tab](desktop/04-voice-female-tab.png)

### 05. Выбрана Алиса: «Голос сохранён»

![voice-saved](desktop/05-voice-saved.png)

### 06. В профиле теперь голос Алиса

![voice-profile](desktop/06-voice-profile.png)

Замечания по вёрстке: overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Анна" by 28x16px; overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Елена" by 28x14px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Елена" by 28x14px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Ольга" by 28x16px; overlap: a.item-link "person_2_fillЛюди рядом" overlaps a.link.icon-only "Прослушать: Ольга" by 28x12px; text-overlap: p.rd-profile-email "account-1794159934138-8533@e" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-profile-email "account-1794159934138-8533@e" is printed over div.item-title "Мария"; text-overlap: p.rd-caption "Применится со следующего раз" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-caption "Просто говори: шар сам поймё" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-caption "Просто говори: шар сам поймё" is printed over div.item-title "Екатерина"

### 07. Путь Сбера: на странице один голос — Вера, выбранная Алиса сохранена

![voice-sber](desktop/07-voice-sber.png)

Сценарий: app-account.spec.ts › новая запись согласий: «Продолжить» закрыто до явной отметки

### 08. В приложении новая запись согласий требует отметки

![app-terms-gate-required](desktop/08-app-terms-gate-required.png)

### 09. После отметки кнопка «Продолжить» доступна

![app-terms-gate-consented](desktop/09-app-terms-gate-consented.png)

Сценарий: app-anonymous.spec.ts › первый запуск, привязка почты, выход: аккаунт без почты живёт сам, с почтой — по паролю

### 10. Первый вход приложения: отдельное согласие, «Продолжить» неактивно

![app-welcome](desktop/10-app-welcome.png)

### 11. После согласия открыт активный первый экран без повторной отметки

![app-welcome-home](desktop/11-app-welcome-home.png)

### 12. «Поговорить»: разговор открыт голосом, агент здоровается, окна про память нет

![app-welcome-voice](desktop/12-app-welcome-voice.png)

Сценарий: app-telegram.spec.ts › Mini App: аккаунт пользователя Telegram, повторный запуск без экранов, выход и вход через Telegram

### 13. Первый вход в Telegram: отдельный экран согласия

![tg-welcome](desktop/13-tg-welcome.png)

### 14. «Поговорить» в Telegram: аккаунт создан, разговор открыт, агент здоровается

![tg-voice](desktop/14-tg-voice.png)

Сценарий: landing.spec.ts › правовые страницы и страница удаления открываются

### 15. Публичный текст согласия: шесть пунктов, редакция и номер реестра

![consent-document](desktop/15-consent-document.png)

### 16. Из согласия открывается отдельная политика конфиденциальности

![consent-privacy](desktop/16-consent-privacy.png)

Сценарий: web-account.spec.ts › путь аккаунта в вебе: регистрация, профиль, смена пароля, вход, удаление

### 17. Регистрация: без отметки согласия кнопка неактивна

![register-consent-required](desktop/17-register-consent-required.png)

### 18. Регистрация: после явной отметки кнопка доступна

![register-consented](desktop/18-register-consented.png)

### 19. Лист «Голос агента»: открыт на мужских голосах, «Применить» неактивна

![voice-male-tab](desktop/19-voice-male-tab.png)

### 20. Вкладка женских голосов: у каждого можно прослушать пример

![voice-female-tab](desktop/20-voice-female-tab.png)

### 21. Выбрана Алиса: «Применить» стала активной

![voice-picked](desktop/21-voice-picked.png)

### 22. Голос сохранён: в профиле теперь Алиса

![voice-applied](desktop/22-voice-applied.png)

### 23. Путь Сбера: в профиле голос Вера, выбранная Алиса сохранена

![voice-sber](desktop/23-voice-sber.png)

Сценарий: web-account.spec.ts › профиль: разделы, строки и подстраницы

### 24. Регистрация: без отметки согласия кнопка неактивна

![register-consent-required](desktop/24-register-consent-required.png)

### 25. Регистрация: после явной отметки кнопка доступна

![register-consented](desktop/25-register-consented.png)

Сценарий: web-account.spec.ts › новая запись согласий: «Продолжить» закрыто до явной отметки

### 26. Новая запись согласий: кнопка неактивна до отметки

![terms-gate-required](desktop/26-terms-gate-required.png)

### 27. После явной отметки кнопка «Продолжить» доступна

![terms-gate-consented](desktop/27-terms-gate-consented.png)

Сценарий: web-anonymous.spec.ts › первый запуск: отдельное согласие, активная главная и разговор; потом без экранов

### 28. Первый вход: отдельное согласие без чата, «Продолжить» неактивно

![welcome](desktop/28-welcome.png)

### 29. После согласия открыт активный чат без повторной отметки

![welcome-home](desktop/29-welcome-home.png)

### 30. «Поговорить»: разговор открыт голосом, агент здоровается «Я рядом. С чего начнём?»

![welcome-voice](desktop/30-welcome-voice.png)

Сценарий: web-anonymous.spec.ts › первый запуск текстом: до ворота поля нет, после него Enter отправляет первое сообщение

### 31. После входного ворота человек набрал первую фразу

![welcome-typed](desktop/31-welcome-typed.png)

### 32. Разговор открыт текстом: приветствие, затем набранная фраза первым сообщением

![welcome-text](desktop/32-welcome-text.png)

Сценарий: web-anonymous.spec.ts › почта уже занята: что будет с разговорами сказано, путь в тот аккаунт есть

### 33. Регистрация: без отметки согласия кнопка неактивна

![register-consent-required](desktop/33-register-consent-required.png)

### 34. Регистрация: после явной отметки кнопка доступна

![register-consented](desktop/34-register-consented.png)

## mobile (412×839)

Сценарий: app-account.spec.ts › путь аккаунта: регистрация, вход, смена пароля, удаление

### 01. В приложении регистрация закрыта без отметки

![app-register-consent-required](mobile/01-app-register-consent-required.png)

### 02. После отметки регистрация доступна

![app-register-consented](mobile/02-app-register-consented.png)

### 03. Страница «Голос агента»: открыта на мужских голосах

![voice-male-tab](mobile/03-voice-male-tab.png)

Замечания по вёрстке: overlap: a.rd-profile-edit.button "Изменить имя" overlaps a.link.icon-only "Прослушать: Артём" by 11x19px; overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Сергей" by 28x20px; overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Андрей" by 28x10px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Андрей" by 28x18px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Иван" by 28x12px; text-overlap: p.rd-profile-email "account-1794160048104-7729@e" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-profile-email "account-1794160048104-7729@e" is printed over div.item-title "Дмитрий"; text-overlap: div.item-title "Изменить пароль" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: div.item-title "Что я помню" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-caption "Важное из наших разговоров, " is printed over i.icon.f7-icons "play_circle_fill"

### 04. Вкладка женских голосов: у каждого можно прослушать пример

![voice-female-tab](mobile/04-voice-female-tab.png)

### 05. Выбрана Алиса: «Голос сохранён»

![voice-saved](mobile/05-voice-saved.png)

### 06. В профиле теперь голос Алиса

![voice-profile](mobile/06-voice-profile.png)

Замечания по вёрстке: overlap: a.rd-profile-edit.button "Изменить имя" overlaps a.link.icon-only "Прослушать: Алиса" by 28x19px; overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Анна" by 28x20px; overlap: a.item-link "lock_fillИзменить пароль" overlaps a.link.icon-only "Прослушать: Елена" by 28x10px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Елена" by 28x18px; overlap: a.item-link "device_laptopУстройства и се" overlaps a.link.icon-only "Прослушать: Ольга" by 28x12px; text-overlap: p.rd-profile-email "account-1794160048104-7729@e" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: p.rd-profile-email "account-1794160048104-7729@e" is printed over div.item-title "Мария"; text-overlap: a.rd-profile-edit.button "Изменить имя" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: div.item-title "Изменить пароль" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: div.item-title "Что я помню" is printed over i.icon.f7-icons "play_circle_fill"; edge-text: div.title "Профиль" sits 7px from the window edge; edge-text: div.block-title "Аккаунт" sits 7px from the window edge; edge-text: div.block-title "Память" sits 7px from the window edge

### 07. Путь Сбера: на странице один голос — Вера, выбранная Алиса сохранена

![voice-sber](mobile/07-voice-sber.png)

Замечания по вёрстке: overlap: a.rd-profile-edit.button "Изменить имя" overlaps a.link.icon-only "Прослушать: Вера" by 28x28px; text-overlap: p.rd-profile-email "account-1794160048104-7729@e" is printed over p.rd-caption "Сейчас у агента один голос —"; text-overlap: a.rd-profile-edit.button "Изменить имя" is printed over i.icon.f7-icons "play_circle_fill"; text-overlap: a.rd-profile-edit.button "Изменить имя" is printed over div.item-title "Вера"; edge-text: div.title "Профиль" sits 2px from the window edge; edge-text: div.block-title "Аккаунт" sits 2px from the window edge; edge-text: div.block-title "Память" sits 2px from the window edge

Сценарий: app-account.spec.ts › новая запись согласий: «Продолжить» закрыто до явной отметки

### 08. В приложении новая запись согласий требует отметки

![app-terms-gate-required](mobile/08-app-terms-gate-required.png)

### 09. После отметки кнопка «Продолжить» доступна

![app-terms-gate-consented](mobile/09-app-terms-gate-consented.png)

Сценарий: app-anonymous.spec.ts › первый запуск, привязка почты, выход: аккаунт без почты живёт сам, с почтой — по паролю

### 10. Первый вход приложения: отдельное согласие, «Продолжить» неактивно

![app-welcome](mobile/10-app-welcome.png)

### 11. После согласия открыт активный первый экран без повторной отметки

![app-welcome-home](mobile/11-app-welcome-home.png)

### 12. «Поговорить»: разговор открыт голосом, агент здоровается, окна про память нет

![app-welcome-voice](mobile/12-app-welcome-voice.png)

Замечания по вёрстке: text-overlap: button.rd-inline-link.rd-home-people-link "Люди рядом — линии помощи" is printed over div.rd-voice-caption "Я рядом. С чего начнём?"

Сценарий: app-telegram.spec.ts › Mini App: аккаунт пользователя Telegram, повторный запуск без экранов, выход и вход через Telegram

### 13. Первый вход в Telegram: отдельный экран согласия

![tg-welcome](mobile/13-tg-welcome.png)

### 14. «Поговорить» в Telegram: аккаунт создан, разговор открыт, агент здоровается

![tg-voice](mobile/14-tg-voice.png)

Замечания по вёрстке: text-overlap: button.rd-inline-link.rd-home-people-link "Люди рядом — линии помощи" is printed over div.rd-voice-caption "Я рядом. С чего начнём?"

Сценарий: landing.spec.ts › правовые страницы и страница удаления открываются

### 15. Публичный текст согласия: шесть пунктов, редакция и номер реестра

![consent-document](mobile/15-consent-document.png)

### 16. Из согласия открывается отдельная политика конфиденциальности

![consent-privacy](mobile/16-consent-privacy.png)

Сценарий: web-account.spec.ts › путь аккаунта в вебе: регистрация, профиль, смена пароля, вход, удаление

### 17. Регистрация: без отметки согласия кнопка неактивна

![register-consent-required](mobile/17-register-consent-required.png)

### 18. Регистрация: после явной отметки кнопка доступна

![register-consented](mobile/18-register-consented.png)

### 19. Лист «Голос агента»: открыт на мужских голосах, «Применить» неактивна

![voice-male-tab](mobile/19-voice-male-tab.png)

### 20. Вкладка женских голосов: у каждого можно прослушать пример

![voice-female-tab](mobile/20-voice-female-tab.png)

### 21. Выбрана Алиса: «Применить» стала активной

![voice-picked](mobile/21-voice-picked.png)

### 22. Голос сохранён: в профиле теперь Алиса

![voice-applied](mobile/22-voice-applied.png)

### 23. Путь Сбера: в профиле голос Вера, выбранная Алиса сохранена

![voice-sber](mobile/23-voice-sber.png)

Сценарий: web-account.spec.ts › профиль: разделы, строки и подстраницы

### 24. Регистрация: без отметки согласия кнопка неактивна

![register-consent-required](mobile/24-register-consent-required.png)

### 25. Регистрация: после явной отметки кнопка доступна

![register-consented](mobile/25-register-consented.png)

Сценарий: web-account.spec.ts › новая запись согласий: «Продолжить» закрыто до явной отметки

### 26. Новая запись согласий: кнопка неактивна до отметки

![terms-gate-required](mobile/26-terms-gate-required.png)

### 27. После явной отметки кнопка «Продолжить» доступна

![terms-gate-consented](mobile/27-terms-gate-consented.png)

Сценарий: web-anonymous.spec.ts › первый запуск: отдельное согласие, активная главная и разговор; потом без экранов

### 28. Первый вход: отдельное согласие без чата, «Продолжить» неактивно

![welcome](mobile/28-welcome.png)

### 29. После согласия открыт активный чат без повторной отметки

![welcome-home](mobile/29-welcome-home.png)

### 30. «Поговорить»: разговор открыт голосом, агент здоровается «Я рядом. С чего начнём?»

![welcome-voice](mobile/30-welcome-voice.png)

Сценарий: web-anonymous.spec.ts › первый запуск текстом: до ворота поля нет, после него Enter отправляет первое сообщение

### 31. После входного ворота человек набрал первую фразу

![welcome-typed](mobile/31-welcome-typed.png)

### 32. Разговор открыт текстом: приветствие, затем набранная фраза первым сообщением

![welcome-text](mobile/32-welcome-text.png)

Сценарий: web-anonymous.spec.ts › почта уже занята: что будет с разговорами сказано, путь в тот аккаунт есть

### 33. Регистрация: без отметки согласия кнопка неактивна

![register-consent-required](mobile/33-register-consent-required.png)

### 34. Регистрация: после явной отметки кнопка доступна

![register-consented](mobile/34-register-consented.png)
