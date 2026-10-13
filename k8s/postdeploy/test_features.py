"""Новые возможности выката 0.6.0 в бою: память агента от согласия до стирания.

Запускается отдельно и только по просьбе (`POSTDEPLOY_FEATURES=1`): ходит в модель извлечения и в Gemini, оставляет в проде тестовые данные.

Аккаунт отдельный от аккаунта миграционных проверок: id устройства с префиксом `loadtest-` (ANALYTICS_TEST_DEVICE_PREFIX сервера), поэтому api
с 0.6.1 помечает его тестовым ДО первого события, и аналитика не считает его людьми (события приходят со свойством traffic_type=test).
Аккаунт создаётся один раз, креды в файле `POSTDEPLOY_FEATURES_ACCOUNT` (по умолчанию `features.json`, в git не попадает) и дальше переиспользуются.

Тест повторяем: в начале стирает память аккаунта, в конце снова стирает и выключает её. Тексты фактов в вывод не попадают, только счётчики.

  POSTDEPLOY_FEATURES=1 POSTDEPLOY_FEATURES_ACCOUNT=<файл> pytest test_features.py --expect post
"""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path

import pytest

from common import Api, ApiError, DialogSocket, TurnResult

pytestmark = pytest.mark.skipif(os.environ.get("POSTDEPLOY_FEATURES") != "1", reason="POSTDEPLOY_FEATURES=1 не задан")

ACCOUNT_PATH = Path(os.environ.get("POSTDEPLOY_FEATURES_ACCOUNT", "features.json"))
MEMORY_CONSENT_VERSION = "2026-10-12"  # app/packages/contracts/src/api/memory.ts
EXTRACTION_WAIT_SECONDS = 180

# Вымышленная персона: прямые утверждения о себе, из которых правила памяти разрешают сделать факты.
# Для извлечения нужно не меньше четырёх реплик человека (R.RENEW_AFTER_NEW_USER_MESSAGES) или явная просьба «запомни…».
STATEMENTS = [
    "Давай договоримся: обращайся ко мне на «ты» и отвечай коротко, без длинных советов.",
    "Запомни, пожалуйста: мою сестру зовут Аня. Она недавно переехала в другой город, и мы теперь редко видимся.",
    "Сейчас у меня много работы, дедлайн в конце месяца, поэтому я устаю.",
    "Мне помогает, когда я просто выговариваюсь, а мне не отвечают сразу советами.",
]
NOT_REMEMBERED = "Я люблю собирать старые почтовые марки, это моё тайное увлечение."


@pytest.fixture(scope="module")
def api() -> Api:
    return Api(os.environ.get("PUBLIC_BASE_URL", Api().base_url))


@pytest.fixture(scope="module")
def account(api: Api) -> dict:
    """Тестовый аккаунт для проверки новых возможностей; создаётся один раз и записывается в файл сразу."""
    if ACCOUNT_PATH.exists():
        return json.loads(ACCOUNT_PATH.read_text(encoding="utf-8"))
    device_id = "loadtest-features-" + secrets.token_urlsafe(24)[:24]
    device_key = secrets.token_urlsafe(48)[:96]
    login = api.device_login(device_id, device_key)
    assert login["isNewAccount"] is True
    data = {"userId": login["user"]["id"], "deviceId": device_id, "deviceKey": device_key}
    ACCOUNT_PATH.write_text(json.dumps(data), encoding="utf-8")  # креды сохранены до любых действий с аккаунтом
    api.accept_consents(login["tokens"]["accessToken"], time.strftime("%Y-%m-%d"))
    return data


@pytest.fixture(scope="module")
def token(api: Api, account: dict) -> str:
    login = api.device_login(account["deviceId"], account["deviceKey"])
    assert login["isNewAccount"] is False and login["user"]["id"] == account["userId"]
    return login["tokens"]["accessToken"]


def converse(api: Api, token: str, dialog_id: str, texts: list[str]) -> list[TurnResult]:
    turns: list[TurnResult] = []
    with DialogSocket(token, dialog_id) as sock:
        for text in texts:
            turn = sock.run_turn(text)
            assert turn.ack and turn.assistant_text.strip(), "ответа нет"
            turns.append(turn)
    return turns


def end_dialog(api: Api, token: str, dialog_id: str) -> None:
    api.result("POST", f"/api/dialogs/{dialog_id}/end", token=token, body={})


def wait_changes(api: Api, token: str, dialog_id: str) -> dict:
    """Извлечение идёт в фоне через модель: ждём, пока оно закончится."""
    deadline = time.monotonic() + EXTRACTION_WAIT_SECONDS
    while True:
        changes = api.result("GET", "/api/memory/changes", token=token, params={"dialogId": dialog_id})
        if changes["status"] != "pending":
            return changes
        assert time.monotonic() < deadline, f"извлечение не закончилось за {EXTRACTION_WAIT_SECONDS} с"
        time.sleep(4)


def test_memory_from_consent_to_forgetting(api: Api, token: str, account: dict) -> None:
    # 0. Сервер в нужном режиме; чистое начало (тест повторяем).
    memory = api.result("GET", "/api/memory", token=token)
    assert memory["mode"] == os.environ.get("EXPECT_MEMORY_MODE", "on") and memory["available"] is True
    api.result("DELETE", "/api/memory", token=token)
    api.result("PUT", "/api/memory/settings", token=token, body={"enabled": False})

    # 1. Включение требует согласия: без него отказ по правилу, с ним память включается и версия согласия записана.
    code, refusal = api.call("PUT", "/api/memory/settings", token=token, body={"enabled": True})
    assert code == 200 and refusal["status"] is False and refusal["errorCode"] == "CONSENT_REQUIRED"
    settings = api.result(
        "PUT",
        "/api/memory/settings",
        token=token,
        body={"enabled": True, "consentAccepted": True, "consentVersion": MEMORY_CONSENT_VERSION},
    )
    assert settings["enabled"] is True and settings["consentVersion"] == MEMORY_CONSENT_VERSION and settings["consentAt"]
    memory = api.result("GET", "/api/memory", token=token)
    assert memory["enabled"] is True and memory["facts"] == []

    # 2. Разговор «с памятью»: после его конца агент извлекает факты.
    first = api.start_dialog(token, startNew=True)
    assert first["memoryMode"] == "on" and first["memoryEnabled"] is True
    converse(api, token, first["dialogId"], STATEMENTS)
    end_dialog(api, token, first["dialogId"])
    changes = wait_changes(api, token, first["dialogId"])
    assert changes["status"] == "ready" and changes["items"], f"из разговора ничего не извлечено: {changes['status']} {changes['reason']}"
    print("извлечено:", sorted((item["op"], item["fact"]["category"]) for item in changes["items"]))

    memory = api.result("GET", "/api/memory", token=token)
    facts = memory["facts"]
    assert facts, "память пуста после извлечения"
    assert all(fact["status"] in ("active", "pinned", "candidate", "proposed") for fact in facts)
    assert any(source["dialogId"] == first["dialogId"] for fact in facts for source in fact["sources"]), "у фактов нет источника"
    assert len(facts) <= memory["limits"]["maxFacts"]

    # 3. Экспорт: те же факты, журнал изменений без текстов.
    export = api.result("GET", "/api/memory/export", token=token)
    assert export["settings"]["enabled"] is True and export["settings"]["consentVersion"] == MEMORY_CONSENT_VERSION
    assert {fact["id"] for fact in export["facts"]} >= {fact["id"] for fact in facts}
    assert export["events"], "журнал изменений пуст"

    # 4. Человек управляет фактом: закрепляет (агент такой факт не перезапишет).
    target = facts[0]
    pinned = api.result("PATCH", f"/api/memory/facts/{target['id']}", token=token, body={"status": "pinned"})
    assert pinned["status"] == "pinned"

    # 5. Разговор «Без памяти»: ничего не запоминается.
    before = len(api.result("GET", "/api/memory", token=token)["facts"])
    silent = api.start_dialog(token, startNew=True, memory="off")
    assert silent["memoryMode"] == "off"
    converse(api, token, silent["dialogId"], [NOT_REMEMBERED])
    end_dialog(api, token, silent["dialogId"])
    skipped = api.result("GET", "/api/memory/changes", token=token, params={"dialogId": silent["dialogId"]})
    assert skipped["status"] in ("skipped", "ready") and skipped["items"] == []
    assert len(api.result("GET", "/api/memory", token=token)["facts"]) == before, "разговор «Без памяти» оставил факт"

    # 6. Новый разговор с непустой памятью работает: сводка уходит в модель, ответ приходит голосом и текстом.
    third = api.start_dialog(token, startNew=True)
    assert third["memoryMode"] == "on"
    [turn] = converse(api, token, third["dialogId"], ["Привет! Как ты думаешь, с чего мне начать день?"])
    assert turn.tts_codec in (None, "pcm16") and turn.audio_frames, "озвучка не пришла"
    end_dialog(api, token, third["dialogId"])

    # 7. Забыть один факт (повтор тоже успешен), затем забыть всё.
    victim = api.result("GET", "/api/memory", token=token)["facts"][0]["id"]
    api.result("DELETE", f"/api/memory/facts/{victim}", token=token)
    api.result("DELETE", f"/api/memory/facts/{victim}", token=token)
    assert victim not in {fact["id"] for fact in api.result("GET", "/api/memory", token=token)["facts"]}
    api.result("DELETE", "/api/memory", token=token)
    assert api.result("GET", "/api/memory", token=token)["facts"] == []

    # 8. Выключение: память выключена, факты не появляются.
    off = api.result("PUT", "/api/memory/settings", token=token, body={"enabled": False})
    assert off["enabled"] is False
    assert api.result("GET", "/api/memory", token=token)["enabled"] is False


def test_the_account_is_not_a_person_for_analytics(account: dict) -> None:
    """Напоминание, а не проверка: пометку «тестовый» api ставит при создании по префиксу id устройства."""
    assert account["deviceId"].startswith("loadtest-")
