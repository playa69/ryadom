<<<<<<< HEAD
"""Локальный запуск агента с памятью Cognee для экспериментов.

Читает agent/.env (значения никуда не печатаются), подставляет ключ прокси из LLM_API_KEY в AGENT_API_TOKEN
(приложение читает только второй), включает MEMORY_MODE=on. Запуск из каталога agent/:

    .venv/bin/python scripts/local_memory_serve.py

Диалоги — в PostgreSQL, если задан DIALOG_DATABASE_URL (в env или .env), иначе только в памяти процесса; Cognee
ждётся на http://127.0.0.1:18000 (kubectl -n agent port-forward svc/cognee 18000:8000), пароль сервисного
пользователя — из k8s-секрета cognee-service-account (как AGENT_API_TOKEN, не печатается), озвучка Qwen.
=======
"""Локальный запуск агента с памятью для экспериментов (ветка feature/memory_samofalov).

Читает agent/.env (значения никуда не печатаются), подставляет ключ прокси из LLM_API_KEY в AGENT_API_TOKEN
(приложение читает только второй), включает MEMORY_MODE=on и локальный SQLite. Запуск из каталога agent/:

    .venv/bin/python scripts/local_memory_serve.py          # память на SQLite, как в бою
    .venv/bin/python scripts/local_memory_serve.py cognee   # память на Cognee (MEMORY_BACKEND=cognee)

Режим cognee: диалоги только в памяти процесса (DIALOG_DB_PATH не задаётся), пароль сервисного пользователя —
из k8s-секрета cognee-service-account (как AGENT_API_TOKEN, не печатается), Cognee ждётся на
http://127.0.0.1:18000 (kubectl -n agent port-forward svc/cognee 18000:8000), озвучка Qwen.
>>>>>>> origin/main
"""

import base64
import os
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

AGENT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = AGENT_DIR / "local_data"
KUBECONFIG = AGENT_DIR.parent / "admin-kubeconfig.yaml"
PROXY_URL = "https://shared1.multitool.works:4000/v1"


def cluster_secret(name: str, key: str) -> str:
    """Значение ключа секрета из ns agent: уходит только в env процесса, нигде не печатается."""
    result = subprocess.run(
        [
            "kubectl",
            f"--kubeconfig={KUBECONFIG}",
            "-n",
            "agent",
            "get",
            "secret",
            name,
            "-o",
            f"jsonpath={{.data.{key}}}",
        ],
        capture_output=True,
        check=True,
    )
    return base64.b64decode(result.stdout).decode()


def cluster_api_token() -> str:
    """AGENT_API_TOKEN из agent-secrets в кластере."""
    return cluster_secret("agent-secrets", "AGENT_API_TOKEN")


def main() -> None:
<<<<<<< HEAD
=======
    cognee = len(sys.argv) > 1 and sys.argv[1] == "cognee"
>>>>>>> origin/main
    file_values = {k: v for k, v in dotenv_values(AGENT_DIR / ".env").items() if v}
    env = dict(os.environ)
    env.update(file_values)
    env["AGENT_API_TOKEN"] = cluster_api_token()
    env.update(
        {
            "LOCAL": "true",
            "APP_HOST": "127.0.0.1",
            "APP_PORT": "8001",
            "LLM_BASE_URL": PROXY_URL,
            "MEMORY_MODE": "on",
            "STREAM_DELAY_MS": "0",
<<<<<<< HEAD
            # стенд: память включена всем без тумблера в профиле (в бою остаётся opt-in)
            "MEMORY_DEFAULT_ENABLED": "true",
            # чат-модель как в бою (значение из локального .env может быть протухшим)
            "LLM_CHAT_MODEL": "gigachat3.5-432b-a28b",
            "COGNEE_BASE_URL": "http://127.0.0.1:18000",
            "COGNEE_SERVICE_EMAIL": "agent-service@cognee.dev",
            "COGNEE_SERVICE_PASSWORD": cluster_secret("cognee-service-account", "COGNEE_SERVICE_PASSWORD"),
            "TTS_MODE": "qwen",
            "QWEN_TTS_BASE_URL": PROXY_URL,
            "QWEN_TTS_MODEL": "qwen/qwen-audio-3.0-tts-flash",
            "TTS_DEFAULT_VOICE": "male",
        }
    )
=======
        }
    )
    if cognee:
        env.update(
            {
                "MEMORY_BACKEND": "cognee",
                # стенд: память включена всем без тумблера в профиле (в бою остаётся opt-in)
                "MEMORY_DEFAULT_ENABLED": "true",
                # чат-модель как в бою (значение из локального .env может быть протухшим)
                "LLM_CHAT_MODEL": "gigachat3.5-432b-a28b",
                "COGNEE_BASE_URL": "http://127.0.0.1:18000",
                "COGNEE_SERVICE_EMAIL": "agent-service@cognee.dev",
                "COGNEE_SERVICE_PASSWORD": cluster_secret("cognee-service-account", "COGNEE_SERVICE_PASSWORD"),
                "TTS_MODE": "qwen",
                "QWEN_TTS_BASE_URL": PROXY_URL,
                "QWEN_TTS_MODEL": "qwen/qwen-audio-3.0-tts-flash",
                "TTS_DEFAULT_VOICE": "male",
            }
        )
        env.pop("DIALOG_DB_PATH", None)  # диалоги только в памяти процесса
    else:
        env.update(
            {
                "DIALOG_DB_PATH": str(DATA_DIR / "dialogs.sqlite3"),
                "DIALOG_DB_FLUSH_MS": "200",
                "MEMORY_BRIEF_LEVEL": "standard",
                "MEMORY_MAINTENANCE_SECONDS": "10",
                "MEMORY_LLM_MODEL": "gigachat-3-pro",
                "TTS_MODE": "none",
            }
        )
>>>>>>> origin/main
    missing = [key for key in ("AGENT_INTERNAL_TOKEN", "AGENT_API_TOKEN", "LLM_BASE_URL") if not env.get(key)]
    if missing:
        print(f"В .env не хватает: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)
    DATA_DIR.mkdir(exist_ok=True)
<<<<<<< HEAD
    dialogs = (
        f"PostgreSQL {env['DIALOG_DATABASE_URL'].split('@')[-1]}" if env.get("DIALOG_DATABASE_URL") else "память процесса"
    )
    print(f"agent на http://127.0.0.1:8001, память: Cognee http://127.0.0.1:18000, диалоги: {dialogs}")
=======
    if cognee:
        print("agent на http://127.0.0.1:8001, память: Cognee http://127.0.0.1:18000, диалоги в памяти процесса")
    else:
        print(f"agent на http://127.0.0.1:8001, SQLite: {DATA_DIR / 'dialogs.sqlite3'}, MEMORY_MODE=on")
>>>>>>> origin/main
    subprocess.run(
        [str(AGENT_DIR / ".venv/bin/uvicorn"), "app.main:app", "--host", "127.0.0.1", "--port", "8001"],
        cwd=AGENT_DIR,
        env=env,
    )


if __name__ == "__main__":
    main()
<<<<<<< HEAD
=======

>>>>>>> origin/main
