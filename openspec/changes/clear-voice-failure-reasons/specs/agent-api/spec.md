## ADDED Requirements

### Requirement: Причина сбоя голоса в журнале и метриках
При закрытии голосового соединения агент SHALL записать в журнал и в счётчик `agent_voice_link_failures_total` путь, компонент и код причины из закрытого списка, а при оборванном ходе передать код шлюзу полем `reason`. Тексты реплик, ошибки провайдера и секреты MUST NOT попадать в метки и в `reason`.

Поверхности: agent · api

#### Scenario: Соединение Сбера оборвалось
- **WHEN** озвучка SaluteSpeech закрыла соединение без кадра закрытия
- **THEN** в журнале строка `voice link closed … pipeline=sber component=tts code=connection_closed`, счётчик с этими метками вырос на 1, а ход `live` закончился ошибкой с `reason=connection_closed`

#### Scenario: Неизвестная причина
- **WHEN** текст причины не распознан
- **THEN** путь и компонент `unknown`, код `other`

#### Scenario: Шлюз не пропускает чужие значения
- **WHEN** кадр `component` пришёл с `reason`, которого нет в списке, или с `outcome: ok`
- **THEN** в `component_called` поля `reason` нет
