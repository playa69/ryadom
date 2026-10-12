"""Проверки фактов и операций (MEM-6.2, MEM-7.5): чистые функции без ввода-вывода.

Модель только предлагает; в базу попадает лишь то, что прошло эти проверки (I7). Они же применяются к ручному вводу человека:
его запись тоже уйдёт в сводку голосовой модели. Коды причин — метки `agent_memory_blocked_total{reason}`; тексты фактов сюда
не логируются и в ошибки не попадают (I4).
"""

import hashlib
import re
import unicodedata
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta
from functools import lru_cache

from app.memory import rules_ru as R
from app.services.replies import is_crisis

# Латиница и цифры, похожие на кириллицу: «дeпрeссия» с латинскими e — та же «депрессия».
_HOMOGLYPHS = str.maketrans(
    {"a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "x": "х", "y": "у", "k": "к", "m": "м", "t": "т", "h": "н", "b": "в"}
)
_INVISIBLE = re.compile("[\u00ad\u200b-\u200f\u2060\ufeff]")
_LETTER_RUN = re.compile(r"([^\W\d_])\1+")
# Буквы через пробел или знак («д е п р е с с и я», «д.е.п.р.е.с.с.и.я»): не меньше трёх одиночных букв подряд.
_SEP = r"[\s.\-_*·'\"]+"
_SPACED = re.compile(rf"(?<!\w)\w(?:{_SEP}\w(?!\w)){{2,}}")
_BOUND = r"[а-яa-z0-9]"


def _base(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = _INVISIBLE.sub("", text).casefold().replace("ё", "е")
    return _LETTER_RUN.sub(r"\1", text)


def _join_spaced(text: str, split_first: bool = False) -> str:
    """Склеить буквы через пробел. `split_first`: первую букву оставить отдельно — к слову часто прилипает предлог
    («о с у и ц и д е» — это «о суициде»)."""

    def glue(match: re.Match[str]) -> str:
        letters = re.sub(_SEP, "", match.group(0))
        return letters[0] + " " + letters[1:] if split_first and len(letters) > 3 else letters

    return _LETTER_RUN.sub(r"\1", _SPACED.sub(glue, text))


def normalize(text: str) -> str:
    """Основная нормальная форма: нижний регистр, ё → е, двойники → кириллица, повторы букв схлопнуты, буквы через пробел склеены."""
    return _join_spaced(_LETTER_RUN.sub(r"\1", _base(text).translate(_HOMOGLYPHS)))


def forms(text: str) -> list[str]:
    """Все формы, по которым ищется запрещённое: латинские шаблоны (email, ссылки) живут в форме без замены двойников."""
    base = _base(text)
    mapped = _LETTER_RUN.sub(r"\1", base.translate(_HOMOGLYPHS))
    variants = [base, mapped]
    if _SPACED.search(base):
        variants += [_join_spaced(item, split) for item in (base, mapped) for split in (False, True)]
    return list(dict.fromkeys(variants))


@lru_cache(maxsize=None)
def _compile(entry: str) -> re.Pattern[str]:
    if entry.startswith("~"):
        return re.compile(entry[1:])
    if entry.startswith("="):
        return re.compile(rf"(?<!{_BOUND}){re.escape(entry[1:])}(?!{_BOUND})")
    return re.compile(rf"(?<!{_BOUND}){re.escape(entry)}")


def _hits(entries: Iterable[str], variants: Sequence[str]) -> bool:
    return any(_compile(entry).search(variant) for entry in entries for variant in variants)


_ROLE = re.compile(R.ROLE_STEMS_RE)
_ROLES = {_base(role): role for role in R.PERSON_ROLES}
# Слово с заглавной и сразу за ним второе (в просмотре вперёд: пары пересекаются — «Коллега Иван Петров»).
_FIO = re.compile(r"(?<![\w])([А-ЯЁA-Z][а-яёa-z]+(?:-[А-ЯЁA-Z]?[а-яёa-z]+)?)(?=\s+([А-ЯЁA-Z][а-яёa-z]+))")


# Окончания фамилий и отчеств: «Петров», «Смирнова», «Иванович», «Сергеевна», «Шевченко», «Гогидзе».
_SURNAME = re.compile(
    r"((ов|ев|ин|ын)(а|у|ым|ой|е|ы)?|(ск|цк)(ий|ая|ого|ой|ому)|(ович|евич)(а|у|ем|е)?|(овн|евн|ичн)(а|ы|е|ой|у)|енко|швили|дзе)$"
)


def _full_name(text: str, strict: bool) -> bool:
    """Два слова с заглавной подряд (имя и фамилия или отчество), если первое из них не роль близкого («Сестра Аня» — можно).
    Не у близких (`strict` ложь) второе слово должно быть похоже на фамилию или отчество: «Нижний Новгород» — не человек."""
    if text.isupper():  # «ИВАН ПЕТРОВ»: заглавными написано всё, имена видны только так
        text = text.title()
    for match in _FIO.finditer(text):
        first, second = (_base(word).translate(_HOMOGLYPHS) for word in match.groups())
        if first in _ROLES:
            continue
        if strict or _SURNAME.search(second):
            return True
    return False


def third_party(text: str, category: str) -> bool:
    """Чужие данные: здоровье или личная жизнь близкого («у сестры рак», «муж изменяет»), имя с фамилией или отчеством."""
    variants = forms(text)
    if any(_ROLE.search(variant) for variant in variants) and _hits(R.THIRD_PARTY_TOPICS, variants):
        return True
    return category != "style" and _full_name(text, strict=category == "person")


def blacklist_reason(texts: Sequence[str], category: str) -> str | None:
    """Код класса чёрного списка, если хоть один из текстов (текст факта, значения слотов) в него попадает; иначе None.

    Граница (`boundary`) допускает любую тему, кроме инструкций агенту, контактов и способов самоповреждения: «не говори
    про суицид» — это просьба, а не факт.
    """
    for text in texts:
        if not text:
            continue
        variants = forms(text)
        if category == "boundary":
            if _hits(R.CRISIS_METHODS, variants):
                return "crisis"
            for code in R.BOUNDARY_CHECKED:
                if _hits(R.BLACKLIST[code], variants):
                    return code
            continue
        if is_crisis(text) or _hits(R.BLACKLIST["crisis"], variants) or _hits(R.CRISIS_METHODS, variants):
            return "crisis"
        for code, entries in R.BLACKLIST.items():
            if code == "crisis":
                continue
            if code == "third_party_pii":
                if third_party(text, category):
                    return code
                continue
            if _hits(entries, variants):
                return code
    return None


def brief_forbidden(text: str, category: str = "person") -> str | None:
    """Чего нельзя отдавать голосовой модели ни при каких настройках (I11), в том числе в границах: диагнозы, кризисы,
    травма, лекарства, контакты, чужие данные. Повторная проверка при сборке сводки — страховка на случай смены правил."""
    variants = forms(text)
    if is_crisis(text) or _hits(R.CRISIS_METHODS, variants):
        return "crisis"
    for code in R.BRIEF_FORBIDDEN:
        if code == "third_party_pii":
            if third_party(text, category):
                return code
        elif _hits(R.BLACKLIST[code], variants):
            return code
    return None


def is_sensitive(text: str) -> bool:
    """Чувствительная тема (утрата, развод, долг…): факт ждёт «Запомнить» и в сводку до этого не идёт. Решает код, не модель."""
    return _hits(R.SENSITIVE, forms(text))


def length_reason(category: str, text: str) -> str | None:
    size = len(text.strip())
    if size < R.MIN_TEXT:
        return "too_short"
    if size > R.MAX_TEXT[category]:
        return "too_long"
    return None


# ─── Слоты (MEM-5.2) ──────────────────────────────────────────────────────────

_LINKISH = re.compile(r"[@/\\:]|https?|www|\.(ru|com|рф|org|net)", re.IGNORECASE)
_NAME = re.compile(r"^[А-ЯЁA-Z][а-яёa-z]+(?:-[А-ЯЁA-Z]?[а-яёa-z]+)?$")


def canonical_role(role: str) -> str | None:
    """Роль из словаря в том виде, как она пишется в карточке; None, если такой роли нет."""
    return _ROLES.get(_base(" ".join(role.split())))


def validate_slots(category: str, slots: object) -> tuple[dict[str, str] | None, str | None]:
    """Проверенные слоты (лишние поля отброшены) и код причины отказа. У категорий без слотов — (None, None)."""
    if category not in ("style", "person"):
        return None, None
    if not isinstance(slots, dict):
        return None, "bad_slots"
    clean: dict[str, str] = {}
    if category == "style":
        address = slots.get("address")
        if address is not None:
            if not isinstance(address, str):
                return None, "bad_slots"
            address = " ".join(address.split())
            if address:
                if len(address) > R.STYLE_ADDRESS_MAX or any(ch.isdigit() for ch in address) or _LINKISH.search(address):
                    return None, "bad_slots"
                clean["address"] = address
        for name, allowed in R.STYLE_SLOTS.items():
            value = slots.get(name)
            if value is None:
                continue
            if value not in allowed:
                return None, "bad_slots"
            clean[name] = value
        return (clean, None) if clean else (None, "bad_slots")
    role = slots.get("role")
    if not isinstance(role, str) or (canonical := canonical_role(role)) is None:
        return None, "bad_slots"
    clean["role"] = canonical
    name = slots.get("name")
    if name is not None and name != "":
        if not isinstance(name, str):
            return None, "bad_slots"
        name = name.strip()
        if len(name) > R.PERSON_NAME_MAX or not _NAME.match(name):
            return None, "bad_slots"
        clean["name"] = name
    note = slots.get("note")
    if note is not None and note != "":
        if not isinstance(note, str):
            return None, "bad_slots"
        note = " ".join(note.split()).rstrip(".")
        if len(note) > R.PERSON_NOTE_MAX:
            return None, "bad_slots"
        if note:
            clean["note"] = note
    return clean, None


_STYLE_WORDS = {
    ("form", "ty"): "на «ты»",
    ("form", "vy"): "на «вы»",
    ("length", "short"): "коротко",
    ("length", "normal"): "можно подробно",
    ("advice", "ask_first"): "без советов, пока не попросит",
    ("advice", "ok"): "советы уместны",
    ("tone", "soft"): "мягко",
    ("tone", "direct"): "прямо, без смягчений",
}


def style_phrase(slots: dict[str, str]) -> str:
    """Как говорить с человеком, из слотов шаблоном, а не из текста модели (I10): «зовут Марина; на «ты»; коротко»."""
    parts = []
    if slots.get("address"):
        parts.append(f"зовут {slots['address']}")
    parts.extend(_STYLE_WORDS[(name, slots[name])] for name in ("form", "length", "advice", "tone") if name in slots)
    return "; ".join(parts)


def _capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]


def render_style_text(slots: dict[str, str]) -> str:
    return _capitalize(style_phrase(slots))


def render_person_text(slots: dict[str, str]) -> str:
    """«Сестра Аня: близки, поддерживает»: текст карточки близкого собирается из слотов."""
    text = _capitalize(slots["role"])
    if slots.get("name"):
        text += " " + slots["name"]
    if slots.get("note"):
        text += ": " + slots["note"]
    return text


def render_text(category: str, text: str | None, slots: dict[str, str] | None) -> str:
    if category == "style" and slots:
        return render_style_text(slots)
    if category == "person" and slots:
        return render_person_text(slots)
    return " ".join((text or "").split())


# ─── Опора на реплики человека (MEM-7.5 п.5) ──────────────────────────────────

_WORD = re.compile(r"[а-яa-z]+")
_STOP = frozenset(_base(word) for word in R.STOPWORDS)  # в той же форме, что токены (повторы букв схлопнуты)


def _stem(token: str) -> str:
    """Первые 6 знаков; у слов короче — без последней буквы (окончание), но не короче трёх: «мама» и «маме» сходятся."""
    return token[: min(R.STEM_CHARS, max(3, len(token) - 1))]


def _stems(text: str, min_len: int) -> list[str]:
    tokens = _WORD.findall(_base(text))
    return [_stem(token) for token in tokens if len(token) >= min_len and token not in _STOP]


def _same(a: str, b: str) -> bool:
    """Одно слово в разных формах: общее начало не короче пяти букв (или всего более короткого стема) — «вечерние» и
    «вечером», «сестра» и «сестрой»."""
    size = min(len(a), len(b), R.GROUND_PREFIX)
    return a[:size] == b[:size]


def grounded(fact_text: str, quoted: Sequence[str]) -> bool:
    """Значимые токены факта встречаются в процитированных репликах человека не меньше чем наполовину."""
    stems = _stems(fact_text, R.MIN_TOKEN) or _stems(fact_text, 3)
    if not stems:
        return False
    pool = {stem for text in quoted for stem in _stems(text, 3)}
    found = sum(1 for stem in stems if any(_same(stem, other) for other in pool))
    return found / len(stems) >= R.GROUNDED_SHARE


# ─── Дубли и надгробия (MEM-7.6) ──────────────────────────────────────────────


def norm_hash(text: str) -> str:
    """SHA-256 от нормализованного текста: без знаков и стоп-слов, токены от 4 знаков обрезаны до 6, отсортированы."""
    tokens = [token for token in re.findall(r"[а-яa-z0-9]+", _base(text)) if token not in _STOP]
    stems = sorted(token[: R.STEM_CHARS] if len(token) >= R.MIN_TOKEN else token for token in tokens)
    return hashlib.sha256(" ".join(stems).encode()).hexdigest()


def _trigrams(text: str) -> set[str]:
    clean = " " + " ".join(re.findall(r"[а-яa-z0-9]+", _base(text))) + " "
    return {clean[i : i + 3] for i in range(len(clean) - 2)}


def similarity(a: str, b: str) -> float:
    """Сходство символьных триграмм (доля общих среди всех)."""
    left, right = _trigrams(a), _trigrams(b)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


# ─── Явные просьбы и даты ─────────────────────────────────────────────────────

_EXPLICIT = re.compile(R.EXPLICIT_REQUEST_RE)


def explicit_request(text: str) -> bool:
    """«Запомни…», «Рядом, не забудь…»: в начале реплики, после обращения или после конца предложения (MEM-7.2)."""
    return bool(_EXPLICIT.search(_base(text)))


_DATE_NUMERIC = re.compile(r"(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?!\d)")
_DATE_WORDS = re.compile(r"(?<!\d)(\d{1,2})\s+(" + "|".join(R.MONTHS) + r")(?:\s+(\d{4}))?")


def goal_date(text: str, now: datetime) -> datetime | None:
    """Дата в тексте цели («20 октября», «20.10»): цель живёт до неё + 7 дней. Прошедшая в этом году — значит в следующем."""
    lower = _base(text)
    found = _DATE_WORDS.search(lower)
    if found:
        day, month, year = int(found.group(1)), R.MONTHS[found.group(2)], found.group(3)
    else:
        found = _DATE_NUMERIC.search(lower)
        if not found:
            return None
        day, month, year = int(found.group(1)), int(found.group(2)), found.group(3)
    try:
        if year:
            full_year = int(year) + (2000 if len(year) == 2 else 0)
            return now.replace(year=full_year, month=month, day=day, hour=23, minute=59, second=0, microsecond=0)
        date = now.replace(month=month, day=day, hour=23, minute=59, second=0, microsecond=0)
    except ValueError:
        return None
    if date < now - timedelta(days=1):
        date = date.replace(year=date.year + 1)
    return date
