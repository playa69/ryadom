# Доказательства: update-privacy-policy

- Ветка: `app/update-privacy-policy`
- Коммит: `73a936f0`
- Стенд: `privacy-policy`, слот 2 (веб-приложение http://127.0.0.1:20253, PWA http://127.0.0.1:20254)
- Снято: 2026-11-08 22:12 UTC
- Даты и время на снимках закрашены серым: снимок одного шага должен совпадать от прогона к прогону.

## desktop (1280×900)

Сценарий: app-anonymous.spec.ts › первый запуск, привязка почты, выход: аккаунт без почты живёт сам, с почтой — по паролю

### 01. Первый экран приложения: шар, «Поговорить», строка о согласии и 112, флажков нет

![app-welcome](desktop/01-app-welcome.png)

### 02. «Поговорить»: разговор открыт голосом, агент здоровается, окна про память нет

![app-welcome-voice](desktop/02-app-welcome-voice.png)

Сценарий: landing.spec.ts › правовые страницы и страница удаления открываются

### 03. Политика: предоставленный заголовок и шесть разделов

![privacy-document](desktop/03-privacy-document.png)

### 04. Разговор хранится 30 дней, неактивный аккаунт — 90 дней

![privacy-retention](desktop/04-privacy-retention.png)

### 05. Самопроверка: ответы и результаты только на устройстве

![privacy-self-check](desktop/05-privacy-self-check.png)

### 06. Обработчики, шифрование, маскирование, копии и журналы

![privacy-protection](desktop/06-privacy-protection.png)

Сценарий: landing.spec.ts › политика: адаптивные таблицы и отказ от аналитики

### 07. Таблица данных читается без горизонтальной прокрутки

![privacy-tables](desktop/07-privacy-tables.png)

### 08. Отказ от аналитики сохраняется после перезагрузки

![privacy-opt-out](desktop/08-privacy-opt-out.png)

Сценарий: landing.spec.ts › политика описывает согласие на Метрику, а связь ведёт на почту Оператора

### 09. Блок «Связь» ведёт на playasn@yandex.ru

![operator-email](desktop/09-operator-email.png)

Сценарий: web-anonymous.spec.ts › первый запуск: строка о согласии, «Поговорить» — и сразу разговор; потом без экранов

### 10. Первый экран: шар, поле «Напиши или скажи», строка о согласии и 112, флажков нет

![welcome](desktop/10-welcome.png)

### 11. «Поговорить»: разговор открыт голосом, агент здоровается «Я рядом. С чего начнём?»

![welcome-voice](desktop/11-welcome-voice.png)

Сценарий: web-anonymous.spec.ts › первый запуск текстом: набранное уходит первым сообщением после приветствия

### 12. Человек набрал первую фразу на первом экране

![welcome-typed](desktop/12-welcome-typed.png)

### 13. Разговор открыт текстом: приветствие, затем набранная фраза первым сообщением

![welcome-text](desktop/13-welcome-text.png)

## mobile (412×839)

Сценарий: app-anonymous.spec.ts › первый запуск, привязка почты, выход: аккаунт без почты живёт сам, с почтой — по паролю

### 01. Первый экран приложения: шар, «Поговорить», строка о согласии и 112, флажков нет

![app-welcome](mobile/01-app-welcome.png)

### 02. «Поговорить»: разговор открыт голосом, агент здоровается, окна про память нет

![app-welcome-voice](mobile/02-app-welcome-voice.png)

Замечания по вёрстке: text-overlap: p.rd-fineprint.rd-welcome-sos "В опасной ситуации звони 112" is printed over div.rd-voice-caption "Я рядом. С чего начнём?"; text-overlap: button.rd-inline-link.rd-home-people-link "Люди рядом — линии помощи" is printed over p.rd-voice-hint "Нажми на шар и говори"

Сценарий: landing.spec.ts › правовые страницы и страница удаления открываются

### 03. Политика: предоставленный заголовок и шесть разделов

![privacy-document](mobile/03-privacy-document.png)

### 04. Разговор хранится 30 дней, неактивный аккаунт — 90 дней

![privacy-retention](mobile/04-privacy-retention.png)

### 05. Самопроверка: ответы и результаты только на устройстве

![privacy-self-check](mobile/05-privacy-self-check.png)

### 06. Обработчики, шифрование, маскирование, копии и журналы

![privacy-protection](mobile/06-privacy-protection.png)

Сценарий: landing.spec.ts › политика: адаптивные таблицы и отказ от аналитики

### 07. Таблица данных читается без горизонтальной прокрутки

![privacy-tables](mobile/07-privacy-tables.png)

### 08. Отказ от аналитики сохраняется после перезагрузки

![privacy-opt-out](mobile/08-privacy-opt-out.png)

Сценарий: landing.spec.ts › политика описывает согласие на Метрику, а связь ведёт на почту Оператора

### 09. Блок «Связь» ведёт на playasn@yandex.ru

![operator-email](mobile/09-operator-email.png)

Сценарий: web-anonymous.spec.ts › первый запуск: строка о согласии, «Поговорить» — и сразу разговор; потом без экранов

### 10. Первый экран: шар, поле «Напиши или скажи», строка о согласии и 112, флажков нет

![welcome](mobile/10-welcome.png)

### 11. «Поговорить»: разговор открыт голосом, агент здоровается «Я рядом. С чего начнём?»

![welcome-voice](mobile/11-welcome-voice.png)

Сценарий: web-anonymous.spec.ts › первый запуск текстом: набранное уходит первым сообщением после приветствия

### 12. Человек набрал первую фразу на первом экране

![welcome-typed](mobile/12-welcome-typed.png)

### 13. Разговор открыт текстом: приветствие, затем набранная фраза первым сообщением

![welcome-text](mobile/13-welcome-text.png)
