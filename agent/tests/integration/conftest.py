"""Фикстуры интеграционных тестов: временный Postgres в docker-контейнере."""

import shutil
import socket
import subprocess
import time
from collections.abc import Iterator

import pytest

PG_USER = "developer"
PG_PASSWORD = "test-pg-password"
PG_DB = "backend"


def _free_port() -> int:
    """Возвращает свободный TCP-порт на loopback."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def pg_dsn() -> Iterator[str]:
    """Поднимает postgres:17-alpine на свободном порту и отдаёт DSN.

    Контейнер останавливается и удаляется после прогона сессии тестов.
    """
    if not shutil.which("docker"):
        pytest.skip("docker недоступен: интеграционные тесты требуют Postgres")
    port = _free_port()
    name = f"ryadom-agent-test-pg-{port}"
    run = subprocess.run(
        [
            "docker", "run", "-d", "--name", name,
            "-e", f"POSTGRES_USER={PG_USER}",
            "-e", f"POSTGRES_PASSWORD={PG_PASSWORD}",
            "-e", f"POSTGRES_DB={PG_DB}",
            "-p", f"127.0.0.1:{port}:5432",
            "postgres:17-alpine",
        ],
        capture_output=True,
    )
    if run.returncode != 0:
        pytest.skip(f"не удалось поднять postgres в docker: {run.stderr.decode()}")
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            ready = subprocess.run(
                ["docker", "exec", name, "pg_isready", "-U", PG_USER, "-d", PG_DB],
                capture_output=True,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("postgres в docker не поднялся за 60 секунд")
        yield f"postgresql://{PG_USER}:{PG_PASSWORD}@127.0.0.1:{port}/{PG_DB}"
    finally:
        subprocess.run(["docker", "rm", "-f", name], check=False, capture_output=True)
