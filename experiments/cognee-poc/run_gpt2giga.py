"""Запуск gpt2giga (OpenAI-совместимый прокси на GigaChat) для PoC.

Креды читает из ~/PycharmProjects/orchestrator/.env (GIGACHAT_API_KEY → GIGACHAT_CREDENTIALS),
значения никуда не печатаются. Слушает http://127.0.0.1:8400/v1.

    .venv/bin/python run_gpt2giga.py
"""

import os
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

ORCHESTRATOR_ENV = Path.home() / "PycharmProjects/orchestrator/.env"


def main() -> None:
    values = dotenv_values(ORCHESTRATOR_ENV)
    credentials = values.get("GIGACHAT_API_KEY")
    if not credentials:
        sys.exit(f"Нет GIGACHAT_API_KEY в {ORCHESTRATOR_ENV}")
    env = dict(os.environ)
    env.update(
        {
            "GIGACHAT_CREDENTIALS": credentials,
            "GIGACHAT_SCOPE": values.get("GIGACHAT_SCOPE", "GIGACHAT_API_PERS"),
            # на macOS нет корневых Минцифры — без этого handshake до GigaChat не поднимется
            "GIGACHAT_VERIFY_SSL_CERTS": values.get("GIGACHAT_VERIFY_SSL", "false"),
        }
    )
    print("gpt2giga на http://127.0.0.1:8400/v1 (upstream: GigaChat)")
    subprocess.run(
        [str(Path(__file__).parent / ".venv/bin/gpt2giga"), "--proxy.host", "127.0.0.1", "--proxy.port", "8400"],
        env=env,
    )


if __name__ == "__main__":
    main()
