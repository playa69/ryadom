"""Подавление реплик, из которых человек убрал заметку (PROTEUS-242, `design.md` D15).

Удалённая заметка не должна возвращаться дословной репликой из поиска по прошлым разговорам. Заметка помнит отпечаток реплики,
на которой она выросла; при удалении отпечаток помечается подавленным. Дальше работают два заслона:
- мгновенный: находки `CHUNKS` фильтруются по отпечаткам, пока документ в Cognee ещё прежний;
- окончательный: документ разговора пересобирается без этих реплик (`reindex_dialog` в очереди Cognee).
Хранится только отпечаток (SHA-256 от текста без регистра и знаков), а не сама реплика: копии слов, которые человек просил забыть,
мы не держим.
"""

import hashlib
import re

_STRIP = re.compile(r"[\s\W_]+", re.UNICODE)


def fingerprint(text: str) -> str:
    """Отпечаток реплики: без регистра, пробелов и знаков, поэтому совпадает со строкой документа «- реплика»."""
    return hashlib.sha256(_STRIP.sub("", text.lower()).encode("utf-8")).hexdigest()


def filter_found(found: str, suppressed: set[str]) -> str:
    """Находки Cognee без строк, чей отпечаток подавлен."""
    if not found or not suppressed:
        return found
    return "\n".join(line for line in found.split("\n") if fingerprint(line) not in suppressed)
