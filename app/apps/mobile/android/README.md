# Android: подпись сборок

## Командный debug-ключ

Debug-сборки (`devDebug`, `prodDebug`) у всех в команде подписываются одним ключом
`app/apps/mobile/android/keystores/debug.keystore`. Пуш-проект RuStore принимает один отпечаток SHA-256: с личными
ключами из `~/.android/debug.keystore` тестовые пуши доходили бы только до сборок одного человека.

Папка `keystores/` в git не попадает (`app/.gitignore`). Если ключа нет, Gradle пишет предупреждение и подписывает
сборку личным ключом: собрать и запустить можно, пуши RuStore не придут.

### Перед началом работы

Ключ лежит в каждом worktree отдельно, поэтому шаги повторяются в новом worktree.

1. Нужны [yc CLI](https://yandex.cloud/ru/docs/cli/quickstart), вход в аккаунт (`yc init`) и право читать секрет
   `ryadom-app-secrets` в Yandex Lockbox. Право выдаёт администратор.
2. Из `app/apps/mobile`:

   ```bash
   pnpm android:debug-key                       # активный профиль yc
   YC_PROFILE=<профиль> pnpm android:debug-key  # другой профиль
   ```

   Скрипт берёт запись `ANDROID_DEBUG_KEYSTORE` (base64) и кладёт файл в `android/keystores/debug.keystore`.

3. Проверка из `app/apps/mobile/android`: `./gradlew :app:signingReport` (Windows: `gradlew.bat :app:signingReport`).
   У вариантов `devDebug` и `prodDebug` должно быть:

   ```
   SHA-256: CD:53:25:4E:35:6A:F0:09:5C:62:85:B0:2A:A5:F4:56:43:80:21:A4:9E:B1:2B:C0:BB:AD:8A:B4:6F:F0:92:D6
   ```

4. Сборку с личной подписью, которая уже стоит на телефоне, Android поверх не обновит: удали её
   (`adb uninstall <пакет>`) и поставь заново.

Без скрипта: раскодируй значение записи `ANDROID_DEBUG_KEYSTORE` из base64 в `android/keystores/debug.keystore`.
Пароль хранилища и ключа — `android`, alias — `androiddebugkey` (стандартные для debug-ключа Android, их задаёт
`app/build.gradle`).

Отпечаток вводят в тестовый пуш-проект RuStore (пакет debug-сборки с суффиксом `.dev`). Флаг production у этого
проекта не ставят.

## Сборка в Codemagic

Debug- и релизные сборки для команды и агентов собирает Codemagic (`codemagic.yaml` в корне репозитория,
macOS M2: бесплатные минуты есть только там). Репозиторий подключён по ссылке, поэтому сборки по push нет — их
запускает скрипт из `app/apps/mobile`:

```bash
pnpm android:ci debug                            # devDebug, APK с командным debug-ключом, текущая ветка
pnpm android:ci debug --branch <ветка>
pnpm android:ci release --version-code <номер>   # prodRelease: AAB и APK с релизным ключом
```

- Codemagic собирает ветку с GitHub, не рабочий каталог: сначала закоммить и запушь. Если локальная ветка
  расходится с GitHub, `debug` предупреждает, а `release` не запускается. Первый шаг сборки сверяет коммит
  (`EXPECTED_SHA`), чтобы не собрать то, что запушили между проверкой и клоном.
- Скрипт читает из Lockbox токен API Codemagic (`ryadom-cluster-access`, запись `codemagic-api-token`) и ключи
  подписи (`ryadom-app-secrets`: `ANDROID_DEBUG_KEYSTORE` или `ANDROID_RELEASE_*`) и передаёт их переменными в
  запросе на одну сборку. Групп переменных в Codemagic нет, копии ключей там не хранятся. Нужны yc CLI и право
  читать эти секреты, профиль задаётся `YC_PROFILE`.
- `--version-code` строго больше номера последней выпущенной сборки, `versionName` берётся из
  `app/apps/mobile/package.json`.
- Скрипт ждёт окончания сборки (ссылка на её страницу с журналом — в выводе) и скачивает результат в
  `android/ci-artifacts/<id сборки>/` (в git не попадает).

## Релизный ключ

На компьютерах разработчиков его нет. Релиз подписывается, только когда заданы `RYADOM_KEYSTORE_PATH`,
`RYADOM_KEYSTORE_PASSWORD`, `RYADOM_KEY_ALIAS` и `RYADOM_KEY_PASSWORD` (спека `native-app-build`); без них релиз
собирается неподписанным. В Codemagic их выставляет `android-release` из переменных запуска.
