"""Посев тестового аккаунта и диалогов в проде ДО выката: снимок, с которым пост-деплойные проверки сверяют данные после миграции.

Что делает:
  1. создаёт анонимный аккаунт по устройству (POST /api/auth/device) с id вида `loadtest-smoke-...` и принимает согласия;
  2. ведёт три диалога через публичный API и сокет, как приложение: два завершённых (с итогом) и один открытый;
  3. читает всё обратно через API и пишет снимок в файл (креды устройства + id диалогов + тексты сообщений).

Файл снимка содержит креды тестового аккаунта и тексты тестовых реплик. В репозиторий он не попадает (см. .gitignore),
хранить его нужно локально. Повторный посев поверх существующего файла запрещён: аккаунт один и живёт между выкатами.

Расход: пять коротких реплик через Gemini Live (порядка десятков тысяч токенов вместе с открытием сессий).
Аналитика: на api без отметки тестового трафика (до 0.6.1) события аккаунта попадут в продуктовую аналитику как обычные.
Пометить его тестовым — отдельное решение (исключающий список в аналитике), см. README.

  python seed.py --out baseline.json
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from common import Api, ApiError, DialogSocket

OFFER_VERSION = time.strftime("%Y-%m-%d")
SUMMARY_WAIT_SECONDS = 45

# (имя роли, число реплик, завершить ли, takeaway, оценка напряжения после)
PLAN = [
    ("ended-a", 2, True, "метка итога: проверка миграции", 3),
    ("ended-b", 1, True, None, 6),
    ("open", 2, False, None, None),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def wait_for_summary(api: Api, token: str, dialog_id: str) -> None:
    """Итог завершённого диалога строится не мгновенно: ждём, пока он появится в списке."""
    deadline = time.monotonic() + SUMMARY_WAIT_SECONDS
    while time.monotonic() < deadline:
        item = next((it for it in api.list_dialogs(token) if it["dialogId"] == dialog_id), None)
        if item is not None and item.get("summary") is not None:
            return
        time.sleep(3)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="baseline.json", help="куда писать снимок (default: baseline.json)")
    args = parser.parse_args()
    out = Path(args.out)
    if out.exists():
        print(f"{out} уже есть: тестовый аккаунт один и живёт между выкатами, второй посев не нужен", file=sys.stderr)
        print("(если снимок неполный — посев оборвался: удалите файл и посейте заново, прежний аккаунт останется в проде)", file=sys.stderr)
        return 2

    api = Api()
    run = secrets.token_hex(3)
    device_id = "loadtest-smoke-" + secrets.token_urlsafe(24)[:24]
    device_key = secrets.token_urlsafe(48)[:96]

    login = api.device_login(device_id, device_key)
    token = login["tokens"]["accessToken"]
    user_id = login["user"]["id"]
    if not login.get("isNewAccount"):
        raise ApiError("аккаунт уже существовал: посев рассчитан на новый")
    # Креды пишем сразу: если посев оборвётся, аккаунт не должен остаться в проде без возможности войти в него.
    baseline: dict = {
        "complete": False,
        "createdAt": utc_now(),
        "run": run,
        "baseUrl": api.base_url,
        "account": {"userId": user_id, "deviceId": device_id, "deviceKey": device_key},
        "dialogs": [],
    }
    out.write_text(json.dumps(baseline, ensure_ascii=False, indent=1), encoding="utf-8")
    api.accept_consents(token, OFFER_VERSION)
    print(f"аккаунт создан: {user_id}")

    dialogs: list[dict] = []
    for index, (role, turns, close, takeaway, tension) in enumerate(PLAN, start=1):
        started = api.start_dialog(token, startNew=True)
        dialog_id = started["dialogId"]
        print(f"[{role}] диалог {dialog_id} (resumed={started['resumed']})")
        with DialogSocket(token, dialog_id) as sock:
            for turn in range(1, turns + 1):
                marker = f"smoke-{run}-{index}-{turn}"
                reply = sock.run_turn(f"Проверка миграции данных, метка {marker}. Ответь одним коротким предложением.")
                print(f"  реплика {turn}: ack={reply.ack} ответ={len(reply.assistant_text)} симв. за {reply.seconds_total:.1f} с")
                if not reply.ack or not reply.assistant_text:
                    raise ApiError(f"диалог {role}: ответа нет")
            if close:
                sock.end(takeaway=takeaway, tension_after=tension)
                print("  завершён")
        if close:
            wait_for_summary(api, token, dialog_id)
        dialogs.append({"role": role, "dialogId": dialog_id})

    # Снимок читаем обратно через API: сверять потом нужно с тем, что отдаёт система, а не с тем, что мы отправили.
    listing = {item["dialogId"]: item for item in api.list_dialogs(token)}
    snapshot_dialogs = []
    for entry in dialogs:
        full = api.get_dialog(token, entry["dialogId"])
        item = listing[entry["dialogId"]]
        snapshot_dialogs.append(
            {
                "role": entry["role"],
                "dialogId": entry["dialogId"],
                "startedAt": item["startedAt"],
                "endedAt": item["endedAt"],
                "summary": item["summary"],
                "memoryMode": item.get("memoryMode"),  # поле есть с api 0.6.0: у более старого его нет
                "messages": [
                    {"id": m["id"], "role": m["role"], "text": m["text"], "createdAt": m["createdAt"]}
                    for m in full["messages"]
                ],
            }
        )
    baseline["complete"] = True
    baseline["dialogs"] = snapshot_dialogs
    out.write_text(json.dumps(baseline, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"снимок записан: {out} ({len(snapshot_dialogs)} диалога, сообщений: {sum(len(d['messages']) for d in snapshot_dialogs)})")
    for d in snapshot_dialogs:
        state = "завершён" if d["endedAt"] else "открыт"
        print(f"  {d['role']}: {d['dialogId']} {state}, сообщений {len(d['messages'])}, итог {'есть' if d['summary'] else 'нет'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
