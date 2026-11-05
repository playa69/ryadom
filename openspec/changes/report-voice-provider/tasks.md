## 1. Данные и контракты

- [x] 1.1 Добавить `provider` и `model` в `LiveLink` и реализации Gemini/Сбера в `agent/app/clients/gemini_live.py` и `agent/app/clients/sber_voice.py`; обновить `agent/tests/fake_live.py`. Приёмка: каждая успешно открытая ссылка называет фактического провайдера и модель, fallback возвращает её без преобразований.
- [x] 1.2 Расширить `Observation.update` полями model/tags в `agent/app/core/tracing.py`. Приёмка: обновление маппится на generation/trace, ошибки SDK не выходят в диалог, NullObservation остаётся пустышкой.

## 2. Агент

- [x] 2.1 Исправить `voice_session_open` и `live_turn_*` в `agent/app/api/dialog_session.py`: нейтральное имя открытия, provider/model фактической ссылки, tags `voice` и `sber`/`gemini`, обновление после fallback и отсутствие модели при полном отказе. Приёмка: выполняются все сценарии «Наблюдаемость фактического голосового пути», prompt links/usage/маскирование не меняются.
- [x] 2.2 Обновить `agent/README.md`: назначение `voice_session_open`, provider, фактическая модель и tags. Приёмка: документация не предписывает искать Сбер по `gemini_session_open` или `gemini_live` и не предлагает ConfigMap для атрибуции.

## 5. Проверка

- [x] 5.1 Обновить `agent/tests/conftest.py`, `test_tracing.py`, `test_voice_pipeline.py`, `test_live_feedback.py` и `test_reclaim.py`: ссылки на change и требование, сценарии Сбера, Gemini, fallback в обе стороны, ошибки открытия, сохранения prompt links и приватности. Приёмка: профильные тесты покрывают каждый WHEN/THEN без сети и моделей; UI e2e и скриншоты не требуются, визуальных изменений нет.
- [x] 5.2 Прогнать полный `uv run pytest` в `agent/`, ruff для изменённых файлов, OpenSpec strict и `git diff --check`. Приёмка: проверки зелёные; проверки реального Langfuse относятся к задаче 6.1 и выполняются после отдельно согласованного выката.

## 6. Выкат

- [ ] 6.1 Отдельно согласовать тег и выкат агента, проверить `k8s/postdeploy` и generation Сбера/Gemini в Langfuse. Приёмка: provider/model/tags видны фактически, GigaChat не получает цену Gemini, rollout и postdeploy зелёные.

## 7. Архив

- [ ] 7.1 После мержа и выката закрыть задачи и архивировать change через OpenSpec CLI. Приёмка: требование попало в `openspec/specs/dialog-voice`, `validate --specs --strict` зелёный.
