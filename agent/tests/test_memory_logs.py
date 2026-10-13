"""Тексты фактов и реплик не попадают в журналы, метрики и тексты ошибок (I4, MEM-15): полный сценарий с перехватом журнала."""

import logging
import time
from pathlib import Path

import pytest

from tests.conftest import AUTH, FakeChat, has, read_frames, send_user_message, ws_url
from tests.memory_support import CONSENT, FakeModel, answer, make_client, op, user

MARKER = "зеленоглазк"  # кличка собаки: уникальное слово, которого нет ни в коде, ни в шаблонах


def test_no_text_leaks_into_logs_metrics_or_errors(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    u = user()
    texts = [
        "Привет, был длинный день",
        "Меня спасают прогулки с собакой Зеленоглазкой",
        "Зеленоглазка очень смешная",
        "Пойду спать",
    ]
    model = FakeModel(
        answer(op(text="Помогают прогулки с собакой Зеленоглазкой", evidence=[2]), op(text="Зеленоглазка", evidence=[4]))
    )
    with make_client(tmp_path / "log.sqlite3", model, chat=FakeChat(reply="Понимаю, Зеленоглазка звучит чудесно.")) as client:
        client.put(f"/v1/users/{u}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        dialog = client.post(f"/v1/users/{u}/dialogs", headers=AUTH).json()
        with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
            for index, text in enumerate(texts):
                send_user_message(ws, f"c-{index}", text)
                read_frames(ws, lambda f: has(f, "assistant_end"))
        client.post(f"/v1/users/{u}/dialogs/{dialog['dialogId']}/end", headers=AUTH)
        deadline = time.monotonic() + 10
        while client.get(f"/v1/users/{u}/memory/changes?dialogId={dialog['dialogId']}", headers=AUTH).json()["status"] != "ready":
            assert time.monotonic() < deadline
            time.sleep(0.05)
        facts = client.get(f"/v1/users/{u}/memory", headers=AUTH).json()["facts"]
        assert MARKER in facts[0]["text"].casefold()  # факт запомнен...
        rejected = client.post(
            f"/v1/users/{u}/memory/facts", json={"category": "situation", "text": "У Зеленоглазки депрессия"}, headers=AUTH
        )
        assert rejected.status_code == 422 and MARKER not in rejected.text.casefold()  # ...а ошибка не повторяет текст
        fact_id = facts[0]["id"]
        client.patch(
            f"/v1/users/{u}/memory/facts/{fact_id}", json={"text": "Помогают прогулки с Зеленоглазкой у реки"}, headers=AUTH
        )
        client.get(f"/v1/users/{u}/memory/export", headers=AUTH)
        client.delete(f"/v1/users/{u}/memory/facts/{fact_id}", headers=AUTH)
        client.delete(f"/v1/users/{u}/memory", headers=AUTH)
        metrics = client.get("/metrics").text
        ready = client.get("/health/ready").text
        client.delete(f"/v1/users/{u}", headers=AUTH)
    assert "agent_memory_facts_total" in metrics and "agent_memory_extraction_total" in metrics
    assert "memory extracted dialog=" in caplog.text  # журнал действительно перехвачен
    for where, text in (("журнал", caplog.text), ("метрики", metrics), ("health", ready)):
        assert MARKER not in text.casefold(), where
        assert "прогулки" not in text.casefold(), where
