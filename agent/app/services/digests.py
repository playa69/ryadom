"""Итоги недели по отметкам настроения и итогам разговоров (add-mood-diary, D6): текст пишет модель, агент ничего не хранит.

В модель уходят коды отметок (уровень 1–5, фактор) и тексты итогов разговоров недели, без имени и почты. Запрос и ответ
не пишутся в журнал. Итог недели — характеристика в свободной форме о том, что было в разговорах и как двигалась неделя, а не
перечень цифр. Ответ модели проверяется (`clean_digest`); если в нём «надо», среднее число, счёт дней подряд, привязка к дню или разговору, дословная цитата
из итогов или он не укладывается в длину, модель просят ещё раз; не вышло — текста недели нет (ответ `DIGEST_UNAVAILABLE`).
Запасного текста без модели нет: итоги недели пишет только модель.
"""


import re
from collections import Counter
from typing import Any, Literal

LEVELS = {1: "тяжело", 2: "так себе", 3: "нормально", 4: "хорошо", 5: "отлично"}
FACTORS = {"work": "работа", "people": "близкие", "health": "здоровье", "money": "деньги", "sleep": "сон"}

# Неделя: 3–6 предложений.
WEEK_SENTENCES = (3, 6)
HARD_WEEK_DAYS = 3

from app.prompts.provider import ResolvedPrompt

_FORBIDDEN = re.compile(r"\b(надо|должен|должна|нужно)\b", re.IGNORECASE)
_AVERAGE = re.compile(r"средн\w*\s+(балл|оценк|значени|уровен)|\d+[.,]\d+\s*(из|/)\s*5|\b\d+\s*/\s*5\b", re.IGNORECASE)
_STREAK = re.compile(r"\b(подряд|серия|серию|серии|без пропусков)\b", re.IGNORECASE)
# Привязка к отдельному дню или разговору: итог недели — общий обзор.
_SPECIFIC = re.compile(
    r"\b(в|во)\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\b|\bв\s+(одном|первом|последнем|другом)\s+из\s+разговоров\b",
    re.IGNORECASE,
)
_SENTENCE_END = re.compile(r"[.!?…]+(?:\s+|$)")
# Слова в кавычках: «…», "…", „…“, “…”. Одно-два слова в кавычках (названия уровней, тем) допустимы, длиннее — цитата.
_QUOTED = re.compile(r"«([^»]*)»|\"([^\"]*)\"|„([^“”\"]*)[“”\"]|“([^”]*)”")
_WORDS = re.compile(r"\w+", re.UNICODE)
QUOTE_MAX_WORDS = 2
VERBATIM_WORDS = 6


def stats_of(marks: list[dict[str, Any]]) -> dict[str, Any]:
    """Сводка для приложения: сколько дней отмечено, сколько «тяжело», самый частый уровень (при равенстве — выше)."""
    counts = Counter(m["mood"] for m in marks)
    most = max(counts, key=lambda level: (counts[level], level)) if counts else None
    return {"markedDays": len(marks), "hardDays": counts.get(1, 0), "mostFrequent": most}


def sentence_count(text: str) -> int:
    return len([part for part in _SENTENCE_END.split(text.strip()) if part.strip()])


def build_messages(
    kind: Literal["week"],
    period_start: str,
    marks: list[dict[str, Any]],
    recaps: list[dict[str, Any]] | None = None,
    *,
    system: ResolvedPrompt,
    task: ResolvedPrompt,
) -> list[dict[str, str]]:
    """Собирает сообщения из уже скомпилированных инструкций Langfuse."""
    del kind, period_start, marks
    return [{"role": "system", "content": system.text}, {"role": "user", "content": task.text}]


def has_quotation(text: str, source_texts: list[str] | None = None) -> bool:
    """Есть ли в тексте цитата: слова в кавычках длиннее двух слов или шесть слов подряд, взятые дословно из `source_texts`."""
    for match in _QUOTED.finditer(text):
        quoted = next((group for group in match.groups() if group is not None), "")
        if len(_WORDS.findall(quoted)) > QUOTE_MAX_WORDS:
            return True
    if source_texts:
        words = [w.lower() for w in _WORDS.findall(text)]
        grams = {tuple(words[i : i + VERBATIM_WORDS]) for i in range(len(words) - VERBATIM_WORDS + 1)}
        for source in source_texts:
            source_words = [w.lower() for w in _WORDS.findall(source)]
            if any(tuple(source_words[i : i + VERBATIM_WORDS]) in grams for i in range(len(source_words) - VERBATIM_WORDS + 1)):
                return True
    return False


def clean_digest(
    kind: Literal["week"], text: str, marks: list[dict[str, Any]], source_texts: list[str] | None = None
) -> str | None:
    """Ответ модели, если он годится, иначе None (тогда подставляется шаблон)."""
    text = " ".join(text.split())
    if not text or _FORBIDDEN.search(text) or _AVERAGE.search(text) or _STREAK.search(text) or _SPECIFIC.search(text):
        return None
    if has_quotation(text, source_texts):
        return None
    count = sentence_count(text)
    low, high = WEEK_SENTENCES
    if count < low or count > high:
        return None
    if stats_of(marks)["hardDays"] >= HARD_WEEK_DAYS and not re.search(r"рядом|близк|люд", text, re.IGNORECASE):
        return None  # тяжёлая неделя: текст должен закончиться мягкой строкой про людей рядом (её просит промпт)
    return text
