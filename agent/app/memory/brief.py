"""Сводка о человеке для голосовой модели (MEM-8): счёт фактов, отбор по бюджету, шаблон и кэш процесса.

Сводка собирается в фоне (при загрузке человека и после каждого изменения памяти) и лежит в `BriefCache`; на горячем пути
хода (`_instructions()`, `chat_messages()`) её только читают из словаря — ни диска, ни сети (I3). Невалидный кэш — пустая
сводка, а не старая: человек выключил память или всё стёр, и следующий ход обязан уже быть без неё.

Сводка — данные, а не команды (I10): заголовок говорит «со слов самого человека, может быть неточно», стиль общения собран из
слотов шаблоном, а в голосовую модель уходит не больше, чем разрешает уровень (`MEMORY_BRIEF_LEVEL`, I11).
"""

import threading
from dataclasses import dataclass
from datetime import datetime

from app.memory import filters
from app.memory import rules_ru as R
from app.memory.models import Brief, Fact, UserMemorySettings, iso, parse_iso

HEADER = "О собеседнике (со слов самого человека; может быть неточно или устареть; верь тому, что он говорит сейчас):"
TONE_HINT = "Прошлый разговор был тяжёлым: говори бережно, не расспрашивай о подробностях."
USAGE = (
    "Как пользоваться этим: упоминай только если разговор сам подходит к теме; не начинай с «я помню»; не перечисляй и не "
    "пересказывай;\nне напоминай о тяжёлом первым; не выдумывай подробностей, которых здесь нет; не угадывай род по имени; "
    "если не уверен, спроси.\nПамять не причина соглашаться: можно мягко не согласиться, если человек сильно винит себя."
)

_SHOWN = ("active", "pinned")


def score(fact: Fact, now: datetime) -> float:
    """Вес факта при отборе (MEM-8.1): важность × свежесть × подтверждения × вес категории; закреплённый ×1,5."""
    half_life = R.HALF_LIFE_DAYS[fact.category]
    if half_life is None:
        freshness = 1.0
    else:
        since = parse_iso(fact.last_confirmed_at or fact.created_at)
        age_days = max(0.0, (now - since).total_seconds() / 86400)
        freshness = 0.5 ** (age_days / half_life)
    value = (fact.importance / 5) * freshness * (1 + 0.25 * min(fact.confirm_count, 4)) * R.CATEGORY_WEIGHT[fact.category]
    return value * (R.PINNED_BOOST if fact.status == "pinned" else 1.0)


def _clean(text: str) -> str:
    return " ".join(text.split()).rstrip(" .;")


def _person(fact: Fact, level: str) -> str:
    slots = fact.slots or {}
    text = slots.get("role", "")
    if level == "full" and slots.get("name"):
        text += " " + slots["name"]
    note = slots.get("note")
    if note and not filters.blacklist_reason([note], "person"):
        text += f" ({_clean(note)})"
    return text


def _ago(fact: Fact, now: datetime) -> str:
    days = max(0, (now.date() - parse_iso(fact.created_at).date()).days)
    if days == 0:
        return "сегодня"
    if days == 1:
        return "вчера"
    if days % 10 == 1 and days % 100 != 11:
        word = "день"
    elif days % 10 in (2, 3, 4) and days % 100 not in (12, 13, 14):
        word = "дня"
    else:
        word = "дней"
    return f"{days} {word} назад"


def _boundary(text: str) -> str:
    text = _clean(text)
    return text[:1].lower() + text[1:] if text[:3].lower() == "не " else text


def render(chosen: list[Fact], settings: UserMemorySettings, level: str, now: datetime) -> str:
    """Шаблон MEM-8.3. Нет ни одной строки — пустая строка: блок в промпт не добавляется вообще."""
    by_category: dict[str, list[Fact]] = {}
    for fact in chosen:
        by_category.setdefault(fact.category, []).append(fact)
    lines: list[str] = []
    style = by_category.get("style")
    if style and style[0].slots:
        lines.append(f"Как говорить: {filters.style_phrase(style[0].slots)}.")
    if people := by_category.get("person"):
        lines.append("Близкие: " + "; ".join(_person(fact, level) for fact in people) + ".")
    now_items = [*by_category.get("situation", []), *by_category.get("goal", [])]
    if now_items:
        lines.append("Сейчас в жизни: " + "; ".join(_clean(fact.text) for fact in now_items) + ".")
    if works := by_category.get("works"):
        lines.append("Что помогает: " + "; ".join(_clean(fact.text) for fact in works) + ".")
    if interests := by_category.get("interest"):
        lines.append("Интересы: " + "; ".join(_clean(fact.text) for fact in interests) + ".")
    if boundaries := by_category.get("boundary"):
        lines.append("Просьба не касаться: " + "; ".join(_boundary(fact.text) for fact in boundaries) + ".")
    if recap := by_category.get("recap"):
        lines.append(f"Прошлый разговор ({_ago(recap[0], now)}): {_clean(recap[0].text)}.")
    if settings.tone_hint_until and settings.tone_hint_until > iso(now):
        lines.append(TONE_HINT)
    if not lines:
        return ""
    return "\n".join([HEADER, *lines, USAGE])


def eligible(fact: Fact, level: str) -> bool:
    """Может ли факт вообще попасть в сводку: только активный или закреплённый, не чувствительный, разрешённый уровнем и без
    запрещённого для голосовой модели содержимого (I11)."""
    if fact.status not in _SHOWN or fact.sensitivity != "normal":
        return False
    if fact.category not in R.BRIEF_LEVEL_CATEGORIES[level]:
        return False
    if fact.category == "style":  # в сводку идёт фраза из слотов, а не текст: её и проверяем
        return bool(fact.slots) and filters.brief_forbidden(filters.style_phrase(fact.slots), "style") is None
    return filters.brief_forbidden(fact.text, fact.category) is None


def build(facts: list[Fact], settings: UserMemorySettings, level: str, now: datetime) -> str:
    """Сводка человека: всегда стиль и границы, затем остальное по убыванию веса в пределах лимитов категорий и бюджета знаков.
    Одинаковый вход — одинаковая сводка."""
    if not settings.enabled:
        return ""
    pool = [fact for fact in facts if eligible(fact, level)]
    ranked = sorted(pool, key=lambda fact: (-score(fact, now), fact.created_at, fact.id))
    first = [fact for fact in ranked if fact.category == "style"][:1]
    first += [fact for fact in ranked if fact.category == "boundary"]
    rest = [fact for fact in ranked if fact.category not in ("style", "boundary")]
    chosen: list[Fact] = []
    counts: dict[str, int] = {}
    for fact in [*first, *rest]:
        limit = R.BRIEF_LIMITS[fact.category]
        if limit is not None and counts.get(fact.category, 0) >= limit:
            continue
        budget = R.BRIEF_MAX_CHARS if fact.category in ("style", "boundary") else R.BRIEF_TARGET_CHARS
        if len(render([*chosen, fact], settings, level, now)) > budget:
            continue
        chosen.append(fact)
        counts[fact.category] = counts.get(fact.category, 0) + 1
    text = render(chosen, settings, level, now)
    while len(text) > R.BRIEF_MAX_CHARS and chosen:  # потолок: лишнее отбрасывается с конца порядка отбора
        chosen.pop()
        text = render(chosen, settings, level, now)
    return text


@dataclass
class _Entry:
    brief: Brief
    settings: UserMemorySettings


class BriefCache:
    """Сводки и настройки людей в памяти процесса: user_id → сводка. Чтение синхронное и не бросает исключений наружу."""

    def __init__(self) -> None:
        self._items: dict[str, _Entry] = {}
        self._version = 0
        self._lock = threading.Lock()

    def put(self, user_id: str, text: str, settings: UserMemorySettings, now: datetime) -> Brief:
        with self._lock:
            self._version += 1
            brief = Brief(text=text, version=self._version, built_at=now, enabled=settings.enabled)
            self._items[user_id] = _Entry(brief, settings)
            return brief

    def get(self, user_id: str) -> Brief | None:
        entry = self._items.get(user_id)
        return entry.brief if entry is not None else None

    def settings(self, user_id: str) -> UserMemorySettings | None:
        entry = self._items.get(user_id)
        return entry.settings if entry is not None else None

    def text(self, user_id: str) -> str:
        """Текст сводки или пустая строка, если её нет или она невалидна."""
        entry = self._items.get(user_id)
        return entry.brief.text if entry is not None else ""

    def invalidate(self, user_id: str) -> None:
        """Сводка больше не верна: до пересборки разговор идёт без неё (а не со старой)."""
        with self._lock:
            entry = self._items.get(user_id)
            if entry is not None:
                self._version += 1
                self._items[user_id] = _Entry(
                    Brief(text="", version=self._version, built_at=entry.brief.built_at, enabled=entry.settings.enabled),
                    entry.settings,
                )

    def drop(self, user_id: str) -> None:
        with self._lock:
            self._items.pop(user_id, None)

    def users(self) -> list[str]:
        return list(self._items)

    def built_at(self, user_id: str) -> datetime | None:
        entry = self._items.get(user_id)
        return entry.brief.built_at if entry is not None else None
