"""Фикстуры пост-деплойных проверок: снимок тестового аккаунта и вход в него."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from common import Api

BASELINE_PATH = Path(os.environ.get("POSTDEPLOY_BASELINE", "baseline.json"))


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--expect",
        choices=["pre", "post"],
        default=os.environ.get("POSTDEPLOY_EXPECT", "post"),
        help="post (по умолчанию): после выката, ждём новые возможности; pre: на текущем проде, чтобы проверить сами проверки",
    )


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "post_only: проверка новых возможностей выката, в режиме pre пропускается")
    config.addinivalue_line("markers", "full: дополнительная проверка (ещё одна реплика через Gemini), нужен POSTDEPLOY_FULL=1")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    pre = config.getoption("--expect") == "pre"
    full = os.environ.get("POSTDEPLOY_FULL") == "1"
    for item in items:
        if pre and "post_only" in item.keywords:
            item.add_marker(pytest.mark.skip(reason="режим pre: новая возможность выката"))
        if "full" in item.keywords and not full:
            item.add_marker(pytest.mark.skip(reason="POSTDEPLOY_FULL=1 не задан"))


@pytest.fixture(scope="session")
def expect_post(request: pytest.FixtureRequest) -> bool:
    return request.config.getoption("--expect") == "post"


@pytest.fixture(scope="session")
def baseline() -> dict:
    """Снимок посева. Нет файла или он неполный — это провал, а не пропуск: без него миграцию проверить нечем."""
    if not BASELINE_PATH.exists():
        pytest.fail(f"нет снимка {BASELINE_PATH}: задайте POSTDEPLOY_BASELINE (посев — seed.py)", pytrace=False)
    data = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    if not data.get("complete"):
        pytest.fail(f"снимок {BASELINE_PATH} неполный: посев оборвался", pytrace=False)
    return data


@pytest.fixture(scope="session")
def api(baseline: dict) -> Api:
    return Api(os.environ.get("PUBLIC_BASE_URL", baseline["baseUrl"]))


@pytest.fixture(scope="session")
def login(api: Api, baseline: dict) -> dict:
    account = baseline["account"]
    return api.device_login(account["deviceId"], account["deviceKey"])


@pytest.fixture(scope="session")
def token(login: dict) -> str:
    return login["tokens"]["accessToken"]
