"""Правило приватности: что считается «человек убрал что-то из своей сводки» (`CogneeMemoryBackend.removals`).

Счётчик читает сессия Gemini: когда он вырос, она к следующему ходу открывается заново без убранного
(tests/test_live_context.py). Здесь проверяется только сам счётчик: удаление и правка заметки, вся память, переключатели
и разговор растят его, а добавления, включение и переключатели «вкл» — нет.
"""

from app.memory.cognee_backend import CogneeMemoryBackend
from tests.test_memory_cognee_backend import CONSENT, FakeCognee, backend, dialog, uid


async def enabled_service(user: str) -> CogneeMemoryBackend:
    service = backend(FakeCognee())
    await service.update_settings(user, True, CONSENT)
    return service


async def test_nothing_removed_means_zero() -> None:
    user = uid()
    service = await enabled_service(user)
    assert service.removals(user) == 0 and service.removals(uid()) == 0


async def test_adding_and_switching_things_on_do_not_count() -> None:
    user = uid()
    service = await enabled_service(user)
    await service.notes.add(user, "interest", "Любит ходить пешком")
    await service.add_fact(user, "interest", "Любит чай", None)
    await service.update_settings(user, True, CONSENT, sensitive_enabled=True, chat_search_enabled=True)  # включили чувствительное
    assert service.removals(user) == 0
    service.user_message(dialog(user, 0), "расскажу про работу")  # находка поиска по реплике — тоже добавление в сводку
    await service.drain()
    assert service.removals(user) == 0


async def test_deleting_or_editing_a_note_counts() -> None:
    user = uid()
    service = await enabled_service(user)
    first = await service.notes.add(user, "interest", "Любит ходить пешком")
    second = await service.notes.add(user, "person", "Есть сестра Маша")
    await service.notes.patch(user, first["id"], "Любит ходить пешком по утрам")
    assert service.removals(user) == 1  # прежний текст заметки из сводки убран
    await service.notes.delete(user, second["id"])
    assert service.removals(user) == 2


async def test_the_old_fact_routes_count_too() -> None:
    user = uid()
    service = await enabled_service(user)
    fact = await service.add_fact(user, "interest", "Любит чай", None)
    await service.patch_fact(user, fact["id"], text="Любит зелёный чай")
    await service.delete_fact(user, fact["id"])
    assert service.removals(user) == 2


async def test_forget_all_pause_and_turning_switches_off_count() -> None:
    user = uid()
    service = await enabled_service(user)
    await service.update_settings(user, True, CONSENT, sensitive_enabled=True, chat_search_enabled=True)
    await service.notes.add(user, "interest", "Любит ходить пешком")
    await service.forget_all(user)
    assert service.removals(user) == 1
    await service.update_settings(user, None, None, sensitive_enabled=False)  # «Запоминать чувствительное» выключили
    assert service.removals(user) == 2
    await service.update_settings(user, None, None, chat_search_enabled=False)  # «Опираться на прошлые разговоры» выключили
    assert service.removals(user) == 3
    await service.update_settings(user, False, None)  # память на паузе
    assert service.removals(user) == 4


async def test_a_switch_that_was_already_off_does_not_count() -> None:
    user = uid()
    service = await enabled_service(user)
    await service.update_settings(user, None, None, sensitive_enabled=False)  # он и так был выключен
    assert service.removals(user) == 0


async def test_deleting_a_dialog_counts_and_drops_the_found_text() -> None:
    user = uid()
    service = await enabled_service(user)
    service._turn_recalls[user] = "Реплики человека в разговоре: был у врача"
    await service.dialog_deleting(user, "some-dialog")
    assert service.removals(user) == 1
    assert "у врача" not in service.brief(dialog(user, 0))


async def test_counters_are_per_person_and_forgotten_with_the_cache() -> None:
    first, second = uid(), uid()
    service = await enabled_service(first)
    await service.update_settings(second, True, CONSENT)
    await service.notes.add(first, "interest", "Любит чай")
    note = (await service.notes.list(first))[0]
    await service.notes.delete(first, note["id"])
    assert service.removals(first) == 1 and service.removals(second) == 0
    service.user_unloaded(first)  # человека выгрузили: сессий у него нет, счётчик начнётся заново
    assert service.removals(first) == 0
