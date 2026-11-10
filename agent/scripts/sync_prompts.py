"""Загрузка начальных промптов из внешнего JSON и проверка production-каталога."""

import argparse
import json
from pathlib import Path
from typing import Any

from app.core.config import APP_CONFIG, LangfuseSettings
from app.prompts.catalog import PROMPT_CATALOG
from app.prompts.provider import FETCH_TIMEOUT_SECONDS, MAX_RETRIES, PRODUCTION_LABEL

REPO_ROOT = Path(__file__).resolve().parents[2]


class SeedError(ValueError):
    """Внешний файл нельзя использовать для безопасной синхронизации."""


def load_seed(path: Path) -> dict[str, str]:
    """Читает полный набор текстов, не допуская файл внутри репозитория."""
    resolved = path.resolve()
    if resolved.is_relative_to(REPO_ROOT):
        raise SeedError("seed должен находиться вне репозитория")
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SeedError(f"seed не прочитан: {type(error).__name__}") from None
    if not isinstance(data, dict) or set(data) != set(PROMPT_CATALOG):
        raise SeedError("seed должен содержать ровно 15 имён из каталога")
    if any(not isinstance(text, str) or not text.strip() for text in data.values()):
        raise SeedError("все тексты seed должны быть непустыми строками")
    return data


def sync_prompts(client: Any, seed: dict[str, str] | None = None) -> list[str]:  # noqa: ANN401 — SDK или подделка
    """Создаёт только отсутствующие промпты и возвращает статусы без текстов."""
    statuses: list[str] = []
    for name, definition in PROMPT_CATALOG.items():
        try:
            current = client.get_prompt(
                name,
                label=PRODUCTION_LABEL,
                max_retries=MAX_RETRIES,
                fetch_timeout_seconds=FETCH_TIMEOUT_SECONDS,
            )
        except Exception as error:
            if not _not_found(error):
                raise
            current = None
        if current is None:
            if seed is None:
                statuses.append(f"missing {name}")
                continue
            client.create_prompt(
                name=name,
                prompt=seed[name],
                labels=[PRODUCTION_LABEL],
                tags=list(definition.tags),
                type="text",
                commit_message="Начальная версия агента",
            )
            statuses.append(f"created {name}")
        elif seed is not None and current.prompt != seed[name]:
            statuses.append(f"changed — skipped {name}")
        elif seed is not None:
            statuses.append(f"same {name}")
        else:
            statuses.append(f"present {name} version={current.version}")
    return statuses


def _not_found(error: Exception) -> bool:
    return (
        getattr(error, "status_code", None) == 404 or "NotFound" in type(error).__name__
    )


def _client(settings: LangfuseSettings) -> Any:
    """Создаёт SDK-клиент по секретам из настроек приложения."""
    from langfuse import Langfuse

    if settings.public_key is None or settings.secret_key is None:
        raise SystemExit("нужны LANGFUSE_PUBLIC_KEY и LANGFUSE_SECRET_KEY")
    return Langfuse(
        public_key=settings.public_key.get_secret_value(),
        secret_key=settings.secret_key.get_secret_value(),
        host=settings.host,
    )


def main() -> None:
    """Запускает проверку или идемпотентную загрузку."""
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check", action="store_true", help="только проверить production-промпты"
    )
    mode.add_argument(
        "--seed", type=Path, help="JSON вне репозитория с начальными текстами"
    )
    args = parser.parse_args()
    seed = load_seed(args.seed) if args.seed is not None else None
    for status in sync_prompts(_client(APP_CONFIG.langfuse), seed):
        print(status)


if __name__ == "__main__":
    main()
