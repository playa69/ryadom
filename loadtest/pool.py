"""Пул тестовых аккаунтов для публичного нагрузочного теста (слышу-рядом.рф).

Регистрация идёт анонимным путём приложения: POST /api/auth/device
(deviceId+deviceKey создают аккаунт на месте). Маршрут ограничен
30 запросами в час с одного IP (RATE_LIMITS.deviceLogin), поэтому пул
создаётся ЗАРАНЕЕ и переиспользуется между прогонами — тест не дудосит
регистрацию. Refresh-токены одноразовые (ротация): refresh-all обновляет
пары и переписывает pool.json, поэтому перед прогоном вызывайте его.

Использование:
  python pool.py create 30      # создать/добрать пул до 30 аккаунтов
  python pool.py refresh-all    # свежая пара токенов каждому (перед прогоном)
  python pool.py stats          # состояние пула

Файл пула: loadtest/pool.json (в .gitignore — содержит креды).
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import tempfile
import time
from pathlib import Path

import requests

BASE_URL = "https://xn----htbtgjker8b3a2c.xn--p1ai"  # слышу-рядом.рф
POOL_PATH = Path(__file__).parent / "pool.json"
OFFER_VERSION = time.strftime("%Y-%m-%d")


def load_pool() -> list[dict]:
    """Читает pool.json; пустой пул, если файла нет."""
    if not POOL_PATH.exists():
        return []
    return json.loads(POOL_PATH.read_text(encoding="utf-8"))


def save_pool(pool: list[dict]) -> None:
    """Атомарно переписывает pool.json (tmp + rename)."""
    with tempfile.NamedTemporaryFile(
        "w", dir=POOL_PATH.parent, delete=False, encoding="utf-8"
    ) as tmp:
        json.dump(pool, tmp, ensure_ascii=False, indent=1)
    Path(tmp.name).rename(POOL_PATH)


def api_post(path: str, body: dict, token: str | None = None) -> tuple[int, dict]:
    """POST к публичному API с разбором конверта {status, result}."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.post(f"{BASE_URL}{path}", json=body, headers=headers, timeout=30)
    try:
        payload = resp.json()
    except ValueError:
        return resp.status_code, {}
    return resp.status_code, payload


def create(target: int) -> None:
    """Добирает пул до target аккаунтов, уважая лимит 30/час на IP."""
    pool = load_pool()
    while len(pool) < target:
        # Префикс `loadtest-` (ANALYTICS_TEST_DEVICE_PREFIX сервера) помечает аккаунт тестовым до первого события:
        # его трафик не попадает в DAU и воронку продуктовой аналитики. Длина id по правилам API — 16–64 знака.
        device_id = "loadtest-" + secrets.token_urlsafe(24)[:39]
        device_key = secrets.token_urlsafe(48)[:96]
        code, payload = api_post(
            "/api/auth/device", {"deviceId": device_id, "deviceKey": device_key}
        )
        if code == 429:
            print(f"HTTP 429: лимит deviceLogin (30/час с IP) исчерпан, "
                  f"в пуле {len(pool)} аккаунтов. Продолжите через час.")
            save_pool(pool)
            return
        if code != 200 or not payload.get("status"):
            print(f"Ошибка регистрации: HTTP {code} {payload}")
            save_pool(pool)
            sys.exit(1)
        account = {
            "deviceId": device_id,
            "deviceKey": device_key,
            "userId": payload["result"]["user"]["id"],
            "accessToken": payload["result"]["tokens"]["accessToken"],
            "refreshToken": payload["result"]["tokens"]["refreshToken"],
            "expiresAt": payload["result"]["tokens"]["expiresAt"],
        }
        # Согласия первого экрана: без них POST /api/dialogs отвечает CONSENT_REQUIRED.
        consent_code, consent = api_post(
            "/api/auth/me/consents",
            {
                "ageConfirmed": True,
                "disclaimerAccepted": True,
                "offerAccepted": True,
                "offerVersion": OFFER_VERSION,
            },
            token=account["accessToken"],
        )
        if consent_code != 200 or not consent.get("status"):
            print(f"Ошибка consents для {account['userId']}: HTTP {consent_code} {consent}")
            save_pool(pool)
            sys.exit(1)
        pool.append(account)
        save_pool(pool)
        print(f"[{len(pool)}/{target}] аккаунт {account['userId']} создан")
    print(f"Пул готов: {len(pool)} аккаунтов")


def refresh_all() -> None:
    """Обновляет пару токенов каждого аккаунта (refresh без per-IP лимита)."""
    pool = load_pool()
    dead = 0
    for i, account in enumerate(pool):
        code, payload = api_post("/api/auth/refresh", {"refreshToken": account["refreshToken"]})
        if code != 200 or not payload.get("status"):
            print(f"  ! {account['userId']}: refresh не удался (HTTP {code}) — аккаунт мёртв")
            dead += 1
            continue
        pool[i]["accessToken"] = payload["result"]["accessToken"]
        pool[i]["refreshToken"] = payload["result"]["refreshToken"]
        pool[i]["expiresAt"] = payload["result"]["expiresAt"]
    save_pool(pool)
    print(f"Обновлено {len(pool) - dead} из {len(pool)}; мёртвых: {dead}")


def stats() -> None:
    """Печатает состояние пула."""
    pool = load_pool()
    now_ms = time.time() * 1000
    alive_tokens = sum(1 for a in pool if a.get("expiresAt", 0) > now_ms)
    print(f"Аккаунтов: {len(pool)}, access-токены живы: {alive_tokens}")


def main() -> None:
    """Разбирает команду."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["create", "refresh-all", "stats"])
    parser.add_argument("count", nargs="?", type=int, default=30)
    args = parser.parse_args()
    if args.command == "create":
        create(args.count)
    elif args.command == "refresh-all":
        refresh_all()
    else:
        stats()


if __name__ == "__main__":
    main()
