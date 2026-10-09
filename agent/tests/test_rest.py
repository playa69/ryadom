"""REST-контракт agent-api (specs/agent-api)."""

import uuid

from tests.conftest import AUTH, FakeTts, make_client, start_dialog


def url(user_id: str, tail: str = "") -> str:
    return f"/v1/users/{user_id}/dialogs{tail}"


def test_health_needs_no_token(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/health/ready").status_code == 200
    assert "version" in client.get("/version").json()


def test_requests_without_valid_token_are_rejected(client, user_id):
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic test-internal-token"}):
        response = client.post(url(user_id), headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AGENT_UNAUTHORIZED"
    # ни один диалог не создан
    assert client.get(url(user_id), headers=AUTH).json()["items"] == []


def test_start_creates_then_resumes_the_same_dialog(client, user_id):
    first = start_dialog(client, user_id)
    assert first["resumed"] is False
    assert first["greeting"]
    assert first["sinceLastDialogHours"] is None

    second = start_dialog(client, user_id)
    assert second["dialogId"] == first["dialogId"]
    assert second["resumed"] is True


def test_start_after_end_opens_a_new_dialog_and_reports_hours(client, user_id):
    first = start_dialog(client, user_id)
    client.post(url(user_id, f"/{first['dialogId']}/end"), headers=AUTH)
    second = start_dialog(client, user_id)
    assert second["dialogId"] != first["dialogId"]
    assert second["resumed"] is False
    assert second["sinceLastDialogHours"] == 0


def test_journal_is_paged_newest_first(client, user_id):
    ids = []
    for _ in range(3):
        dialog = start_dialog(client, user_id)
        ids.append(dialog["dialogId"])
        client.post(url(user_id, f"/{dialog['dialogId']}/end"), headers=AUTH)
    open_one = start_dialog(client, user_id)["dialogId"]

    page1 = client.get(url(user_id), params={"limit": 2}, headers=AUTH).json()
    assert [i["dialogId"] for i in page1["items"]] == [open_one, ids[2]]
    assert page1["items"][0]["endedAt"] is None and page1["items"][0]["summary"] is None
    assert page1["next"]

    page2 = client.get(url(user_id), params={"limit": 2, "before": page1["next"]}, headers=AUTH).json()
    assert [i["dialogId"] for i in page2["items"]] == [ids[1], ids[0]]
    assert page2["next"] is None


def test_dialogs_started_within_one_millisecond_keep_their_order():
    from app.services.dialog_store import DialogStore

    store = DialogStore()
    stamps = [store.start(f"user-{i}")[0].started_at for i in range(300)]  # быстрее миллисекунды на диалог
    assert stamps == sorted(stamps) and len(set(stamps)) == len(stamps)


def test_get_dialog_has_messages_in_order(client, user_id):
    dialog = start_dialog(client, user_id)
    body = client.get(url(user_id, f"/{dialog['dialogId']}"), headers=AUTH).json()
    assert body["dialogId"] == dialog["dialogId"]
    assert body["messages"] == []


def test_foreign_and_missing_dialogs_look_the_same(client, user_id):
    dialog = start_dialog(client, user_id)
    stranger = str(uuid.uuid4())
    for target in (dialog["dialogId"], "no-such-dialog"):
        response = client.get(url(stranger, f"/{target}"), headers=AUTH)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "AGENT_DIALOG_NOT_FOUND"
    assert client.post(url(stranger, f"/{dialog['dialogId']}/end"), headers=AUTH).status_code == 404


def test_end_returns_a_summary_and_repeats_it(client, user_id):
    dialog = start_dialog(client, user_id)
    path = url(user_id, f"/{dialog['dialogId']}/end")
    first = client.post(path, json={"takeaway": "Было тяжело, но выговорился", "tensionAfter": 4}, headers=AUTH)
    assert first.status_code == 200
    summary = first.json()["summary"]
    assert summary["title"] == "Было тяжело, но выговорился"
    assert summary["tensionAfter"] == 4 and summary["themes"]

    again = client.post(path, headers=AUTH)  # тела нет, диалог уже завершён
    assert again.json()["summary"] == summary


def test_end_without_body_works(client, user_id):
    dialog = start_dialog(client, user_id)
    response = client.post(url(user_id, f"/{dialog['dialogId']}/end"), headers=AUTH)
    assert response.status_code == 200
    assert response.json()["summary"]["title"] == "Разговор"


def test_validation_errors_use_the_error_format(client, user_id):
    dialog = start_dialog(client, user_id)
    bad_requests = [
        client.post(url("not-a-uuid"), headers=AUTH),
        client.get(url(user_id), params={"limit": 0}, headers=AUTH),
        client.get(url(user_id), params={"limit": 51}, headers=AUTH),
        client.get(url(user_id), params={"before": "garbage"}, headers=AUTH),
        client.post(url(user_id, f"/{dialog['dialogId']}/end"), json={"tensionAfter": 11}, headers=AUTH),
    ]
    for response in bad_requests:
        assert response.status_code == 400, response.text
        error = response.json()["error"]
        assert error["code"] == "AGENT_VALIDATION"
        assert "message" in error and "details" in error


def test_erase_user_is_synchronous_and_idempotent(client, user_id):
    dialog = start_dialog(client, user_id)
    other = str(uuid.uuid4())
    other_dialog = start_dialog(client, other)

    assert client.delete(f"/v1/users/{user_id}", headers=AUTH).status_code == 204
    assert client.get(url(user_id, f"/{dialog['dialogId']}"), headers=AUTH).status_code == 404
    assert client.delete(f"/v1/users/{user_id}", headers=AUTH).status_code == 204
    # чужие данные не затронуты
    assert client.get(url(other, f"/{other_dialog['dialogId']}"), headers=AUTH).status_code == 200


def test_dev_tts_returns_wav(voice_client):
    response = voice_client.get("/dev/tts", params={"text": "Привет. Как дела?"}, headers=AUTH)
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-tts-provider"] == "fake"
    assert response.content[:4] == b"RIFF"


def test_dev_tts_without_speech_says_so():
    with make_client(None) as client:
        response = client.get("/dev/tts", params={"text": "Привет"}, headers=AUTH)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "VOICE_UNAVAILABLE"


def test_dev_tts_provider_failure_is_503():
    with make_client(FakeTts(fail=True)) as client:
        response = client.get("/dev/tts", params={"text": "Привет"}, headers=AUTH)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "VOICE_UNAVAILABLE"


# ─── access-лог ───────────────────────────────────────────────────────────────


def _access_record(path: str):
    import logging

    return logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0, '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:1", "GET", path, "1.1", 200), None
    )


def test_service_endpoints_are_not_written_to_the_access_log():
    from app.main import SkipServiceEndpoints

    keep = SkipServiceEndpoints()
    for path in ("/health", "/health/ready", "/version", "/health?x=1"):
        assert keep.filter(_access_record(path)) is False, path
    for path in ("/v1/users/u/dialogs", "/dev/tts?text=a", "/"):
        assert keep.filter(_access_record(path)) is True, path


def test_access_log_filter_is_installed_once():
    import logging

    from app.main import SkipServiceEndpoints, create_app

    create_app()
    create_app()
    installed = [f for f in logging.getLogger("uvicorn.access").filters if isinstance(f, SkipServiceEndpoints)]
    assert len(installed) == 1


# ─── dev-переключатель озвучки (как у dev/agent-mock) ─────────────────────────


def test_dev_tts_mode_can_be_switched(voice_client):
    assert voice_client.get("/dev/tts", headers=AUTH).json() == {"mode": "auto", "provider": "fake", "effective": "fake"}

    off = voice_client.post("/dev/tts", json={"mode": "none"}, headers=AUTH).json()
    assert off == {"mode": "none", "provider": "fake", "effective": None}
    assert voice_client.get("/health/ready").json()["tts"] == "none"
    assert voice_client.get("/dev/tts", params={"text": "Привет"}, headers=AUTH).status_code == 503

    on = voice_client.post("/dev/tts", json={"mode": "auto"}, headers=AUTH).json()
    assert on["effective"] == "fake"


def test_dev_tts_mode_needs_a_valid_mode_and_the_token(voice_client):
    assert voice_client.post("/dev/tts", json={"mode": "loud"}, headers=AUTH).status_code == 400
    assert voice_client.post("/dev/tts", json={"mode": "none"}).status_code == 401


# ─── голос по роду ────────────────────────────────────────────────────────────


def test_dialog_voice_defaults_to_male_and_is_reported(client, user_id):
    assert start_dialog(client, user_id)["voice"] == "male"


def test_voice_can_be_chosen_when_starting_and_is_remembered(client, user_id):
    first = client.post(url(user_id), json={"voice": "female"}, headers=AUTH).json()
    assert first["voice"] == "female"
    client.post(url(user_id, f"/{first['dialogId']}/end"), headers=AUTH)

    # следующий диалог без явного голоса получает прошлый выбор
    second = start_dialog(client, user_id)
    assert second["voice"] == "female" and second["resumed"] is False

    # явный выбор меняет голос возобновлённого диалога
    again = client.post(url(user_id), json={"voice": "male"}, headers=AUTH).json()
    assert again["dialogId"] == second["dialogId"] and again["resumed"] is True and again["voice"] == "male"


def test_invalid_voice_is_rejected(client, user_id):
    response = client.post(url(user_id), json={"voice": "robot"}, headers=AUTH)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "AGENT_VALIDATION"


def test_erasing_a_user_forgets_the_voice_choice(client, user_id):
    client.post(url(user_id), json={"voice": "female"}, headers=AUTH)
    assert client.delete(f"/v1/users/{user_id}", headers=AUTH).status_code == 204
    assert start_dialog(client, user_id)["voice"] == "male"


def test_dev_tts_takes_the_voice(voice_client, voice):
    voice_client.get("/dev/tts", params={"text": "Привет", "voice": "female"}, headers=AUTH)
    voice_client.get("/dev/tts", params={"text": "Привет"}, headers=AUTH)
    assert voice.voices == ["female", "male"]
    assert voice_client.get("/dev/tts", params={"text": "Привет", "voice": "robot"}, headers=AUTH).status_code == 400
