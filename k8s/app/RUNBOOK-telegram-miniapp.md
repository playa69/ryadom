# Выкат Telegram Mini App: api 0.7.0, pwa 0.6.0, миграция 0007

PWA становится Telegram Mini App бота [@slyshu_ryadom_bot](https://t.me/slyshu_ryadom_bot), в нём появляется вход через Telegram (PR #48).
Агент, web, лендинг и админка не меняются. Автоматические проверки после выката — [`k8s/postdeploy/`](../postdeploy/README.md),
новые — в `test_telegram.py`.

## Что внутри

| Что | Эффект |
|---|---|
| Миграция `0007_users_telegram_id`: `users.telegram_id bigint NULL` + `users_telegram_id_unique` | только добавление; api 0.6.1 колонку не замечает, поэтому миграция идёт первой |
| api 0.7.0: `POST /api/auth/telegram`, `POST /api/auth/telegram/link`, `telegramLinked` в пользователе и `/me` | без токена бота вход через Telegram выключен (`NOT_CONFIGURED`), остальное как в 0.6.1 |
| pwa 0.6.0: режим Mini App (вход по `initData`, кнопка «Назад» Telegram, без баннера установки) | вне Telegram ведёт себя как 0.5.1; скрипт Telegram в обычной вкладке не грузится |
| CSP PWA: `frame-ancestors https://web.telegram.org` вместо `'none'` | Telegram Web может показать Mini App во фрейме; другие сайты — нет |

Образы `cr.yandex/<реестр>/app/{migrate:0.7.0, api:0.7.0, pwa:0.6.0}` собраны из ветки `app/telegram-miniapp` (метка
`org.opencontainers.image.revision`; digest'ы — в описании PR выката). Теги `api:0.6.1`, `pwa:0.5.1`, `migrate:0.6.1` остаются для отката.

## Что нужно знать до выката

- **Токен бота — секрет.** Им можно подписать вход за любого пользователя Telegram. Он хранится у администратора и попадает
  в кластер только как Secret `app-telegram` (ключ `TELEGRAM_BOT_TOKEN`) в ns `prod`; в git, ConfigMap и журналы не попадает.
  Утечка — перевыпустить токен в BotFather (`/revoke`) и заменить Secret.
- **Порядок важен:** миграция до api (новый api читает `telegram_id`), api до pwa (новая pwa зовёт новые маршруты; старая
  pwa с новым api работает как раньше).
- **Простоя нет:** api и pwa раскатываются по одной реплике (`RollingUpdate`), миграция только добавляет колонку.
- **Откат:** `api:0.6.1`, `pwa:0.5.1` — `kubectl apply` манифестов предыдущей ревизии. Колонку можно оставить: старый код её
  не видит. Если всё же убирать — `ALTER TABLE users DROP COLUMN telegram_id` и запись 0007 в журнале drizzle; привязки к
  Telegram пропадут, такие аккаунты откроются только по почте.

## Шаги (под admin)

1. **Сверка с кластером** (read-only): `kubectl diff -f k8s/app/api/03-deployment.yaml -f k8s/app/pwa/03-deployment.yaml`.
   Ожидаем только образы `api:0.6.1 → 0.7.0`, `pwa:0.5.1 → 0.6.0` и новую переменную `TELEGRAM_BOT_TOKEN`. Что-то ещё —
   остановиться и разобраться.
2. **Secret с токеном** (создаёт администратор из своего хранилища секретов; только создание, без перезаписи):
   ```bash
   kubectl -n prod create secret generic app-telegram --from-literal=TELEGRAM_BOT_TOKEN=<токен из BotFather>
   ```
   Проверка без значения: `kubectl -n prod get secret app-telegram -o jsonpath='{.data}' | grep -c TELEGRAM_BOT_TOKEN` → `1`.
3. **Миграция:**
   ```bash
   kubectl apply -f k8s/app/db/04-job-migrate-0004.yaml
   kubectl -n prod wait --for=condition=complete job/app-migrate-0004 --timeout=180s
   kubectl -n prod logs job/app-migrate-0004
   kubectl -n prod delete job app-migrate-0003 --ignore-not-found
   ```
4. **api, затем pwa:**
   ```bash
   kubectl apply -f k8s/app/api/03-deployment.yaml
   kubectl -n prod rollout status deploy/app-api --timeout=300s
   kubectl apply -f k8s/app/pwa/03-deployment.yaml
   kubectl -n prod rollout status deploy/app-pwa --timeout=180s
   ```
5. **Проверки:** `cd k8s/postdeploy && POSTDEPLOY_BASELINE=<снимок> uv run --no-project --with requests --with websocket-client --with pytest python -m pytest -q --expect post`
   (вместе с общими — `test_telegram.py`: CSP PWA и включённый вход через Telegram, который отклоняет данные чужого бота).
6. **Вживую:** Telegram → `@slyshu_ryadom_bot` → «Открыть» (в приложении на телефоне и в Telegram Web):
   - первый экран с именем из Telegram и согласиями, «Начать» → главный экран;
   - закрыть и открыть снова → сразу главный экран, тот же аккаунт;
   - профиль: «Вход через Telegram», есть «Выйти из аккаунта» и «Устройства и сессии»;
   - разговор открывается, микрофон работает (в Telegram Web — если браузер дал доступ фрейму).

## Бот в BotFather (уже настроено)

- Имя «Рядом», описание, раздел «О боте», аватар.
- Кнопка меню «Открыть» и главный Mini App → `https://слышу-рядом.рф/pwa/`.
- Вебхука нет: бот не отвечает на сообщения, вход — кнопкой меню и ссылкой `https://t.me/slyshu_ryadom_bot?startapp`.
