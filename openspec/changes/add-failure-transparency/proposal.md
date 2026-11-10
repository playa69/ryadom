## Why

Разбор PROTEUS-280 показал: по журналам и аналитике нельзя быстро понять, какой компонент ломается и почему. Событие `component_called` с `component=live` не говорит, какой путь (Сбер или Gemini) и что упало; соединитель Сбера пишет `gemini live closed`; в журнале агента нет `userId`; у ошибки нет единого поля «компонент / причина»; метрики агента не доходят до Prometheus (`istio-proxy` агента `up=0`).

## What Changes

- Строка отказа голосового пути в журнале агента несёт `component`, `reason`, `pipeline`, `dialog_id`, `turn`, `user_id`; название строки соответствует фактическому пути (больше нет `gemini live closed` для Сбера). Тексты реплик, промпты и ответы вендоров в строку не попадают.
- Кадр `component` от агента и событие `component_called` получают `pipeline` (`sber` | `gemini`) и `reason` (закрытый список кодов) — без текстов.
- Метрики `agent_component_errors_total{component,pipeline,reason}` и `agent_pipeline_fallbacks_total{from,to,scope,reason}`.
- Журнал api: `pipeline` в строках диалога рядом с `userId` и `dialogId`.
- Манифест: NetworkPolicy `prometheus-allow-egress-scrape` разрешает `:15090` в namespace `agent` (было только prod и istio-system).
- Скилл `logs` и `docs/analytics.md` описывают новые поля и запросы.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `agent-api`: новое требование «Прозрачность отказов компонентов».

## Impact

| Поверхность | Затрагивается | Изменение |
|---|---|---|
| agent | да | Журнал, метрики, кадр `component` |
| api | да | Свойства события `component_called`, поля журнала |
| web | нет | — |
| pwa | нет | — |
| android | нет | — |
| ios | нет | — |
| tg | нет | — |
| admin | нет | — |
| landing | нет | — |

- Совместимость: поля кадра и события добавляются, старые клиенты и шлюзы их игнорируют; события до изменения `pipeline` и `reason` не имеют.
- Вне рамок: выкат на прод и применение манифестов — только после одобрения человека в задаче PROTEUS-282; причина пустых `agent_*` на `:8001` не подтверждена чтением прода.
