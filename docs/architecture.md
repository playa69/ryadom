# Архитектура «Слышу Рядом»: карта систем

Полная карта: что где работает, в каком облаке, с кем интегрировано и что куда уходит. Диаграммы — Mermaid (GitHub
рисует их сам). Факты сняты с манифестов `k8s/`, конфигов `agent/` и `app/` и спек `openspec/specs/`; адреса, ключи и
идентификаторы сюда не выносятся. Подробности по разделам — `k8s/README.md`, `k8s/CLOUD-RESOURCES.md`, `agent/README.md`,
`agent/relay/README.md`, `docs/analytics.md`.

Окружение одно — прод; «локально» значит стенд разработчика (§6). Диаграммы проверены на рендер Mermaid.

## 1. Общая карта: кто в каком облаке

```mermaid
flowchart LR
  subgraph PEOPLE["Люди и устройства"]
    BR["Браузер<br/>лендинг, веб, админка"]
    PWA["PWA"]
    NAT["Android и iOS<br/>Capacitor"]
    TGC["Telegram Mini App"]
  end

  subgraph TWC["Timeweb Cloud, Москва: кластер Kubernetes twc-sber500"]
    GW["Istio ingress gateway"]
    APPS["ns prod<br/>landing, web, pwa, admin, api"]
    AG["ns agent<br/>agent и cognee"]
    DB[("ns ryadom-db<br/>PostgreSQL, Redis")]
    LF["ns infra<br/>Langfuse"]
    MON["ns monitoring<br/>Prometheus, Grafana, Loki"]
  end

  subgraph YC["Yandex Cloud"]
    YCR["Container Registry"]
    YS3[("Object Storage")]
    YDNS["Cloud DNS"]
  end

  subgraph GEMINI["Голос: Gemini"]
    RELAY["Релей, Hetzner"]
    GEM["Google Gemini API"]
  end

  subgraph EXT["Внешние сервисы"]
    LLM["LiteLLM-прокси программы"]
    PH["PostHog Cloud EU"]
    UNI["Unisender Go"]
    LE["Let's Encrypt"]
  end

  ST["Магазины приложений<br/>планируются"]

  BR -->|HTTPS| GW
  PWA -->|HTTPS| GW
  NAT -->|HTTPS, WSS, OTA| GW
  TGC -->|HTTPS| GW
  GW --> APPS
  APPS -->|REST, WebSocket| AG
  APPS --> DB
  AG --> DB
  AG -->|HTTPS, WSS| RELAY
  RELAY --> GEM
  AG --> LLM
  AG -.->|трейсы| LF
  LF --> DB
  LF --> YS3
  DB -->|бэкапы| YS3
  APPS -->|SMTP 465| UNI
  APPS -->|события, стирание| PH
  MON -.->|метрики, логи| APPS
  MON -.->|метрики| AG
  YCR -.->|образы| TWC
  YDNS -.->|A-запись| GW
  LE -.->|сертификаты| GW
  ST -.->|сборки| NAT
```

Куда уходят данные человека:

| Куда | Что уходит | Где это |
|---|---|---|
| Gemini через релей | голос и тексты разговора (Gemini Live — единственный голосовой путь) | за пределы РФ |
| LiteLLM-прокси программы | тексты разговора для итога и заметок, с маскированием персональных данных | внешний сервис |
| PostHog Cloud EU | события без текстов, ответов тестов и баллов | ЕС |
| Unisender Go | адрес почты и коды входа | внешний сервис |
| Langfuse (свой) | трейсы вызовов агента, только маскированный текст | наш кластер |

Агенту передаётся только `userId`: почта и имя остаются в приложении.

## 2. Кластер подробно

```mermaid
flowchart LR
  subgraph EDGE["Вход"]
    IGW["Istio ingress gateway<br/>DaemonSet, hostPort 80 и 443<br/>Gateway API: HTTPRoute по путям"]
    CM["cert-manager<br/>ClusterIssuer letsencrypt-prod"]
  end

  subgraph PROD["ns prod, Istio"]
    LAND["landing /"]
    WEB["web /app"]
    PWA["pwa /pwa"]
    ADM["admin /admin"]
    API["api /api"]
    MIG["Job migrate<br/>drizzle и схема очереди pgboss"]
  end

  subgraph AGENTNS["ns agent, ClusterIP"]
    AG["agent :8001<br/>1 реплика, Recreate"]
    COG["cognee :8000"]
  end

  subgraph DBNS["ns ryadom-db"]
    PGC[("CNPG ryadom-db<br/>базы приложения, агента, cognee, langfuse")]
    RS[("Redis, 3 ноды + Sentinel")]
  end

  subgraph INFRANS["ns infra"]
    LF["Langfuse web и worker"]
    CHS[("ClickHouse, 1 реплика")]
    RDL[("Redis Langfuse")]
  end

  subgraph MONNS["ns monitoring"]
    P["kube-prometheus-stack<br/>Alertmanager выключен, хранение 14 дней"]
    L["Loki, SingleBinary, хранение 7 дней"]
    A["Alloy: логи DaemonSet"]
  end

  IGW --> LAND & WEB & PWA & ADM & API
  CM -.->|сертификат в istio-system| IGW
  API -->|внутренний токен| AG
  ADM -->|стирание данных| AG
  ADM --> PGC
  API --> PGC
  API -.-> RS
  MIG --> PGC
  AG --> PGC
  AG --> COG
  COG --> PGC
  AG -.-> LF
  LF --> CHS
  LF --> RDL
  LF --> PGC
  P -.->|ServiceMonitor| API
  P -.->|ServiceMonitor| AG
  P -.->|exporter :9187| PGC
  A --> L
```

Сетевые правила (Calico, NetworkPolicy): агент принимает только `api` и `admin` из `prod`, на :8001; `agent` и `cognee`
ходят к прокси программы на :4000; из `prod` открыт исходящий SMTP на :465; `monitoring` по умолчанию закрыт на вход.

| Что | Как устроено |
|---|---|
| Маршрутизация | корень домена `слышу-рядом.рф`, поддоменов нет: `/` лендинг, `/app` веб, `/pwa` PWA, `/admin` админка, `/api` шлюз |
| Хранилище подов | диски NVMe Timeweb (CSI), удаление PVC удаляет диск: единственная копия PostgreSQL — бэкапы в Yandex S3 |
| Реплики | каждый сервис по одной (`api`, агент и Cognee — одна, сокеты привязаны к поду); фоновая работа `api` на очереди pg-boss может идти на нескольких |
| Образы | только из Yandex Container Registry (зеркало всех образов кластера, внешних реестров нет) |
| Секреты | Secrets кластера, значения хранит администратор, в git только шаблоны |

## 3. Путь разговора

```mermaid
sequenceDiagram
  autonumber
  participant C as Клиент (веб, PWA, приложение)
  participant G as Istio gateway
  participant A as api (шлюз)
  participant AG as agent
  participant R as Релей (Hetzner)
  participant GM as Gemini Live
  participant PG as PostgreSQL
  participant CG as Cognee
  participant L as LiteLLM-прокси
  participant PH as PostHog

  C->>G: POST /api/dialogs, согласия, токен
  G->>A: запрос
  A->>A: аккаунт, лимиты, политика, блокировка
  A->>AG: POST /v1/users/{id}/dialogs (Bearer)
  AG->>PG: заметки, настройки памяти, прошлые разговоры
  AG-->>A: диалог создан, приветствие
  A-->>C: dialogId
  C->>G: WebSocket /api/dialogs/ws
  G->>A: апгрейд
  A->>AG: WebSocket к агенту
  loop реплика
    C->>A: звук 16 кГц или текст
    A->>AG: кадры
    AG->>AG: поиск кризисных слов по тексту
    AG->>R: реплика и история, WSS
    R->>GM: то же, без X-Relay-Token
    GM-->>AG: звук 24 кГц и расшифровка
    AG-->>A: кадры ответа, mood, safety
    A-->>C: ответ голосом и текстом
    A->>PH: событие без текста
  end
  C->>A: завершить разговор
  A->>AG: end
  AG->>L: итог разговора, заметки (фоновая модель)
  AG->>PG: итог, заметки, сводка
  AG->>CG: реплики человека в поиск по прошлым разговорам
  CG->>L: модель и эмбеддинги
```

Кризис проверяется кодом по тексту до показа ответа, без модели; при срабатывании идёт фиксированный ответ и кадр
`safety`, клиент открывает лист с линиями помощи.

## 4. Данные: что где лежит

| Хранилище | Что в нём | Срок |
|---|---|---|
| PostgreSQL: база приложения | аккаунты, согласия и их журналы, сессии, дневник настроения, итоги недели, результаты самопроверок, ссылки на разговоры, очередь pgboss | пока жив аккаунт; гость без визитов 90 дней стирается |
| PostgreSQL: база агента | разговоры и сообщения, итоги, заметки памяти, настройки, очередь для Cognee, расход моделей | разговоры 90 дней после последнего сообщения |
| PostgreSQL: база Cognee | граф и векторы поиска по прошлым разговорам | по сроку разговора |
| Redis (ryadom-db) | счётчики лимитов запросов (необязателен) | короткие окна |
| Langfuse: ClickHouse, Redis | трейсы агента, только маскированный текст | политика Langfuse |
| Yandex Object Storage | бэкапы PostgreSQL (WAL и base, 30 дней), файлы Langfuse | 30 дней для бэкапов |
| Prometheus, Loki | метрики 14 дней, логи 7 дней, без текстов реплик | 14 и 7 дней |
| PostHog Cloud EU | события без текстов; профиль стирается при удалении аккаунта | политика PostHog |
| Память процесса агента | открытый «не сохраняемый» разговор | до завершения или перезапуска |

## 5. Фоновая работа

| Где | Что | Как |
|---|---|---|
| `api` | чистка просроченных сессий, чистка гостевых аккаунтов, минутный проход итогов недели, сторож очередей | расписания pg-boss, один запуск на все реплики |
| `api` | стирание профиля в PostHog при удалении аккаунта, сброс итога недели после удаления разговора | задачи pg-boss, ставятся в транзакции удаления |
| `admin` | стирание профиля в PostHog при удалении администратором | производящий экземпляр pg-boss, воркеры в `api` |
| `agent` | срок хранения разговоров, физическая очистка помеченного (раз в 10 минут, выдержка час), выгрузка неактивных, очередь Cognee | циклы в процессе агента |

## 6. Сборка, доставка и разработка

```mermaid
flowchart LR
  DEV["Разработчик<br/>worktree, свой стенд"]
  GH["GitHub<br/>репозиторий и PR, без CI"]
  MUL["Multica<br/>задачи"]
  subgraph LOCAL["Локально: стенд на worktree (WSL, Docker)"]
    LP["PostgreSQL, Redis"]
    LM["Mailpit"]
    LA["agent-mock"]
    LE2["e2e: прод-сборки, Playwright"]
  end
  BLD["Сборка образов<br/>api, web, pwa, landing, admin, agent, migrate"]
  YCR["Yandex Container Registry"]
  K8S["Кластер Timeweb<br/>kubectl apply, человек"]
  POST["Проверки после выката<br/>k8s/postdeploy, pytest"]
  LT["Нагрузка<br/>Locust, loadtest"]

  DEV --> LOCAL
  DEV --> GH
  GH --- MUL
  DEV --> BLD --> YCR --> K8S --> POST
  LT -.-> K8S
```

- **Окружения.** Прод один; dev и stage не заведены. Локальный стенд на worktree (порты от слота) повторяет приложение
  с заглушкой агента и Mailpit вместо почты; e2e собирает прод-сборки приложений.
- **Выкат.** Образы собирает человек, кладёт в Yandex Container Registry, применяет манифесты и следит за выкатом; миграции
  идут отдельным Job (`migrate`) до `api`. Порядок и откат — скилл `deploy` и `k8s/README.md`.
- **Мобильные сборки.** Android и iOS на Capacitor собираются отдельно; JS-часть обновляется по воздуху (OTA), её раздаёт
  `api`; жёсткое и мягкое обновление управляется политикой релизов. В магазинах приложение пока не опубликовано.

## 7. Внешние сервисы: сводка

| Сервис | Роль | Протокол и точка | Если недоступен |
|---|---|---|---|
| Google Gemini (через релей Hetzner) | голос речь в речь, цвет шарика | HTTPS и WSS, `X-Relay-Token` | голоса нет, запасного пути нет: `VOICE_UNAVAILABLE`, текст идёт той же моделью |
| LiteLLM-прокси программы | фоновая модель (итоги, заметки), модели Cognee | HTTPS, порт 4000, ключ | разговор идёт, итоги и заметки откладываются |
| PostHog Cloud EU | аналитика | через прокси `/api/ingest`, серверный API для стирания | события теряются, стирание повторяется очередью |
| Unisender Go | письма: коды входа, подтверждение почты | SMTP, порт 465 | вход по коду из письма не работает |
| Let's Encrypt | сертификаты | HTTP-01 через cert-manager | при истечении сертификата сайт недоступен |
| Yandex Cloud | реестр образов, бэкапы, DNS | HTTPS | новые образы не подтянуть, DNS, бэкапы: см. `CLOUD-RESOURCES.md` |
| Telegram | клиент, в котором открывается Mini App; запуск подписан токеном бота | подпись `initData` проверяет `api` у себя, к Telegram не ходит | Mini App не открывается |
| Магазины приложений | дистрибуция Android и iOS | не подключены | веб и PWA работают |
