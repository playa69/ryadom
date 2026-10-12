"""REST памяти агента (MEM-10): коды ответов, I1 (чтение, экспорт и стирание работают всегда), эпоха, бета-список,
отказ фильтров, «что изменилось» после разговора, «Без памяти» в диалогах, /health/ready."""

import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import AUTH
from tests.memory_support import CONSENT, FakeModel, answer, make_client, op, user

DIAGNOSIS = "У меня депрессия"


def url(u: str, path: str = "") -> str:
    return f"/v1/users/{u}/memory{path}"


def turn_on(client: TestClient, u: str) -> dict[str, Any]:
    response = client.put(url(u, "/settings"), json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
    assert response.status_code == 200, response.text
    return response.json()


def add(client: TestClient, u: str, category: str = "works", text: str | None = "Помогают вечерние прогулки", **extra: Any):
    return client.post(url(u, "/facts"), json={"category": category, "text": text, **extra}, headers=AUTH)


def error(response: Any) -> tuple[int, str, Any]:
    body = response.json()["error"]
    return response.status_code, body["code"], body["details"]


def test_reading_and_forgetting_work_without_disk_and_when_off() -> None:
    """I1: прочитать, скачать и стереть можно всегда."""
    u = user()
    with make_client(None, MEMORY_MODE="off") as client:
        body = client.get(url(u), headers=AUTH).json()
        assert (body["available"], body["mode"], body["enabled"], body["facts"]) == (False, "off", False, [])
        assert body["limits"] == {"maxFacts": 60} and body["rulesVersion"]
        assert client.get(url(u, "/export"), headers=AUTH).status_code == 200
        assert client.delete(url(u), headers=AUTH).status_code == 204
        assert client.delete(url(u, "/facts/nope"), headers=AUTH).status_code == 204
        assert error(client.put(url(u, "/settings"), json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH))[:2] == (
            503,
            "MEMORY_UNAVAILABLE",
        )


def test_memory_routes_need_the_internal_token(tmp_path: Path) -> None:
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        assert client.get(url(user())).status_code == 401
        assert client.get("/v1/users/not-a-uuid/memory", headers=AUTH).status_code == 400


def test_enabling_needs_a_consent_version_and_a_working_feature(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        assert error(client.put(url(u, "/settings"), json={"enabled": True}, headers=AUTH))[:2] == (422, "AGENT_VALIDATION")
        first = turn_on(client, u)
        assert first["enabled"] and first["consentVersion"] == CONSENT and first["consentAt"]
        assert turn_on(client, u) == first  # идемпотентно: согласие той же версии не переписывается
        export = client.get(url(u, "/export"), headers=AUTH).json()["settings"]
        epoch = export["epochAt"]
        time.sleep(0.01)
        off = client.put(url(u, "/settings"), json={"enabled": False}, headers=AUTH).json()
        assert off["enabled"] is False and off["consentVersion"] == CONSENT  # выключение ничего не удаляет
        assert client.get(url(u, "/export"), headers=AUTH).json()["settings"]["epochAt"] > epoch  # эпоха сдвинута
    with make_client(tmp_path / "a.sqlite3", FakeModel(), MEMORY_MODE="off") as client:
        assert client.put(url(u, "/settings"), json={"enabled": False}, headers=AUTH).status_code == 200


def test_beta_allowlist(tmp_path: Path) -> None:
    inside, outside = user(), user()
    with make_client(tmp_path / "a.sqlite3", FakeModel(), MEMORY_ALLOWLIST=f" {inside.upper()} ,") as client:
        turn_on(client, inside)
        response = client.put(url(outside, "/settings"), json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        assert error(response)[:2] == (403, "MEMORY_NOT_ALLOWED")


def test_facts_need_memory_on(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        assert error(add(client, u))[:2] == (409, "MEMORY_DISABLED")


def test_person_writes_a_fact_and_rules_still_apply(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        turn_on(client, u)
        created = add(client, u)
        assert created.status_code == 201
        fact = created.json()
        assert (fact["status"], fact["origin"], fact["importance"], fact["sensitivity"]) == ("pinned", "user_edit", 5, "normal")
        status, code, details = error(add(client, u, "situation", DIAGNOSIS))
        assert (status, code, details) == (422, "FACT_REJECTED", {"reason": "diagnosis"})
        assert (
            DIAGNOSIS not in client.post(url(u, "/facts"), json={"category": "situation", "text": DIAGNOSIS}, headers=AUTH).text
        )
        person = add(client, u, "person", None, slots={"role": "Сестра", "name": "Аня", "note": "поддерживает"}).json()
        assert person["text"] == "Сестра Аня: поддерживает" and person["slots"]["role"] == "сестра"
        style = add(client, u, "style", None, slots={"address": "Марина", "form": "ty"}).json()
        assert style["text"] == "Зовут Марина; на «ты»"
        assert error(add(client, u, "style", "называй меня Мариной"))[:2] == (422, "AGENT_VALIDATION")
        assert error(add(client, u, "person", None, slots={"role": "космонавт"}))[2] == {"reason": "bad_slots"}
        assert error(add(client, u, "trait", "Тревожный по натуре"))[:2] == (422, "AGENT_VALIDATION")
        facts = client.get(url(u), headers=AUTH).json()["facts"]
        assert [f["category"] for f in facts] == ["style", "person", "works"]  # порядок категорий


def test_memory_full(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        turn_on(client, u)
        for index in range(60):
            assert add(client, u, "interest", f"Интерес номер {index} из списка").status_code == 201
        assert error(add(client, u, "interest", "Шестьдесят первый интерес"))[:2] == (409, "MEMORY_FULL")


def test_patch(tmp_path: Path) -> None:
    u, stranger = user(), user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        turn_on(client, u)
        turn_on(client, stranger)
        fact = add(client, u).json()
        path = url(u, f"/facts/{fact['id']}")
        assert error(client.patch(url(u, "/facts/nope"), json={"confirm": True}, headers=AUTH))[:2] == (404, "FACT_NOT_FOUND")
        foreign = client.patch(url(stranger, f"/facts/{fact['id']}"), json={"confirm": True}, headers=AUTH)
        assert error(foreign)[:2] == (404, "FACT_NOT_FOUND")  # чужой факт неотличим от несуществующего (I5)
        assert error(client.patch(path, json={}, headers=AUTH))[:2] == (422, "AGENT_VALIDATION")
        unpinned = client.patch(path, json={"status": "active"}, headers=AUTH).json()
        assert unpinned["status"] == "active" and unpinned["seenByUser"]
        edited = client.patch(path, json={"text": "Помогают долгие прогулки у реки"}, headers=AUTH).json()
        assert (edited["text"], edited["status"], edited["origin"]) == ("Помогают долгие прогулки у реки", "pinned", "user_edit")
        confirmed = client.patch(path, json={"confirm": True}, headers=AUTH).json()
        assert confirmed["confirmCount"] == 1 and confirmed["lastConfirmedAt"]
        assert error(client.patch(path, json={"text": DIAGNOSIS}, headers=AUTH))[2] == {"reason": "diagnosis"}
        client.put(url(u, "/settings"), json={"enabled": False}, headers=AUTH)
        assert error(client.patch(path, json={"confirm": True}, headers=AUTH))[:2] == (409, "MEMORY_DISABLED")


def test_forget_one_and_forget_all_work_even_with_memory_off(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        turn_on(client, u)
        first, second = add(client, u).json(), add(client, u, "interest", "Любит джаз и пластинки").json()
        client.put(url(u, "/settings"), json={"enabled": False}, headers=AUTH)
        assert client.delete(url(u, f"/facts/{first['id']}"), headers=AUTH).status_code == 204
        assert client.delete(url(u, f"/facts/{first['id']}"), headers=AUTH).status_code == 204  # повтор
        assert [f["id"] for f in client.get(url(u), headers=AUTH).json()["facts"]] == [second["id"]]
        assert client.delete(url(u), headers=AUTH).status_code == 204
        body = client.get(url(u), headers=AUTH).json()
        assert body["facts"] == [] and body["consentVersion"] == CONSENT  # согласие и выключатель не тронуты
        assert client.delete(url(u), headers=AUTH).status_code == 204


def test_export_has_everything_and_events_have_no_texts(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        turn_on(client, u)
        fact = add(client, u).json()
        client.delete(url(u, f"/facts/{fact['id']}"), headers=AUTH)
        add(client, u, "interest", "Любит джаз и пластинки")
        export = client.get(url(u, "/export"), headers=AUTH).json()
        assert export["rulesVersion"] and export["exportedAt"] and export["settings"]["enabled"]
        assert [f["text"] for f in export["facts"]] == ["Любит джаз и пластинки"]
        assert [e["op"] for e in export["events"]] == ["user_add", "user_delete", "user_add"]
        assert all(set(e) == {"factId", "op", "actor", "dialogId", "at"} for e in export["events"])


def wait_changes(client: TestClient, u: str, dialog_id: str, status: str, seconds: float = 10) -> dict[str, Any]:
    deadline = time.monotonic() + seconds
    while True:
        body = client.get(url(u, f"/changes?dialogId={dialog_id}"), headers=AUTH).json()
        if body["status"] == status or time.monotonic() > deadline:
            return body
        time.sleep(0.05)


def converse(client: TestClient, u: str, texts: list[str], memory: str = "on") -> str:
    from tests.conftest import read_frames, send_user_message, ws_url

    dialog = client.post(f"/v1/users/{u}/dialogs", json={"memory": memory, "new": True}, headers=AUTH).json()
    with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
        for index, text in enumerate(texts):
            send_user_message(ws, f"c-{index}", text)
            read_frames(ws, lambda f: any(x[0] == "json" and x[1]["type"] == "assistant_end" for x in f))
    assert client.post(f"/v1/users/{u}/dialogs/{dialog['dialogId']}/end", headers=AUTH).status_code == 200
    return dialog["dialogId"]


def test_changes_after_a_conversation(tmp_path: Path) -> None:
    """Конец разговора → задание в фоне → карточка «Я запомнил»: pending, затем ready с фактом (MEM-10)."""
    u = user()
    model = FakeModel(answer(op(evidence=[2])))
    with make_client(tmp_path / "a.sqlite3", model) as client:
        turn_on(client, u)
        texts = ["Привет, был тяжёлый день", "Меня вечером спасают прогулки", "Собака Бим смешной", "Пойду спать"]
        dialog_id = converse(client, u, texts)
        body = wait_changes(client, u, dialog_id, "ready")
        assert body["status"] == "ready", body
        [item] = body["items"]
        assert item["op"] == "add" and item["fact"]["text"] == "Помогают вечерние прогулки"
        assert item["fact"]["sources"][0]["dialogId"] == dialog_id
        assert client.get(url(u), headers=AUTH).json()["facts"][0]["seenByUser"] is True
        short = converse(client, u, ["Привет"])
        assert wait_changes(client, u, short, "skipped") == {"status": "skipped", "reason": "too_short", "items": []}
        off = converse(client, u, texts, memory="off")
        assert wait_changes(client, u, off, "skipped")["reason"] == "memory_off"
        assert error(client.get(url(user(), f"/changes?dialogId={dialog_id}"), headers=AUTH))[:2] == (
            404,
            "AGENT_DIALOG_NOT_FOUND",
        )


def test_dialogs_carry_the_memory_mode(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        plain = client.post(f"/v1/users/{u}/dialogs", headers=AUTH).json()
        assert (plain["memoryMode"], plain["memoryEnabled"]) == ("on", False)
        turn_on(client, u)
        again = client.post(f"/v1/users/{u}/dialogs", json={"memory": "off"}, headers=AUTH).json()
        # пустой открытый диалог с другой памятью не переиспользуется: начат новый «Без памяти»
        assert again["dialogId"] != plain["dialogId"] and again["memoryMode"] == "off" and again["memoryEnabled"] is True
        items = client.get(f"/v1/users/{u}/dialogs", headers=AUTH).json()["items"]
        assert [i["memoryMode"] for i in items] == ["off"]
        assert client.get(f"/v1/users/{u}/dialogs/{again['dialogId']}", headers=AUTH).json()["memoryMode"] == "off"
        resumed = client.post(f"/v1/users/{u}/dialogs", json={"memory": "off"}, headers=AUTH).json()
        assert resumed["dialogId"] == again["dialogId"] and resumed["resumed"]


def test_health_shows_memory(tmp_path: Path) -> None:
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        assert client.get("/health/ready").json()["memory"] == "on"
    with make_client(tmp_path / "a.sqlite3", FakeModel(), MEMORY_MODE="shadow") as client:
        assert client.get("/health/ready").json()["memory"] == "shadow"
    with make_client(tmp_path / "a.sqlite3", None) as client:  # режим включён, а модели извлечения нет
        assert client.get("/health/ready").json()["memory"] == "unavailable"
        assert client.get(url(user()), headers=AUTH).json()["available"] is False
    with make_client(None, FakeModel()) as client:  # без диска памяти нет
        assert client.get("/health/ready").json()["memory"] == "off"


def test_short_facts_built_from_slots_are_accepted(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "a.sqlite3", FakeModel()) as client:
        turn_on(client, u)
        mom = add(client, u, "person", None, slots={"role": "мама"})
        assert mom.status_code == 201 and mom.json()["text"] == "Мама"
        tone = add(client, u, "style", None, slots={"form": "ty"})
        assert tone.status_code == 201 and tone.json()["text"] == "На «ты»"
        assert error(add(client, u, "works", "Бегать"))[2] == {"reason": "too_short"}  # свободный текст — от 8 знаков
