"""Утилиты маскирования чувствительных данных и форматирования тела запроса."""

import json
from typing import Any


path_fields = {
    "common": {
        "request": [],
        "response": [],
        "common": [],
    },
    "/api/v1/predict": {
        "request": [],
        "response": [],
        "common": [],
    },
    "gc.chat": {
        "request": [],
        "response": [],
        "common": [],
    },
    "gc.embeddings": {
        "request": [],
        "response": [],
        "common": [],
    },
}


def mask_sensitive_data(data: Any, path: str = "common", message_type: str = "common") -> Any:
    """Маскирует чувствительные поля данных."""
    path = path_fields.get(path, path_fields["common"])
    mask_fields = path.get(message_type, [])
    return _masker(data, mask_fields)


def _masker(data: Any, mask_fields: list[str]) -> Any:
    """Рекурсивно маскирует указанные поля в словарях и списках."""
    if isinstance(data, dict):
        return {k: ("***" if k.lower() in mask_fields else _masker(v, mask_fields)) for k, v in data.items()}
    if isinstance(data, list):
        return [_masker(item, mask_fields) for item in data]
    return data


# Ключи, содержащие пользовательский текст/контент — маскируем, показываем только длину
_SENSITIVE_KEYS = {
    "question",
    "text",
    "query",
    "messages",
    "content",
    "input_text",
    "model_answer",
    "user_message",
    "assistant_message",
    "answer",
}


def format_body_meta(data: Any) -> str:
    """Возвращает краткую мета-информацию о теле запроса."""
    if data is None:
        return "body_len=0"
    try:
        serialized = json.dumps(data, ensure_ascii=False)
        body_len = len(serialized)
    except (TypeError, ValueError):
        body_len = len(str(data))

    def _kv_parts(obj: Any) -> str:
        """Формирует пары ключ=значение."""
        parts = []
        for k, v in sorted(obj.items() if isinstance(obj, dict) else []):
            if k.lower() in _SENSITIVE_KEYS:
                parts.append(f"{k}_len={len(str(v))}")
            else:
                parts.append(f"{k}={v}")
        return " ".join(parts)

    if isinstance(data, dict):
        return f"body_len={body_len} {_kv_parts(data)}"
    if isinstance(data, list) and data:
        first_item = data[0]
        if isinstance(first_item, dict):
            return f"body_len={body_len} list[{len(data)}]:{_kv_parts(first_item)}"
        return f"body_len={body_len} list[{len(data)}]:{type(first_item).__name__}"
    return f"body_len={body_len} {type(data).__name__}"
