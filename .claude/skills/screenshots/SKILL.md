---
name: screenshots
description: Снять скриншоты экранов «Рядом» (web, PWA, админка, лендинг) на поднятом стенде — только нужные экраны и ширины, с проверкой вёрстки на глюки, сравнение «до/после» и вложения в задачу или PR. Использовать при просьбах «покажи скриншоты», «сделай отчёт со скриншотами», «как это выглядит на телефоне», «сравни до и после», перед отчётом о правке интерфейса.
---

# Скриншоты

Снимает не браузер руками, а `app/e2e/scripts/ui-shots.mjs`: для каждого экрана и ширины открывает чистый
контекст, поднимает экран, ждёт, проверяет вёрстку на глюки (страница шире окна, обрезанный текст, наложения,
пустой экран) и только потом снимает. Экраны описаны в `app/e2e/scripts/shots/<app>.mjs` (`web`, `mobile`,
`admin`, `landing`): новый экран добавляется туда же, рядом с похожими.

## Сколько снимать

- **Правка по ходу задачи** — только экраны, которые она меняет, на двух ширинах: 390 (телефон) и 1280 (компьютер).
  Это минуты, а не полчаса.
- **Финальный отчёт** (человек спрашивает «готово?», PR идёт на слияние) — затронутые экраны на всех четырёх ширинах
  (390, 820, 1280, 1920) или полный набор (ниже).
- **Видео** — только если о нём попросили.

## Стенд и вход

Нужен поднятый стенд разработки: на машине агента — `app-up` (адреса в его выводе), иначе `pnpm dev` (скилл
`local-dev`). Адреса передаются флагами: `--base` (приложение), `--agent` (мок агента), `--mail` (Mailpit). Из
каталога `app/`:

```bash
# один раз на стенд: демо-аккаунт «Женя» с журналом разговоров; сессия ляжет в .playwright-mcp/web-state.json
node e2e/scripts/demo-account.mjs --base http://localhost:4003 --mail http://localhost:4025 --agent http://127.0.0.1:4080
node e2e/scripts/ui-shots.mjs --app mobile --login --base http://localhost:4004       # входит тем же демо-аккаунтом
node e2e/scripts/ui-shots.mjs --app admin --login --base http://localhost:4001 --mail http://localhost:4025
```

(Порты в примерах — `app-up` в слоте 0: landing 4000, admin 4001, web 4003, PWA 4004, Mailpit 4025, мок 4080.)

## Снимок

```bash
node e2e/scripts/ui-shots.mjs --app web --base http://localhost:4003 --agent http://127.0.0.1:4080 \
  --screens home,profile --widths 390,1280 --out ../screenshots/after
node e2e/scripts/ui-shots.mjs --app mobile --base http://localhost:4004 --agent http://127.0.0.1:4080 --screens home,dialog
```

Файлы — `<app>-<экран>-<ширина>.png`, по умолчанию в `screenshots/` в корне репозитория (в git не попадает).
Под именем каждого снимка скрипт печатает найденные глюки; `--strict` не сохраняет снимок с глюком, код выхода 1 —
были глюки или экран не открылся. Глюк — повод поправить вёрстку до отчёта, а не подпись к скриншоту.

Экраны: web — `home`, `dialog`, `dialog-voice`, `dialog-summary`, `journal`, `journal-entry`, `profile`, `people`,
`sos`, `menu`, `login`, `register` и др.; mobile — `welcome`, `home`, `dialog`, `dialog-end`, `journal`, `profile`,
`people`, `sos` и др.; admin — `login`, `users`, `user-card`, `audit`; landing — `home`, `privacy`, `terms`,
`download`, `delete-account`. Полный список — ключи `screens` в `shots/<app>.mjs`.

## До и после

```bash
node e2e/scripts/ui-shots.mjs --app web … --screens home --out /tmp/shots-before   # до правки
node e2e/scripts/ui-shots.mjs --app web … --screens home --out /tmp/shots-after    # после
node e2e/scripts/ui-diff.mjs --a /tmp/shots-before --b /tmp/shots-after --out /tmp/shots-diff
```

`ui-diff.mjs` пишет, на сколько процентов изменилась каждая картинка, и кладёт `<имя>-diff.png` с изменёнными
пикселями. Рефакторинг, который не должен менять вид, — около 0 %; всё, что заметит человек, — несколько процентов.

## Полный набор

Для финального обзора всего интерфейса — `node e2e/scripts/review-shots.mjs` (PWA и лендинг) и
`node e2e/scripts/review-web-shots.mjs` (веб) в `review/`. Им нужен стенд e2e (`node e2e/scripts/stack.mjs`, скилл
`e2e`), снимают они всё и долго — не для каждой правки.

## В отчёт

- Задача Multica: `multica issue comment add <ID> --content-file report.md --attachment shot1.png --attachment shot2.png`
  (файлы вне текущего каталога — с `--allow-external-file`).
- PR: картинки комментарием `gh pr comment --body-file`, файлы — в отдельной orphan-ветке `assets/pr-<N>-screenshots`,
  не в ветке PR.
- Показывай только изменившиеся экраны и подписывай, что на каждом и на какой ширине. Перед отправкой посмотри снимки
  сам: оверлей dev-сервера Next или недогруженный экран — не скриншот «после».

Связано: [[e2e]] — стенд e2e и полный прогон; [[local-dev]] — стенд разработки и вход.
