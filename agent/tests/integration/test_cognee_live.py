"""Настоящий Cognee (PROTEUS-242, задачи 0.3, 3.1, 3.5): документ на разговор, поиск, жёсткое удаление одного документа и датасета.

Запуск: `COGNEE_URL=http://127.0.0.1:4801 COGNEE_EMAIL=... COGNEE_PASSWORD=... uv run pytest tests/integration/test_cognee_live.py`.
Без COGNEE_URL тесты пропускаются. Все тексты выдуманы; Cognee нужен с настроенными LLM и эмбеддингами (тратят токены прокси)."""

import os
import uuid

import pytest

from app.clients.cognee import CogneeClient

URL = os.environ.get("COGNEE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="COGNEE_URL не задан (настоящий Cognee)")


@pytest.fixture()
async def client():
    cognee = CogneeClient(URL or "", os.environ.get("COGNEE_EMAIL", "spike@example.com"), os.environ.get("COGNEE_PASSWORD", "spike-password-123"))
    await cognee.connect()
    yield cognee
    await cognee.aclose()


async def test_document_per_dialog_search_and_hard_delete(client: CogneeClient) -> None:
    dataset = "it_" + uuid.uuid4().hex[:8]
    unique = "Лиловый-Барсук-" + uuid.uuid4().hex[:8]
    first = await client.add_document(f"Реплики человека в разговоре от 2026-10-20:\n- Поссорился с сестрой Машей из-за {unique}\n- Работаю в продажах", dataset, "dialog-one")
    second = await client.add_document("Реплики человека в разговоре от 2026-10-21:\n- Люблю гулять у воды по вечерам", dataset, "dialog-two")
    assert first and second and first != second

    assert unique in await client.recall_chunks(unique, dataset)  # поиск по прошлому разговору находит его

    assert await client.delete_document(dataset, first, "dialog-one") is True
    assert unique not in await client.recall_chunks(unique, dataset)  # после удаления слова из него не находятся
    assert "гулять" in await client.recall_chunks("гулять у воды", dataset)  # другой документ цел
    await client.delete_document(dataset, first, "dialog-one")  # повтор безопасен: Cognee отвечает 200 и на отсутствующий документ

    # документ находится и по имени, если id потерян
    assert await client.delete_document(dataset, None, "dialog-two") is True
    assert await client.forget_dataset(dataset) is True
    assert await client.dataset_exists(dataset) is False
