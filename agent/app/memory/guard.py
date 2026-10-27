"""Проверки заметки в коде: что не сохраняется никогда и что только по согласию (PROTEUS-242, задача 2.3, `design.md` D3).

Стоят после модели извлечения и до записи, а также перед правкой заметки человеком: модель ошибается, код — нет.
Причина отказа — короткий код без текста, он идёт в метрику `agent_memory_blocked_total{reason}` и в ответ `NOTE_REJECTED`.
"""

import re
from dataclasses import dataclass

from app.memory.masking import has_personal_data

NOTE_MAX_CHARS = 200

KINDS = ("name", "style", "person", "situation", "event", "agreement", "interest", "boundary", "wellbeing", "beliefs")
# Группы, которые считаются чувствительными и требуют согласия (решение 0.1 может сузить список).
SENSITIVE_KINDS = frozenset({"wellbeing", "beliefs"})


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: str | None = None


def _rx(*words: str) -> re.Pattern[str]:
    return re.compile("|".join(words), re.IGNORECASE)


# Причина → признаки в тексте заметки. Список осознанно грубый: лучше не запомнить, чем запомнить запретное.
_NEVER: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "diagnosis",
        _rx(
            r"диагноз", r"депресси[яюи]\b", r"тревожн\w+ расстройств", r"биполярн", r"шизофрен", r"\bпрс\b", r"\bптср\b", r"\bсдвг\b",
            r"расстройств\w+ (?:личности|пищев)", r"\bрпп\b", r"аутизм", r"невроз", r"панически\w+ атак",
        ),
    ),
    (
        "medication",
        _rx(
            r"антидепрессант", r"таблетк", r"лекарств", r"препарат", r"принимает \w+ мг", r"\bмг\b", r"сертралин", r"феназепам",
            r"транквилизатор", r"нейролептик", r"золофт", r"прозак",
        ),
    ),
    (
        "self_harm",
        _rx(
            r"суицид", r"самоубий", r"покончить с собой", r"не хочет жить", r"не хочу жить", r"хочет умереть", r"хочу умереть",
            r"самоповрежд", r"режет себя", r"резал[аи]? себя", r"навредить себе", r"мысли о смерти", r"убить себя",
            r"лучше бы (?:меня|мне) не было", r"лучше бы я не (?:родил|жил)", r"хочу исчезнуть", r"хочется исчезнуть", r"не хочу (?:больше )?быть",
        ),
    ),
    ("document", _rx(r"паспорт", r"снилс", r"\bинн\b", r"водительск\w+ удостоверен", r"полис")),
    ("payment", _rx(r"номер карты", r"банковск\w+ счёт", r"банковск\w+ счет", r"\bcvv\b", r"\bcvc\b", r"\biban\b", r"пин-код", r"пароль")),
    ("label", _rx(r"\bнарцисс", r"\bтоксичн\w+ человек", r"\bневротик", r"\bпсихопат", r"\bслабак", r"\bнеудачник", r"\bтормоз\b")),
    (
        "instruction",
        _rx(
            r"игнорир", r"забудь (?:все )?(?:предыдущ|инструкц|правил)", r"ты должен", r"ты обязан", r"всегда отвечай", r"никогда не говори",
            r"отвечай\b", r"отвечать (?:только|всегда|одним|строго)", r"ответы только", r"получать ответы только", r"соглашаться со всем",
            r"не (?:записывать|хранить|сохранять|запоминать)", r"не (?:записывай|храни|сохраняй|запоминай)",
            r"system prompt", r"системн\w+ (?:промпт|инструкц)",
        ),
    ),
)

# «Не хочу жить» и подобное — кризис, а не заметка; в проверке на самоповреждение оно уже есть.


def check_note(text: str, kind: str, sensitive_enabled: bool) -> Verdict:
    """Можно ли хранить такую заметку. `sensitive_enabled` — включён ли переключатель «Запоминать чувствительное»."""
    cleaned = text.strip()
    if not cleaned:
        return Verdict(False, "empty")
    if len(cleaned) > NOTE_MAX_CHARS:
        return Verdict(False, "too_long")
    if kind not in KINDS:
        return Verdict(False, "bad_kind")
    if has_personal_data(cleaned):
        return Verdict(False, "contact_pii")
    for reason, pattern in _NEVER:
        if pattern.search(cleaned):
            return Verdict(False, reason)
    if kind in SENSITIVE_KINDS and not sensitive_enabled:
        return Verdict(False, "sensitive_off")
    return Verdict(True)


# Из этих причин состоит и список «в индекс прошлых разговоров не попадает» (`design.md` D4): диагнозы и лекарства, самоповреждение,
# документы и платёжное. Ярлыки и инструкции агенту — про заметки, а не про дословные слова человека.
_NEVER_IN_INDEX = frozenset({"diagnosis", "medication", "self_harm", "document", "payment"})


def forbidden_in_index(text: str) -> str | None:
    """Причина, по которой реплику нельзя класть в индекс прошлых разговоров (то же «никогда», что у заметок), или None."""
    for reason, pattern in _NEVER:
        if reason in _NEVER_IN_INDEX and pattern.search(text):
            return reason
    return None


def is_sensitive(kind: str) -> bool:
    return kind in SENSITIVE_KINDS
