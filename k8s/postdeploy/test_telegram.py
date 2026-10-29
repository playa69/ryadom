"""Telegram Mini App после выката api 0.7.0 и pwa 0.6.0.

Без аккаунтов: данные запуска подписывает только Telegram ключом бота, поэтому проверяется то, что видно снаружи —
PWA разрешает встраивание Telegram Web и никому больше, а вход через Telegram включён (токен бота задан) и
отклоняет данные, подписанные не нашим ботом.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest
import requests

from common import Api


def forged_init_data(user_id: int) -> str:
    """Данные запуска в формате Telegram, подписанные выдуманным ботом: сервер обязан их отклонить."""
    fields = {
        "auth_date": str(int(time.time())),
        "query_id": "AAPOSTDEPLOY",
        "user": json.dumps({"id": user_id, "first_name": "Проверка"}, ensure_ascii=False),
    }
    text = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))
    secret = hmac.new(b"WebAppData", b"1:not-our-bot", hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, text.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


@pytest.mark.post_only
def test_pwa_can_be_framed_by_telegram_web_only(api: Api) -> None:
    response = requests.get(f"{api.base_url}/pwa/", timeout=30)
    csp = response.headers.get("content-security-policy", "")
    ancestors = next((part.strip() for part in csp.split(";") if part.strip().startswith("frame-ancestors")), "")
    assert ancestors == "frame-ancestors https://web.telegram.org"


@pytest.mark.post_only
def test_telegram_sign_in_is_on_and_rejects_foreign_launch_data(api: Api) -> None:
    code, payload = api.call(
        "POST", "/api/auth/telegram", body={"initData": forged_init_data(42), "createAccount": False}
    )
    assert code == 200
    # NOT_CONFIGURED здесь означал бы, что ключ TELEGRAM_BOT_TOKEN в app-secrets не дошёл до api.
    assert payload == {"status": False, "errorCode": "INIT_DATA_INVALID", "errorMessage": "Launch data is not valid"}


@pytest.mark.post_only
def test_telegram_link_needs_a_token(api: Api) -> None:
    code, _ = api.call("POST", "/api/auth/telegram/link", body={"initData": forged_init_data(42)})
    assert code == 401
