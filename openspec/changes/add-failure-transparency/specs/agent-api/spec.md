## ADDED Requirements

### Requirement: Прозрачность отказов компонентов
Агент SHALL при отказе компонента голосового пути (GigaASR, GigaChat, SaluteSpeech, Gemini Live, озвучка Gemini) писать в журнал одну строку с полями `component`, `reason`, `pipeline` и, когда они известны, `dialog_id`, `turn`, `user_id`, увеличивать `agent_component_errors_total{component,pipeline,reason}` и называть строку по фактическому пути. Переход на запасной путь SHALL увеличивать `agent_pipeline_fallbacks_total{from,to,scope,reason}`. `reason` SHALL быть одним кодом из списка `quota`, `auth`, `timeout`, `connect`, `closed`, `empty`, `bad_response`, `unavailable`, `unknown`. Кадр `component` от агента SHALL нести `pipeline` (`sber` | `gemini`) и, при `outcome=error`, `reason`; шлюз SHALL переносить их в свойства события `component_called`, принимая только значения из этих списков, а остальное заменяя на `unknown` (для `reason`) или отбрасывая (для `pipeline`). Тексты реплик, промпты, секреты и тексты ошибок вендоров MUST NOT попадать в эти поля, метрики и свойства. Закрытие соединения между репликами SHALL NOT считаться отказом.

Поверхности: api · agent

#### Scenario: Отказ на пути Сбера
- **WHEN** на пути Сбера соединение GigaASR закрылось посреди хода
- **THEN** в журнале агента строка «voice link closed» с `component=gigaasr`, `reason=closed`, `pipeline=sber` и `dialog_id`, а `agent_component_errors_total` для этих значений выросла на 1

#### Scenario: Событие аналитики с путём и причиной
- **WHEN** агент прислал кадр `component` с `outcome=error`, `pipeline=sber`, `reason=timeout`
- **THEN** шлюз записал `component_called` со свойствами `pipeline=sber` и `reason=timeout`

#### Scenario: Посторонние значения
- **WHEN** в кадре `component` вместо кода причины пришёл произвольный текст
- **THEN** в событии `reason=unknown`, а текст в событие не попал

#### Scenario: Переход на запасной путь
- **WHEN** основной путь не открылся, и разговор пошёл на запасной
- **THEN** `agent_pipeline_fallbacks_total` для пары путей, `scope=connect` и кода причины выросла на 1

#### Scenario: Закрытие между репликами
- **WHEN** соединение закрылось между репликами (GoAway)
- **THEN** строка в журнале информационная, `agent_component_errors_total` не меняется
