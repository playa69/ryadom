# Агент в Kubernetes (ns `agent`)

Манифесты упрощённого агента из `agent/` (шаблонные ответы + озвучка Qwen TTS, диалоги в памяти). **Ничего из этого
ещё не применялось в кластере**: файлы подготовлены к выкату, который делает администратор вручную.

| Файл | Что делает |
|---|---|
| `00-config.yaml` | ConfigMap `agent-config`: озвучка, голос по умолчанию, адрес прокси Qwen TTS |
| `01-service.yaml` | Service `agent:8001` (адрес `http://agent.agent.svc.cluster.local:8001` уже стоит в `app-config` как `AGENT_API_URL`) |
| `02-deployment.yaml` | Deployment: 1 реплика, `Recreate`, non-root, read-only rootfs, пробы `/health`, `/health/ready` |
| `../namespaces/manifests/08-network-policy-agent-service.yaml` | ingress `prod → agent:8001`, egress `prod → agent`, egress агента к прокси на `:4000` |

Наружу агент не публикуется (HTTPRoute нет): к нему ходят только `app-api` и `app-admin` по внутреннему токену.

## Секреты

Значения хранятся локально у администратора, в git их нет. Создаются командой `create` (не `apply`, чтобы не
перезаписать существующие), значения не печатать:

| Secret | Namespace | Ключи |
|---|---|---|
| `agent-secrets` | `agent` | `AGENT_INTERNAL_TOKEN`, `AGENT_API_TOKEN` (ключ прокси), необязательно `SALUTE_SPEECH_AUTH_KEY` |
| `app-secrets` | `prod` | уже есть; ключ `AGENT_INTERNAL_TOKEN` с тем же значением, что у агента |

Два разных секрета, не путать:

- `AGENT_INTERNAL_TOKEN` — общий токен между сервисами, **один и тот же** в `agent-secrets` и `app-secrets` (новый случайный,
  например `openssl rand -hex 32`): им `app-api` и `app-admin` представляются агенту. Внутри самого приложения эта
  переменная исторически называется `AGENT_API_TOKEN`, поэтому в Deployment `app-api` и `app-admin` ключ
  `AGENT_INTERNAL_TOKEN` из `app-secrets` подставляется в переменную `AGENT_API_TOKEN`.
- `AGENT_API_TOKEN` у агента — ключ прокси программы для Qwen TTS. Принадлежит только агенту, в `app-secrets` его нет.

Режим озвучки (`TTS_MODE: qwen`) — не секрет, он в ConfigMap `agent-config`. Ключ SaluteSpeech появится позже: добавить
`SALUTE_SPEECH_AUTH_KEY` в `agent-secrets`, сменить `TTS_MODE` на `salutespeech` в `00-config.yaml` и перезапустить агента.
Сертификаты Сбера подписаны российским корневым УЦ: если системного хранилища образа не хватит, положить пакет в
ConfigMap, смонтировать и задать `SALUTE_SPEECH_CA_BUNDLE` (живой проверки SaluteSpeech не было, ключа нет).

**Если `app-secrets` создан по старой схеме** (ключ `AGENT_API_TOKEN` с общим токеном или, хуже, с ключом прокси): добавить ключ
`AGENT_INTERNAL_TOKEN` с общим токеном (`kubectl -n prod patch secret app-secrets -p '{"stringData":{"AGENT_INTERNAL_TOKEN":"<токен>"}}'`),
применить Deployment'ы `k8s/app/api/03-deployment.yaml` и `k8s/app/admin/03-deployment.yaml` (они читают новый ключ) и
дождаться раскатки. Лишний ключ `AGENT_API_TOKEN` из `app-secrets` потом можно убрать.

## Первый выкат (порядок важен)

Нужны Docker, `kubectl`, **админский** kubeconfig (NetworkPolicy вне роли `developer`) и `registry-pusher-key.json`.
Применять поимённо, не `-f k8s/` целиком.

```bash
export KUBECONFIG=~/.kube/ryadom-admin.yaml
kubectl get nodes && kubectl -n agent get pods              # read-only проверка доступа
kubectl -n agent get secret registry-pull                   # есть: он нужен для pull образа

# 1. Образ: платформа linux/amd64, контекст — каталог agent/ (префикс cr.yandex/.../agent/ — как у app/)
REG=cr.yandex/crpsqeamqpuvrkm5tpr9/agent
TAG=0.1.2                                                   # тот же тег в 02-deployment.yaml
cd agent
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -t $REG/agent:$TAG .
cat ../registry-pusher-key.json | docker login --username json_key --password-stdin cr.yandex
docker push $REG/agent:$TAG
cd ..

# 2. Секрет агента (значения у администратора) и внутренний токен в app-secrets (см. выше)
kubectl -n agent create secret generic agent-secrets --from-env-file=<файл: AGENT_INTERNAL_TOKEN, AGENT_API_TOKEN (ключ прокси)>

# 3. Сеть: без неё api не достучится до агента, а агент — до прокси
kubectl apply -f k8s/namespaces/manifests/08-network-policy-agent-service.yaml

# 4. Агент
kubectl apply -f k8s/agent/00-config.yaml -f k8s/agent/01-service.yaml -f k8s/agent/02-deployment.yaml
kubectl -n agent rollout status deploy/agent --timeout=180s
```

## Проверка

```bash
# Изнутри кластера, тем же путём, каким ходит api (проверяет NetworkPolicy и DNS):
kubectl -n prod exec deploy/app-api -- wget -qO- http://agent.agent.svc.cluster.local:8001/health      # {"status":"ok"}

# Сам агент: провайдер озвучки должен быть qwen
kubectl -n agent port-forward svc/agent 18001:8001 &
curl -s http://127.0.0.1:18001/health/ready                                                           # {"status":"ok","tts":"qwen"}

# Весь контракт по REST + WebSocket, с голосом (нужен внутренний токен; wav сохраняется для прослушивания)
AGENT_INTERNAL_TOKEN=<токен> python agent/scripts/smoke.py --url http://127.0.0.1:18001 --voice female --wav reply.wav

# Логи: прогрев озвучки на старте (32 запроса к прокси, около минуты) и старты диалогов с голосом
kubectl -n agent logs deploy/agent | grep -E "прогрев|dialog started|tts failed|WARNING"        # «закончен: озвучено 32, не удалось 0»
```

Затем на сайте: `https://слышу-рядом.рф/app/` → начать разговор → ответ должен прийти и **прозвучать** (индикатор шара),
в логах агента — `dialog started … voice=male`. После мёржа PR агента с выбором голоса: Профиль → «Голос агента» →
«Женский» → новый разговор → в логах `voice=female`.

## Выбор голоса на сайте: нужны новые образы app

Сам агент работает и без этого (поле `voice` необязательно, по умолчанию мужской голос), но переключатель в профиле и
передача голоса агенту — это код `app/` из того же PR. Чтобы он заработал на сайте, после мёржа нужно собрать и выкатить
новые образы `api`, `web` и `migrate` (миграция `0005_agent_voice` добавляет колонку `users.agent_voice`, по умолчанию
`male`), поправить теги в `k8s/app/*/03-deployment.yaml` и `k8s/app/db/02-job-migrate.yaml` и применить как обычно:
сначала Job миграции `app-migrate-0002`, затем Deployment'ы (см. `k8s/README.md`, «Новая версия»).

## Ограничения (честно)

- **Память, не база.** Диалоги агента живут в процессе: при перезапуске пода и при каждом выкате они пропадают. Реплика
  одна, `strategy: Recreate`, поэтому на время выката агент недоступен (около минуты вместе с прогревом озвучки).
- **Прогрев.** Первую минуту после старта часть фраз может прочитать приложение своим голосом: Qwen через прокси отдаёт
  первый звук за 1-2 с, а клиент ждёт не больше 0,9 с. Ответ при этом не теряется.
- **Прокси программы — внешняя зависимость.** Если он недоступен, агент отвечает текстом (`error VOICE_UNAVAILABLE`), а
  приложение читает ответы само. Адрес прокси лежит в `agent-config`, egress на `:4000` — в `08-…yaml`.
- **Не проверено вне кластера:** сами манифесты (`kubectl apply` не запускался), NetworkPolicy и сайдкары Istio на пути
  `app-api → agent`, обращение к прокси из кластера, SaluteSpeech, нагрузка. Образ и поведение агента проверены локально
  (Docker, read-only rootfs, не root, без capabilities).

## Откат

`kubectl delete -f k8s/agent/02-deployment.yaml` возвращает состояние «агента в кластере нет»: `app-api` стартует и
работает (его `/api/health` проверяет только БД), диалоги не открываются. Сетевую политику можно оставить.
