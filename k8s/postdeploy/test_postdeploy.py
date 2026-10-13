"""Проверки после выката против боевого адреса (README.md, ранбук k8s/agent/POSTDEPLOY-0.6.0.md).

Три группы:
  1. сервисы живы: api, web, PWA, лендинг отвечают, закрытое закрыто;
  2. данные пережили миграцию: тестовый аккаунт, его диалоги и сообщения такие же, как в снимке до выката;
  3. приложение работает: диалог открывается, ответ приходит текстом и звуком, реплики сохраняются, новые кодеки согласуются.

Тексты реплик в вывод не попадают. Реплики идут в открытый тестовый диалог и остаются в нём (снимок сравнивается по началу).
"""

from __future__ import annotations

import os
from datetime import datetime

import pytest
import requests

from common import (
    FRAME_HEADER_BYTES,
    MULAW_FRAME_BYTES,
    PCM16_FRAME_BYTES,
    Api,
    DialogSocket,
    opus_packets,
)

EXPECT_MEMORY_MODE = os.environ.get("EXPECT_MEMORY_MODE", "off")


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def baseline_dialog(baseline: dict, role: str) -> dict:
    return next(d for d in baseline["dialogs"] if d["role"] == role)


# ─── 1. сервисы живы ─────────────────────────────────────────────────────────────


def test_api_health(api: Api) -> None:
    code, payload = api.call("GET", "/api/health")
    assert code == 200 and payload["status"] == "ok"


def test_app_status_is_open(api: Api) -> None:
    code, payload = api.call("GET", "/api/app-status", params={"platform": "android", "version_code": "1"})
    assert code == 200 and payload["status"] is True


def test_private_routes_need_a_token(api: Api) -> None:
    for path in ("/api/dialogs", "/api/auth/me"):
        code, _ = api.call("GET", path)
        assert code == 401, path


@pytest.mark.post_only
def test_memory_route_needs_a_token(api: Api) -> None:
    code, _ = api.call("GET", "/api/memory")
    assert code == 401


@pytest.mark.parametrize("path", ["/app", "/pwa/", "/"])
def test_front_ends_answer(api: Api, path: str) -> None:
    response = requests.get(f"{api.base_url}{path}", timeout=30, allow_redirects=True)
    assert response.status_code == 200
    assert "text/html" in response.headers.get("content-type", "")
    assert len(response.text) > 500


@pytest.mark.post_only
@pytest.mark.parametrize("path", ["/app", "/pwa/"])
def test_csp_lets_the_opus_decoder_run(api: Api, path: str) -> None:
    """WASM-декодер Opus не запустится без 'wasm-unsafe-eval' в script-src."""
    response = requests.get(f"{api.base_url}{path}", timeout=30)
    csp = response.headers.get("content-security-policy", "")
    script_src = next((part for part in csp.split(";") if part.strip().startswith("script-src")), "")
    assert "'wasm-unsafe-eval'" in script_src


# ─── 2. данные пережили миграцию ─────────────────────────────────────────────────


def test_test_account_is_the_same(login: dict, baseline: dict) -> None:
    assert login["isNewAccount"] is False
    assert login["user"]["id"] == baseline["account"]["userId"]


def test_dialogs_survived(api: Api, token: str, baseline: dict) -> None:
    listing = {item["dialogId"]: item for item in api.list_dialogs(token)}
    for expected in baseline["dialogs"]:
        item = listing.get(expected["dialogId"])
        assert item is not None, f"диалог {expected['role']} пропал"
        assert (item["endedAt"] is None) == (expected["endedAt"] is None), f"{expected['role']}: изменилось состояние"
        assert instant(item["startedAt"]) == instant(expected["startedAt"])
        if expected["endedAt"] is not None:
            assert instant(item["endedAt"]) == instant(expected["endedAt"])
        if expected["summary"] is not None:
            assert item["summary"] == expected["summary"], f"{expected['role']}: итог диалога изменился"
        if expected.get("memoryMode") is not None and item.get("memoryMode") is not None:
            assert item["memoryMode"] == expected["memoryMode"]


def test_messages_survived(api: Api, token: str, baseline: dict) -> None:
    """Начало истории каждого диалога совпадает со снимком: id, автор, текст и время."""
    for expected in baseline["dialogs"]:
        current = api.get_dialog(token, expected["dialogId"])["messages"]
        wanted = expected["messages"]
        assert len(current) >= len(wanted), f"{expected['role']}: сообщений стало меньше"
        for index, (now, then) in enumerate(zip(current, wanted, strict=False)):
            assert now["id"] == then["id"], f"{expected['role']}[{index}]: другой id"
            assert now["role"] == then["role"], f"{expected['role']}[{index}]: другой автор"
            assert now["text"] == then["text"], f"{expected['role']}[{index}]: текст изменился"
            assert instant(now["createdAt"]) == instant(then["createdAt"]), f"{expected['role']}[{index}]: время изменилось"


def test_open_dialog_resumes(api: Api, token: str, baseline: dict) -> None:
    """Старт диалога возвращает прежний открытый, а не заводит новый."""
    wanted = baseline_dialog(baseline, "open")
    started = api.start_dialog(token)
    assert started["resumed"] is True
    assert started["dialogId"] == wanted["dialogId"]
    assert started["messageCount"] >= len(wanted["messages"])


# ─── 3. приложение работает ──────────────────────────────────────────────────────


def check_pcm16(turn) -> None:  # noqa: ANN001
    assert turn.tts_codec in (None, "pcm16"), "клиент без списка кодеков должен получать pcm16"
    if turn.tts_codec is None:
        pytest.fail("озвучка не пришла (нет tts_start)")
    assert turn.audio_frames, "кадров озвучки нет"
    assert all(0 < len(body) <= PCM16_FRAME_BYTES for body in turn.audio_frames)
    assert turn.audio_seq == sorted(turn.audio_seq)


def test_text_turn_with_voice_for_a_legacy_client(api: Api, token: str, baseline: dict) -> None:
    """Клиент без `codecs` в hello (старое приложение): текст и озвучка pcm16, реплики сохранены."""
    wanted = baseline_dialog(baseline, "open")
    before = len(api.get_dialog(token, wanted["dialogId"])["messages"])
    with DialogSocket(token, wanted["dialogId"]) as sock:
        turn = sock.run_turn()
    assert turn.ack and turn.assistant_text.strip()
    assert turn.seconds_to_first_text is not None and turn.seconds_to_first_text < 30
    check_pcm16(turn)
    after = api.get_dialog(token, wanted["dialogId"])["messages"]
    assert len(after) >= before + 2, "реплика человека и ответ должны сохраниться"
    assert [m["role"] for m in after[-2:]] == ["user", "assistant"]


@pytest.mark.post_only
def test_opus_is_negotiated_and_well_formed(api: Api, token: str, baseline: dict) -> None:
    wanted = baseline_dialog(baseline, "open")
    with DialogSocket(token, wanted["dialogId"], codecs=["opus", "mulaw", "pcm16"]) as sock:
        turn = sock.run_turn()
    assert turn.ack and turn.assistant_text.strip()
    assert turn.tts_codec == "opus", f"выбран {turn.tts_codec}"
    assert turn.tts_sample_rate == 24000
    assert turn.audio_frames, "кадров озвучки нет"
    packets = 0
    for body in turn.audio_frames:
        for packet in opus_packets(body):
            assert 1 <= len(packet) <= 1275
            packets += 1
    assert packets >= 5
    pcm_equivalent = packets * 20 / 1000 * 24000 * 2
    opus_bytes = sum(len(body) for body in turn.audio_frames)
    assert opus_bytes < pcm_equivalent / 4, "сжатие хуже ожидаемого (должно быть порядка 1/16)"


@pytest.mark.post_only
@pytest.mark.full
def test_mulaw_is_negotiated(api: Api, token: str, baseline: dict) -> None:
    wanted = baseline_dialog(baseline, "open")
    with DialogSocket(token, wanted["dialogId"], codecs=["mulaw", "pcm16"]) as sock:
        turn = sock.run_turn()
    assert turn.tts_codec == "mulaw"
    assert turn.audio_frames and all(0 < len(body) <= MULAW_FRAME_BYTES for body in turn.audio_frames)


@pytest.mark.post_only
def test_memory_is_in_the_expected_mode(api: Api, token: str) -> None:
    memory = api.result("GET", "/api/memory", token=token)
    assert memory["mode"] == EXPECT_MEMORY_MODE
    assert memory["enabled"] is False, "у тестового аккаунта память включать не нужно"
    assert memory["facts"] == []


def test_frame_header_constant_is_sane() -> None:
    """Страховка самих проверок: заголовок кадра озвучки — 5 байт."""
    assert FRAME_HEADER_BYTES == 5
