"""Итоги недели по отметкам настроения и итогам разговоров (add-mood-diary, D6): текст пишет модель, агент ничего не хранит.

В модель уходят коды отметок (уровень 1–5, фактор) и тексты итогов разговоров недели, без имени и почты. Запрос и ответ
не пишутся в журнал. Итог недели — характеристика в свободной форме о том, что было в разговорах и как двигалась неделя, а не
перечень цифр. Ответ модели проверяется (`clean_digest`); если в нём «надо», среднее число, счёт дней подряд, дословная цитата
из итогов или он не укладывается в длину, вместо него возвращается шаблонный текст — так же отвечает режим `LLM_MODE=template`.
"""


import re
from collections import Counter
from typing import Any, Literal

LEVELS = {1: "тяжело", 2: "так себе", 3: "нормально", 4: "хорошо", 5: "отлично"}
FACTORS = {"work": "работа", "people": "близкие", "health": "здоровье", "money": "деньги", "sleep": "сон"}

# Неделя: 3–6 предложений.
WEEK_SENTENCES = (3, 6)
HARD_WEEK_DAYS = 3

PEOPLE_LINE = "Если сейчас непросто, рядом могут быть люди, с которыми можно поговорить, и я тоже здесь."

SYSTEM_PROMPT = (
    "Ты — Рядом, тёплый голосовой спутник для эмоциональной поддержки. Напиши человеку итоги недели: связный текст в свободной "
    "форме, характеристику недели, а не перечень. Опирайся на содержание его разговоров и итогов этих разговоров: о чём он думал, "
    "что оказалось для него важным, как менялось настроение за неделю. Не перечисляй статистику: ни числа дней, ни число разговоров, "
    "ни «чаще всего». Обращайся на «ты». Не оценивай человека, не ставь диагнозов, не давай советов со словом «надо» и «должен», "
    "не считай дни подряд, не называй средний балл числом. Не цитируй слова человека и тексты итогов ни в кавычках, ни дословно: "
    "только своими словами. Пиши спокойно и бережно, без восклицательных знаков и без эмодзи. "
    "Уровни: 1 — тяжело, 2 — так себе, 3 — нормально, 4 — хорошо, 5 — отлично."
)

_FORBIDDEN = re.compile(r"\b(надо|должен|должна|нужно)\b", re.IGNORECASE)
_AVERAGE = re.compile(r"средн\w*\s+(балл|оценк|значени|уровен)|\d+[.,]\d+\s*(из|/)\s*5|\b\d+\s*/\s*5\b", re.IGNORECASE)
_STREAK = re.compile(r"\b(подряд|серия|серию|серии|без пропусков)\b", re.IGNORECASE)
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


def _top_factor(marks: list[dict[str, Any]]) -> str | None:
    factors = Counter(m["factor"] for m in marks if m.get("factor"))
    return FACTORS.get(factors.most_common(1)[0][0]) if factors else None


def _trend(marks: list[dict[str, Any]]) -> str | None:
    """Как двигалось настроение: вторая половина отметок против первой; None, если отметок мало."""
    ordered = sorted(marks, key=lambda m: m["date"])
    if len(ordered) < 4:
        return None
    half = len(ordered) // 2
    first = sum(m["mood"] for m in ordered[:half]) / half
    last = sum(m["mood"] for m in ordered[-half:]) / half
    if last - first >= 0.5:
        return "К концу недели стало заметно легче."
    if first - last >= 0.5:
        return "К концу недели стало тяжелее."
    return None


def template_digest(kind: Literal["week"], marks: list[dict[str, Any]], recaps: list[dict[str, Any]] | None = None) -> str:
    """Детерминированный текст без модели: для `LLM_MODE=template` и как запасной вариант при забракованном ответе.

    Собирается из содержания итогов разговоров недели (без счётчиков), а не из цифр отметок."""
    stats = stats_of(marks)
    texts = [" ".join(str(r.get("text", "")).split()) for r in (recaps or [])]
    texts = [t for t in texts if t]
    factor = _top_factor(marks)
    if texts:
        parts = ["На этой неделе в разговорах ты возвращался к важному для себя."]
        parts.extend(t if t.endswith((".", "…", "?")) else f"{t}." for t in texts[:3])
    else:
        parts = ["На этой неделе ты находил минутку, чтобы прислушаться к себе."]
    if factor:
        parts.append(f"Сильнее всего на настроение влияло: {factor}.")
    trend = _trend(marks)
    if trend:
        parts.append(trend)
    if stats["hardDays"] >= HARD_WEEK_DAYS:
        parts.append(PEOPLE_LINE)
    return " ".join(parts)


def build_messages(
    kind: Literal["week"], period_start: str, marks: list[dict[str, Any]], recaps: list[dict[str, Any]] | None = None
) -> list[dict[str, str]]:
    lines = [f"{m['date']}: {m['mood']}" + (f", фактор: {FACTORS[m['factor']]}" if m.get("factor") else "") for m in marks]
    task = (
        f"Итоги недели с {period_start}. Напиши {WEEK_SENTENCES[0]}–{WEEK_SENTENCES[1]} предложений свободным текстом: "
        "что происходило в его жизни и разговорах на этой неделе и как менялось настроение. Опирайся на итоги разговоров, "
        "отметки нужны для динамики. Без цифр, без среднего балла, без цитат: только своими словами."
    )
    if stats_of(marks)["hardDays"] >= HARD_WEEK_DAYS:
        task += " Закончи мягкой строкой про людей рядом."
    body = task + "\nОтметки по дням:\n" + "\n".join(lines)
    if recaps:
        body += "\nИтоги разговоров недели (написаны для самого человека):\n" + "\n".join(f"{r['date']}: {r['text']}" for r in recaps)
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": body}]


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
    if not text or _FORBIDDEN.search(text) or _AVERAGE.search(text) or _STREAK.search(text):
        return None
    if has_quotation(text, source_texts):
        return None
    count = sentence_count(text)
    low, high = WEEK_SENTENCES
    if count < low or count > high:
        return None
    if stats_of(marks)["hardDays"] >= HARD_WEEK_DAYS and not re.search(r"рядом|близк|люд", text, re.IGNORECASE):
        text = f"{text} {PEOPLE_LINE}"
        if sentence_count(text) > WEEK_SENTENCES[1]:
            return None
    return text
