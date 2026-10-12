# Релей к Gemini API (Hetzner + Caddy)

Ранбук маленького сервера, через который агент ходит в Gemini Live. Нужен только при `VOICE_PIPELINE=gemini_live`
(см. [agent/README.md](../README.md), «Режим gemini_live»). В каскадном режиме (`cascade`, по умолчанию) релей не используется.

Шаблон cloud-init, по которому сервер настраивается сам: [cloud-init.yaml](cloud-init.yaml). Его не правим руками на сервере:
меняем шаблон и пересоздаём сервер.

## Зачем и как устроен

Из России Google отвечает на запросы к Gemini API «User location is not supported». Агент живёт в кластере Timeweb
(Москва), поэтому его трафик к `generativelanguage.googleapis.com` идёт через маленький сервер в поддерживаемой стране.

```
агент (k8s, Timeweb Москва)
   │  HTTPS / WSS, заголовок X-Relay-Token
   ▼
VPS Hetzner (hel1 / fsn1 / nbg1): Caddy на <ip-через-дефисы>.sslip.io, сертификат Let's Encrypt (HTTP-01)
   │  HTTPS / WSS, X-Relay-Token срезан
   ▼
generativelanguage.googleapis.com
```

- Имя хоста строится из публичного IPv4 сервера: IP `203.0.113.7` даёт `203-0-113-7.sslip.io`. sslip.io — бесплатный DNS,
  который отдаёт этот IP по имени; своего домена не нужно. Сертификат Caddy получает сам при первом запуске (порт 80).
- Caddy проксирует и обычные запросы, и WebSocket Live API. Правила:

| Запрос | Ответ |
|---|---|
| `GET /_relay_health` | `200 ok`, токен не нужен |
| любой другой без верного `X-Relay-Token` | `403 forbidden` |
| любой другой с верным токеном | уходит в Google как есть; заголовок `X-Relay-Token` перед пересылкой срезается |

- Ключ Gemini остаётся у агента и идёт в каждом запросе (заголовок `x-goog-api-key`). Релей его не хранит и не пишет в
  лог: в Caddyfile нет директивы `log`, access-лога нет.

### Что видит релей и что из этого следует

TLS заканчивается на релее, а к Google Caddy открывает новое соединение. Значит, на сервере в открытом виде проходят
**голос пользователей** (PCM 16 кГц), расшифровки реплик, ответы модели и **ключ Gemini**. Следствия:

1. Доступ к серверу равен доступу к этим данным. SSH только по ключу, один администратор, на сервер ничего лишнего не ставить.
2. `GEMINI_API_KEY` для этого режима заводить отдельным ключом, чтобы его можно было отозвать, не задев ничего другого
   (при сворачивании релея и при подозрении на утечку ключ отзывается, см. последний раздел).
3. Голос и тексты уходят за пределы РФ дважды: на Hetzner (Финляндия или Германия) и в Google. Для персональных данных
   это нужно подтвердить, как и для прокси в agent/README.md («Модели»).
4. Токен релея защищает сервер от чужого использования (без него это был бы бесплатный прокси к Gemini на ваш ключ и счёт).
   Шифрования и защиты данных он не добавляет.

## Текущее состояние

Заполняется после создания сервера и при каждом изменении (смена типа, пересоздание, смена IP).

| Поле | Значение |
|---|---|
| Проект Hetzner | `ryadom-gemini-relay` (отдельный от остальных проектов, расходы оплачивает сам владелец) |
| Сервер | `gemini-relay` (ID проекта и сервера — в консоли Hetzner) |
| Тип | CAX11 (Arm64 Ampere, 2 vCPU, 4 ГБ RAM, 40 ГБ SSD). `CX23` в Хельсинки на момент создания был недоступен («Limited availability»), CAX11 был самым дешёвым доступным |
| Образ | Ubuntu 26.04 LTS (список версий в форме создания не переключился на 24.04, пакеты `caddy`, `ufw`, `curl` в 26.04 есть) |
| Локация | Helsinki (hel1) |
| Публичный IPv4 | только IPv4, IPv6 выключен; адрес и хост релея (`GEMINI_BASE_URL=https://<ip-через-дефисы>.sslip.io`) хранятся локально у администратора |
| Цена в месяц | $9,18 с НДС 21% (сервер $8,46 + IPv4 $0,73), по консоли на 2026-10-12 |
| Дата создания | 2026-10-12 |
| Проверено | health `ok`, без токена 403, с токеном ответ Google; Gemini Live через релей: соединение 0,76 с, первый звук 0,62 с |

## Создание

Подходят оба способа, результат одинаковый. Названия типов серверов Hetzner меняются, поэтому перед созданием сверься
со списком в консоли или `hcloud server-type list` (нужен самый дешёвый x86 с «Shared vCPU»; на момент написания это `cx23`).

### Подготовка (общая)

Рабочий каталог лежит **вне репозитория**: в нём ключ SSH, токен и шаблон с подставленным токеном. Значения секретов
хранятся локально у администратора, в git их нет.

PowerShell (Windows PowerShell 5.1), из корня репозитория:

```powershell
$work = "$env:USERPROFILE\gemini-relay-local"
New-Item -ItemType Directory -Force $work | Out-Null

# 1. Ключ SSH для сервера (парольная фраза желательна)
ssh-keygen -t ed25519 -f "$work\relay_ed25519" -C gemini-relay

# 2. Случайный токен релея: 24 байта = 48 hex-символов. В консоль не печатаем
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
[IO.File]::WriteAllText("$work\gemini.env", "GEMINI_RELAY_TOKEN=$token`n")   # для Secret'а кластера, ниже допишем GEMINI_API_KEY

# 3. Подставить токен в шаблон: UTF-8 без BOM и переводы строк LF (cloud-init не принимает BOM и CRLF)
$src = (Resolve-Path agent\relay\cloud-init.yaml).Path
$text = [IO.File]::ReadAllText($src).Replace('__RELAY_TOKEN__', $token).Replace("`r`n", "`n")
[IO.File]::WriteAllText("$work\cloud-init.rendered.yaml", $text, (New-Object Text.UTF8Encoding($false)))
Remove-Variable token, text, bytes

# 4. Проверка: заглушки в готовом файле не осталось (команда ничего не выводит)
Select-String -Path "$work\cloud-init.rendered.yaml" -Pattern '__RELAY_TOKEN__'
```

bash (WSL или Git Bash), из корня репозитория:

```bash
work=~/gemini-relay-local
mkdir -p "$work" && chmod 700 "$work"

ssh-keygen -t ed25519 -f "$work/relay_ed25519" -C gemini-relay

TOKEN=$(openssl rand -hex 24)                                   # 48 hex-символов
printf 'GEMINI_RELAY_TOKEN=%s\n' "$TOKEN" > "$work/gemini.env" && chmod 600 "$work/gemini.env"
sed "s/__RELAY_TOKEN__/$TOKEN/" agent/relay/cloud-init.yaml | tr -d '\r' > "$work/cloud-init.rendered.yaml"
unset TOKEN

grep -c __RELAY_TOKEN__ "$work/cloud-init.rendered.yaml"        # должно быть 0
```

Дальше в командах каталог называется `~/gemini-relay-local`. Если файлы созданы в PowerShell, а команды идут из WSL, подставляй
`/mnt/c/Users/<имя>/gemini-relay-local`.

### Способ 1. Консоль Hetzner (в браузере)

1. Открой консоль Hetzner Cloud (console.hetzner.com, раньше console.hetzner.cloud). **Projects → New project**, имя
   `ryadom-gemini-relay`. Новый проект, а не существующий: почему, см. «Стоимость».
2. В проекте **Security → SSH keys → Add SSH key**: вставь содержимое `relay_ed25519.pub` (не приватный ключ!), имя `gemini-relay-key`.
3. **Servers → Add server** (в проекте `ryadom-gemini-relay`):
   - **Location**: Helsinki (`hel1`), он ближе всего к Москве; запасные Falkenstein (`fsn1`) и Nuremberg (`nbg1`).
   - **Image**: Ubuntu 24.04.
   - **Type**: Shared vCPU, самый дешёвый x86 (на момент написания `CX23`; названия меняются).
   - **Networking**: **Public IPv4 включён** (обязательно, имя хоста строится из него), IPv6 по желанию.
   - **SSH keys**: отметь `gemini-relay-key`. Пароль root не нужен.
   - **Backups, Volumes, Firewalls, Networks, Placement groups**: не включать (Backups платные и релею не нужны).
   - **Cloud config**: вставь **целиком** содержимое `cloud-init.rendered.yaml` (токен уже внутри). В тексте не должно остаться
     `__RELAY_TOKEN__`. В старых версиях консоли поле называется «User data».
   - **Name**: `gemini-relay`. **Create & Buy now**.
4. Когда сервер появится в списке, скопируй его публичный IPv4. Хост релея: IP, где точки заменены дефисами, плюс
   `.sslip.io` (`203.0.113.7` → `203-0-113-7.sslip.io`). Впиши IP, хост, тип, цену и дату в «Текущее состояние».
5. Подожди 3-5 минут (первый запуск обновляет пакеты и получает сертификат) и переходи к «Проверке».

### Способ 2. `hcloud` CLI (для справки)

Установка: https://github.com/hetznercloud/cli. API-токен проекта: консоль → проект `ryadom-gemini-relay` → **Security → API tokens →
Generate API token** с правом Read & Write (после создания сервера токен можно отозвать).

```bash
cd ~/gemini-relay-local
hcloud context create ryadom-gemini-relay          # спросит API-токен проекта и запомнит его под этим именем
hcloud server-type list                            # сверить названия: cx23 может быть переименован
hcloud ssh-key create --name gemini-relay-key --public-key-from-file relay_ed25519.pub
hcloud server create --name gemini-relay --type cx23 --image ubuntu-24.04 --location hel1 \
  --ssh-key gemini-relay-key --user-data-from-file cloud-init.rendered.yaml --label purpose=gemini-relay
hcloud server ip gemini-relay                      # публичный IPv4
echo "$(hcloud server ip gemini-relay | tr . -).sslip.io"     # хост релея
```

### После создания

Через 3-5 минут зайди на сервер и убедись, что cloud-init закончил, а Caddy запущен:

```bash
ssh -i ~/gemini-relay-local/relay_ed25519 root@<IPv4>
cloud-init status --wait           # status: done (если error: tail -n 80 /var/log/cloud-init-output.log)
systemctl is-active caddy          # active
cat /root/relay-host.txt           # хост, под которым Caddy получает сертификат
chmod 0700 /usr/local/bin/gemini-relay-setup.sh      # в скрипте лежит токен, читать его должен только root
```

Готовый `cloud-init.rendered.yaml` с токеном внутри больше не нужен: после проверки удали его (токен лежит ещё в `gemini.env`).

## Подключение агента

| Переменная | Значение | Где |
|---|---|---|
| `VOICE_PIPELINE` | `gemini_live` | ConfigMap |
| `GEMINI_BASE_URL` | `https://<хост>`, без слэша на конце и без пути | ConfigMap |
| `GEMINI_RELAY_TOKEN` | токен релея | Secret |
| `GEMINI_API_KEY` | ключ Gemini API | Secret |

Остальные настройки `GEMINI_*` необязательны: таблица с умолчаниями в agent/README.md, «Режим gemini_live».

**Локально** (`agent/.env`, в git не попадает): те же четыре переменные, значения из `gemini.env` и ключ Gemini.

**В k8s** (ns `agent`, нужен админский kubeconfig, как в [k8s/agent/README.md](../../k8s/agent/README.md)):

1. ConfigMap `agent-config`: добавить в `data` файла `k8s/agent/00-config.yaml` строки `VOICE_PIPELINE: "gemini_live"` и
   `GEMINI_BASE_URL: "https://<хост>"`, затем `kubectl apply -f k8s/agent/00-config.yaml`.
2. Secret `agent-gemini` (отдельный, существующий `agent-secrets` не трогаем). Допиши в `gemini.env` строку
   `GEMINI_API_KEY=<ключ>` (значения у администратора) и создай Secret, значения не печатая:

   ```bash
   kubectl -n agent create secret generic agent-gemini --from-env-file="$HOME/gemini-relay-local/gemini.env"
   ```

   Не выводи Secret (`get -o yaml` и т. п.). Чтобы заменить значения у существующего:
   `kubectl -n agent create secret generic agent-gemini --from-env-file=... --dry-run=client -o yaml | kubectl apply -f -`
   (в консоль идёт только «configured»).
3. Deployment читает секреты поимённо, поэтому в `env` контейнера `agent` в `k8s/agent/02-deployment.yaml` нужны две записи
   (`optional: true`, чтобы каскадный режим жил и без них):

   ```yaml
   - name: GEMINI_API_KEY
     valueFrom:
       secretKeyRef: {name: agent-gemini, key: GEMINI_API_KEY, optional: true}
   - name: GEMINI_RELAY_TOKEN
     valueFrom:
       secretKeyRef: {name: agent-gemini, key: GEMINI_RELAY_TOKEN, optional: true}
   ```

   Применить: `kubectl apply -f k8s/agent/02-deployment.yaml`.
4. Перезапуск, чтобы агент прочитал ConfigMap: `kubectl -n agent rollout restart deploy/agent`, затем
   `kubectl -n agent rollout status deploy/agent --timeout=180s`. Реплика одна и `Recreate`: диалоги в памяти пропадут, агент
   недоступен около минуты.
5. Сеть: исходящий `:443` в любой адрес агенту уже разрешён (`k8s/namespaces/manifests/05-network-policy-agent.yaml`), отдельное
   правило для релея не нужно. Если политику когда-нибудь сузят до списка адресов, добавить IP релея на `:443`.

## Проверка

Команды bash (в PowerShell пиши `curl.exe`, не `curl`). Секреты вводятся без эха и в историю не попадают.

**1. Сам релей** (с любой машины):

```bash
HOST=<хост>                                    # 203-0-113-7.sslip.io
read -rsp 'Токен релея: ' RELAY_TOKEN; echo
read -rsp 'Ключ Gemini: ' GEMINI_API_KEY; echo

curl -sS -i "https://$HOST/_relay_health"                                  # HTTP 200, тело: ok
curl -sS -i "https://$HOST/v1beta/models"                                  # HTTP 403, тело: forbidden
curl -sS -i -H "X-Relay-Token: $RELAY_TOKEN" -H "x-goog-api-key: $GEMINI_API_KEY" \
  "https://$HOST/v1beta/models?pageSize=1"                                 # HTTP 200 и JSON {"models": [...]}
```

| Что видишь | Причина |
|---|---|
| ошибка TLS или таймаут на `/_relay_health` | Caddy ещё не получил сертификат или порт 80/443 закрыт: `journalctl -u caddy` на сервере |
| `403` с верным токеном | токен в Caddyfile другой (см. «Смена токена») |
| `400`, `API key not valid` | релей работает, ключ Gemini неверный |
| `User location is not supported` | запрос ушёл не через релей (проверь URL) или сервер в неподдерживаемой стране |

**2. Релей из кластера** (тем же путём, каким ходит агент; канал Москва → Hetzner зависит от провайдеров, поэтому проверяй и отсюда):

```bash
kubectl -n agent exec deploy/agent -- python -c "import urllib.request as u; print(u.urlopen('https://<хост>/_relay_health', timeout=10).read())"
# b'ok'
```

**3. Агент:**

```bash
kubectl -n agent port-forward svc/agent 18001:8001 &
curl -s http://127.0.0.1:18001/health/ready
# {"status":"ok","pipeline":"gemini-live:<модель>","tts":"gemini-live:<модель>","llm":"none","stt":"none"}
```

`"pipeline": "cascade"` значит, что режим не включён (ConfigMap не применён или агент не перезапущен). `/health/ready` Gemini не
опрашивает: он показывает только выбранный режим, живость связи проверяется следующим пунктом.

**4. Live целиком:**

```bash
# Старт и прогрев: приветствия и кризисный ответ обоими голосами озвучиваются через Gemini Live (12 коротких сессий)
kubectl -n agent logs deploy/agent | grep -E "agent started|прогрев|gemini live"
# agent started: pipeline=gemini-live:<модель> ...
# прогрев озвучки закончен: озвучено 12, не удалось 0     <- не 0 неудач: смотри строки «прогрев озвучки не удался»
```

Ручная проба с тем же клиентом и теми же настройками, что у агента (шлёт фразу текстом и считает байты звука в ответе).
Сохрани скрипт как `live_probe.py` и запусти в поде, где переменные `GEMINI_*` уже заданы, значения нигде не печатаются:

```python
import asyncio
import os

from google import genai
from google.genai import types


async def main() -> None:
    headers = {"X-Relay-Token": os.environ["GEMINI_RELAY_TOKEN"]} if os.environ.get("GEMINI_RELAY_TOKEN") else None
    client = genai.Client(
        api_key=os.environ["GEMINI_API_KEY"],
        http_options=types.HttpOptions(base_url=os.environ.get("GEMINI_BASE_URL"), headers=headers),
    )
    model = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.8-live")
    config = types.LiveConnectConfig(response_modalities=["AUDIO"])
    async with client.aio.live.connect(model=model, config=config) as session:
        turn = types.Content(role="user", parts=[types.Part(text="Скажи одно слово: привет.")])
        await session.send_client_content(turns=turn, turn_complete=True)
        size = 0
        async for message in session.receive():
            size += len(message.data or b"")
            if message.server_content and message.server_content.turn_complete:
                break
    print("Live работает, получено байт звука:", size)


asyncio.run(main())
```

```bash
kubectl -n agent exec -i deploy/agent -- python - < live_probe.py       # в кластере
cd agent && GEMINI_API_KEY=… GEMINI_BASE_URL=… GEMINI_RELAY_TOKEN=… uv run python live_probe.py   # локально
```

Итог проверки: на сайте голосовой диалог → в логах агента нет `gemini live not available` и `gemini live closed`, ответ
звучит голосом Gemini (`GET /health/ready` и метрика `agent_voice_latency_seconds{stage="first_sound"}` показывают задержку).

## Эксплуатация

Вход на сервер: `ssh -i ~/gemini-relay-local/relay_ed25519 root@<IPv4>`.

**Логи и состояние.** Access-лога нет, в журнале только служебные записи Caddy (получение и продление сертификата, ошибки).
Access-лог (`log` в Caddyfile) без нужды не включай: в нём окажутся адреса запросов и метаданные.

```bash
journalctl -u caddy -n 100 --no-pager        # последние записи
journalctl -u caddy -f                       # в реальном времени
journalctl -u caddy | grep -i "certificate obtained"    # сертификат получен
systemctl status caddy
```

**Смена токена** (при подозрении на утечку, после ухода человека с доступом). Новый токен делается так же, как при
создании (раздел «Подготовка», пункт 2; заменить строку в `gemini.env`). Шаги подряд, в момент без разговоров: между шагами 2 и 3
новые соединения получают `403`.

1. Обнови `GEMINI_RELAY_TOKEN` в `gemini.env`.
2. На сервере (под root), токен вставляется скрытым вводом:

   ```bash
   read -rsp 'Новый токен: ' NEW; echo
   OLD=$(awk '/not header X-Relay-Token/ {print $NF}' /etc/caddy/Caddyfile)
   sed -i "s/$OLD/$NEW/" /etc/caddy/Caddyfile /usr/local/bin/gemini-relay-setup.sh    # скрипт тоже: иначе он вернёт старый токен
   chown root:caddy /etc/caddy/Caddyfile && chmod 0640 /etc/caddy/Caddyfile
   unset OLD NEW
   caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
   ```

3. В кластере обнови Secret и перезапусти агента:

   ```bash
   kubectl -n agent create secret generic agent-gemini --from-env-file="$HOME/gemini-relay-local/gemini.env" --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n agent rollout restart deploy/agent
   ```

4. Проверь по разделу «Проверка» (пункты 1, 3, 4): старый токен даёт `403`, новый `200`.

**Обновление пакетов.** Критичные обновления Ubuntu ставит `unattended-upgrades`. Раз в месяц вручную:

```bash
apt update && apt -y upgrade
[ -f /var/run/reboot-required ] && reboot       # Caddy поднимется сам (enabled)
```

**Смена типа сервера** (IP сохраняется, но сервер на время выключается; архитектура должна остаться x86; `--keep-disk`
оставляет диск прежним, чтобы тип можно было вернуть). В консоли: сервер → **Rescale**. Через CLI:

```bash
hcloud server poweroff gemini-relay
hcloud server change-type --keep-disk gemini-relay <новый-тип>        # типы: hcloud server-type list
hcloud server poweron gemini-relay
```

**Смена IP.** Хост sslip.io привязан к IP, поэтому при новом IP (сервер пересоздан или IP заменён) хост меняется:

1. Новый сервер по cloud-init сам настроит Caddy под новый хост. Если IP сменился у того же сервера, на сервере:
   `/usr/local/bin/gemini-relay-setup.sh && systemctl restart caddy` (Caddyfile пересоздаётся по текущему IP), и `cat /root/relay-host.txt`.
2. Впиши новый хост в «Текущее состояние» и в `GEMINI_BASE_URL` (ConfigMap `agent-config`), примени и перезапусти агента.
3. Старый хост в Secret'ах не хранится, токен менять не обязательно.

**Лимит Let's Encrypt.** Не больше 5 сертификатов на один и тот же набор имён в неделю и 5 неудачных проверок в час. Перезапуски
Caddy и перезагрузки сервера сертификат не перевыпускают (он лежит в `/var/lib/caddy`). Упереться в лимит можно, только если
много раз подряд пересоздавать сервер с тем же IP или если выпуск постоянно срывается (закрыт порт 80). Исчерпан лимит: Caddy
сам пробует ZeroSSL, иначе жди сброса (до недели). При отладке не пересоздавай сервер без нужды.

**Зависимость от sslip.io.** Если sslip.io недоступен, имя не резолвится и релей не открывается. Запасной вариант: свой домен
с A-записью на IP релея; тогда замени имя хоста в Caddyfile вручную (скрипт `gemini-relay-setup.sh` больше не запускать) и
`GEMINI_BASE_URL`.

**Если релей недоступен.** Агент сообщает `VOICE_UNAVAILABLE` и отвечает шаблоном, автоматического перехода на каскад нет.
Порядок: проверка 1 и 2 из раздела «Проверка» → `hcloud server list` или консоль (сервер запущен?) → `systemctl status caddy`
и `journalctl -u caddy` на сервере. Если быстро не чинится, временно верни каскад (шаг 1 раздела «Как свернуть инфраструктуру»).

## Безопасность

- **SSH только по ключу.** Cloud-init отключает `PasswordAuthentication`. Вход root по ключу. Приватный ключ хранится только у администратора.
- **Порты 22, 80, 443 открыты (UFW).** 80 нужен Caddy для получения и продления сертификата (HTTP-01) и редиректа на HTTPS: закрывать его нельзя.
- **Токен релея** лежит: в `/etc/caddy/Caddyfile` (`0640 root:caddy`); в `/usr/local/bin/gemini-relay-setup.sh` (после создания сделай `chmod 0700`,
  см. «После создания»); в копии user-data в `/var/lib/cloud` (только root) и в metadata-сервисе сервера (`169.254.169.254`, читается
  любым локальным процессом). Поэтому на сервере не заводи других пользователей и не запускай чужие программы.
- **Ограничить 443 по IP кластера**, если исходящий адрес кластера Timeweb известен и стабилен (если он общий или меняется, оставь как есть:
  токен всё равно защищает). 80 остаётся открытым для всех.

  ```bash
  ufw delete allow 443/tcp
  ufw allow from <IP-кластера> to any port 443 proto tcp
  ```

  То же можно сделать Cloud Firewall'ом Hetzner (бесплатный, правило Inbound TCP 443 только с IP кластера). После этого проверка 1 с
  ноутбука перестанет работать: проверяй из кластера (пункт 2). Правило для SSH (22) тоже можно сузить до своего IP.
- **Ключ Gemini** отдельный и отзываемый (см. «Что видит релей»). Токен API Hetzner с правом Read & Write держи только на время работы с `hcloud` и отзови.
- **Обновления:** `unattended-upgrades` включён в образе Ubuntu; ручной `apt upgrade` раз в месяц.

## Стоимость

- Hetzner тарифицирует **почасово, но не больше месячной цены**: сервер, существующий неполный месяц, стоит меньше. Цена
  выбранного типа записана в «Текущее состояние», актуальные цены: консоль при создании или `hcloud server-type list`.
- **Публичный IPv4 платный.** Консоль показывает итоговую цену с ним; сервер только с IPv6 дешевле, но релею нужен IPv4 (хост sslip.io строится из него).
- **Выключенный сервер тоже тарифицируется** (ресурсы зарезервированы): остановить начисления можно только удалением.
- Платные дополнения не включать: Backups (+20% к цене сервера), снимки, тома, дополнительные IP.
- Трафик в тариф входит с большим запасом, см. «Ёмкость и лимиты» ниже.

**Расходы Hetzner считаются по проектам.** Релей живёт в отдельном проекте `ryadom-gemini-relay`: остальные серверы
пользователю компенсирует заказчик, а релей он оплачивает сам. Поэтому не создавай релей в другом проекте и не заводи другие серверы в проекте релея.

## Ёмкость и лимиты

Расчёт на 2026-10-12, по документации и по коду SDK; помеченное «оценка» не мерилось.

**Релей (CAX11, Caddy).** Hetzner включает 20 ТБ исходящего трафика в месяц (входящий бесплатен). Аудио идёт внутри JSON в
base64 (+33%), поэтому на секунду речи человека приходится около 47 КБ вверх, на секунду речи агента около 73 КБ вниз;
диалог-час при 40% речи человека и 40% речи агента это около 0,17 ГБ исходящих (при непрерывной речи в обе стороны около 0,43 ГБ).

| Одновременных диалогов 24/7 | Что получается |
|---|---|
| до 100 | комфортно: около 12,6 ТБ/мес (63% квоты), CPU менее 5% (оценка) |
| около 158 (63 при непрерывной речи) | предел по включённым 20 ТБ; дальше трафик платный (порядка 1 €/ТБ, не проверено) |
| 1000+ | технический предел CAX11 по порту и CPU (оценка); нужны два-три релея или тип выше |

Память не ограничивает (порядка 0,1-0,3 МБ на соединение, оценка), дескрипторы и conntrack (65 536 записей для 4 ГБ RAM)
далеко за остальными пределами. Мониторить: исходящий трафик с начала месяца против 20 ТБ (Hetzner шлёт уведомления на 75% и 100%),
CPU и steal, число ESTAB на :443 (`ss -Htn state established '( sport = :443 )'`), `nf_conntrack_count`, срок сертификата,
`/_relay_health` из кластера. Caddy из пакета Ubuntu (2.6.2): перезагрузка конфига или обновление пакета рвут идущие
WebSocket; агент переоткрывается по handle, но реплика в этот момент прервётся.

**Лимиты Gemini Live API.** Лимиты и квоты принадлежат проекту Google, а не ключу; затраты всех ключей проекта суммируются.
Официальных чисел по одновременным сессиям и TPM для Live на Tier 2 в документации нет (смотреть в AI Studio, лимиты не
гарантированы); по форуму 60 одновременных сессий на Tier 2 держались, около 8% обрывались. Сессия без сжатия живёт 15 минут,
соединение около 10 минут (потом GoAway), handle возобновления действует 2 часа, контекст `gemini-3.8-live` 128k токенов.
Tier 2: потолок 2000 $/мес на billing-аккаунт и 50 $ за скользящие 10 минут (ответ 429).

**Деньги: контекст пересчитывается и оплачивается на каждый ход.** Ставки `gemini-3.8-live`: аудио вход 0,005 $/мин, выход 0,018 $/мин,
но по документации за каждый ход оплачивается весь накопленный контекст сессии. Оценка (ход 15 с, +350 токенов на ход, цифры
сверять по `usage_metadata` и счёту): диалог 5 минут около 0,26 $, 15 минут 1,3-2 $, час 6-11 $ (при явном сжатии 12k/4k - 25k/8k)
и до ~31 $, если сжатием управляет Google (по умолчанию около 80% окна). Поэтому для боя стоит задать
`GEMINI_COMPRESSION_TRIGGER_TOKENS`/`GEMINI_COMPRESSION_TARGET_TOKENS` явно (например 25000/8000), помня о цене: чем меньше окно,
тем короче «память» модели о начале долгого разговора (полный текст диалога при этом остаётся в агенте).

**Ограничить ключ по IP релея.** Запросы к Google теперь приходят с одного статического IPv4 релея, так что в Google Cloud Console
(Credentials → ключ → Application restrictions → IP addresses) можно разрешить ключу только этот адрес (остаётся и ограничение по API
Generative Language). Утёкший ключ тогда бесполезен с чужого адреса. Подводные камни: IPv6 на релее должен оставаться выключенным
(иначе Caddy может пойти к Google по IPv6 и запрос будет отклонён); изменение применяется не мгновенно (до нескольких минут);
при пересоздании сервера IP меняется, поэтому сначала добавить новый IP в список, потом переключать; работает ли проверка IP на
рукопожатии Live по WebSocket, в документации Google не сказано: проверить диалогом через релей, затем прямым запросом с другого адреса (должен отказать).

**Потолок расходов.** Слои защиты: лимит проекта в AI Studio (Spend → Monthly spend cap, помечен как Experimental), бюджет Cloud Billing со
Spend cap enforcement для сервиса `generativelanguage.googleapis.com` и уведомления на 50/90/100%, отдельный alerts-only бюджет с прогнозом.
Жёстких денежных потолков, кроме тарифных (2000 $/мес и 50 $ за 10 минут на Tier 2), у постоплаты нет.

## Как свернуть инфраструктуру, если релей больше не нужен

1. **Верни агента на каскад и убедись в этом.** В `k8s/agent/00-config.yaml` поставь `VOICE_PIPELINE: "cascade"` (или убери
   `VOICE_PIPELINE` и `GEMINI_BASE_URL`), в `k8s/agent/02-deployment.yaml` убери записи `GEMINI_API_KEY` и `GEMINI_RELAY_TOKEN`, затем:

   ```bash
   kubectl apply -f k8s/agent/00-config.yaml -f k8s/agent/02-deployment.yaml
   kubectl -n agent delete secret agent-gemini
   kubectl -n agent rollout restart deploy/agent && kubectl -n agent rollout status deploy/agent --timeout=180s
   kubectl -n agent port-forward svc/agent 18001:8001 &
   curl -s http://127.0.0.1:18001/health/ready          # "pipeline":"cascade", "llm" и "stt" не "none"
   ```

   Локально: убери `GEMINI_BASE_URL`, `GEMINI_RELAY_TOKEN`, `GEMINI_API_KEY` из `agent/.env`, `VOICE_PIPELINE=cascade`.
   Пока в `/health/ready` не `cascade`, сервер не удаляй.
2. **Удали сервер.** Консоль: проект `ryadom-gemini-relay` → Servers → `gemini-relay` → **Delete**. Или:
   `hcloud server delete gemini-relay`.
3. **Проверь, что не осталось платных остатков** (в том же проекте): Primary IP, тома, снимки, бэкапы, плавающие IP, прочее.

   ```bash
   for r in server primary-ip floating-ip volume firewall network load-balancer; do echo "== $r"; hcloud $r list; done
   hcloud image list --type snapshot
   hcloud image list --type backup
   ```

   Всё, что осталось и платное, удали (`hcloud primary-ip delete <id>`, `hcloud volume delete <id>`, `hcloud image delete <id>`
   и т. д.) или найди в консоли, раздел Resources проекта.
4. **Удали SSH-ключ проекта и сам проект** (если проект больше ни для чего не нужен). `hcloud ssh-key delete gemini-relay-key` или консоль:
   Security → SSH keys. Проект удаляется в консоли: проект → **Settings → Delete project**, проект должен быть пустым (вместе с ним пропадают его API-токены).
   Если проект остаётся: отзови API-токен (Security → API tokens) и удали контекст `hcloud context delete ryadom-gemini-relay`.
5. **Убери локальные следы и сбрось ключи:**
   - удали каталог `gemini-relay-local` целиком (`%USERPROFILE%\gemini-relay-local` или `~/gemini-relay-local`: токен релея,
     приватный ключ SSH, `gemini.env`, `cloud-init.rendered.yaml`);
   - `ssh-keygen -R <IPv4>` (запись в `known_hosts`);
   - **отзови или смени `GEMINI_API_KEY`** (Google AI Studio): ключ проходил через релей в открытом виде. Если ключ нужен для
     прямого доступа из другой страны, смени его в любом случае, если он где-то светился (лог, чат, экран).
6. **Проверь счета.** Консоль → Billing (на уровне аккаунта) и расходы проекта: сервер больше не должен начислять. Последние часы
   попадут в ближайший счёт; в следующем месяце начислений по проекту `ryadom-gemini-relay` быть не должно. В «Текущее состояние» запиши дату удаления.
