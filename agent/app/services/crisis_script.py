"""Кризисная ветка (PROTEUS-279, openspec/changes/extend-crisis-branch): словари, тексты скрипта и автомат шагов.

Здесь нет ввода-вывода и модели: тексты и переходы детерминированы, чтобы в худший момент ответ не зависел от генерации
(CON-TECH-07). Тексты — в одном месте: психолог и юрист (CON-ETH-04) правят их, не трогая логику. Статус — черновик до
их ревью. Имя маскота не выбрано, поэтому фразы без обращения по имени.
"""

import re
from dataclasses import dataclass
from enum import Enum

# Красный уровень: прямые слова о желании умереть, самоповреждении, опасности для жизни. Проверка по подстроке без регистра.
RED_WORDS = (
    "не хочу жить",
    "не хочу больше жить",
    "покончить",
    "убить себя",
    "убью себя",
    "умереть",
    "нет смысла жить",
    "суицид",
    "самоубий",
    "наложить на себя руки",
    "вскрыть вены",
    "повеситься",
    "порезать себя",
    "причинить себе вред",
    "навредить себе",
)

# Жёлтый уровень: безнадёжность без прямых слов.
YELLOW_WORDS = (
    "всё бессмысленно",
    "все бессмысленно",
    "ничего не имеет смысла",
    "устал от всего",
    "устала от всего",
    "никому не нужен",
    "никому не нужна",
    "безнадёжно",
    "безнадежно",
)


def detect(text: str) -> str | None:
    """Уровень по словарю: "red", "yellow" или None."""
    lower = text.lower()
    if any(word in lower for word in RED_WORDS):
        return "red"
    if any(word in lower for word in YELLOW_WORDS):
        return "yellow"
    return None


# ─── тексты ─────────────────────────────────────────────────────────────────

# Текст кадра для листа помощи (экран); совпадает с прежним, чтобы старые клиенты показывали то же.
SCREEN_TEXT = "Если тебе сейчас опасно, позвони по одному из номеров ниже."

STEP1 = (
    "Спасибо, что рассказываешь мне об этом. Мне правда важно, что с тобой происходит. "
    "С тем, что ты сейчас чувствуешь, лучше всего поможет живой человек — тот, кто умеет поддержать именно в такие моменты. "
    "Поговорить с ним можно прямо сейчас, это бесплатно. Нажми кнопку на экране."
)
STEP2_ASK = "Скажи, пожалуйста: ты сейчас в безопасности?"
STEP2_UNSAFE = "Пожалуйста, позвони сейчас 112. Если рядом есть кто-то, позови его. Я никуда не ухожу."
STEP2_SAFE = (
    "Хорошо. Я рядом. Кнопка звонка остаётся на экране — нажми её, когда будешь готов. "
    "Можем пока просто немного поговорить."
)
STEP3_REMINDER = (
    "Я рада, что ты со мной говоришь. И всё же с этим очень важно поговорить с живым человеком. "
    "Кнопка здесь, когда будешь готов."
)
STEP4_RETURN = "Я здесь. Как ты? Получилось поговорить?"
YELLOW_ASK = (
    "Звучит так, будто тебе сейчас очень тяжело. Иногда, когда так тяжело, появляются мысли, что не хочется жить. "
    "У тебя бывают такие мысли?"
)
CALM_BANNER = "Нужна помощь?"

# Сколько секунд после шага 1 ждём нажатия кнопки, прежде чем спросить о безопасности.
HELP_WAIT_SECONDS = 10
# Напоминание о живом человеке — на каждой N-й реплике красной ветки, не на каждой.
REMINDER_EVERY = 4


# Все фразы скрипта, которые озвучивает голос: их озвучка прогревается и кешируется, чтобы звук шёл сразу.
SPOKEN_SCRIPT = (STEP2_ASK, STEP2_UNSAFE, STEP2_SAFE, STEP3_REMINDER, STEP4_RETURN, YELLOW_ASK)


class Stage(str, Enum):
    NONE = "none"
    HELP = "help"
    ASK_SAFE = "ask_safe"
    CALL112 = "call112"
    STAY = "stay"
    CHECK = "check"
    ASK_HOPELESS = "ask_hopeless"
    CALM = "calm"


@dataclass(frozen=True)
class Move:
    """Шаг ветки: что сказать (None — только кадр, ответит модель), что показать и каким кадром."""

    stage: Stage
    level: str  # "crisis" | "concern": как в кадре `safety` для клиента
    say: str | None
    text: str = SCREEN_TEXT
    show_call: bool = False

    def frame(self, source: str) -> dict:
        frame = {"type": "safety", "text": self.text, "level": self.level, "stage": self.stage.value, "source": source}
        if self.show_call:
            frame["showCall"] = True
        return frame


_YES = re.compile(r"^(да|ага|угу|конечно|вроде да|в безопасности|безопасно)\b")
_NO = re.compile(r"^(нет|не в безопасности|небезопасно|опасно|мне опасно)\b")


def parse_answer(text: str) -> str:
    """Ответ на вопрос: "yes", "no" или "unknown". Всё непонятное — "unknown", то есть на безопасной стороне."""
    clean = re.sub(r"[^\w\s]", " ", text.lower().replace("ё", "е")).strip()
    clean = re.sub(r"\s+", " ", clean)
    if clean.startswith("не знаю"):
        return "unknown"
    if _NO.match(clean):
        return "no"
    if _YES.match(clean):
        return "yes"
    return "unknown"


class CrisisFlow:
    """Состояние ветки в одной сессии разговора. Переходы описаны в design.md change'а."""

    def __init__(self) -> None:
        self.stage = Stage.NONE
        self.red_replies = 0  # реплики красной ветки после шага 2: по ним считается напоминание
        self._asked_hopeless = False

    @property
    def red_active(self) -> bool:
        return self.stage in (Stage.HELP, Stage.ASK_SAFE, Stage.CALL112, Stage.STAY)

    @property
    def calm(self) -> bool:
        """Ветка просит спокойный тон: красная в разгаре или жёлтая завершилась «нет»."""
        return self.red_active or self.stage is Stage.CALM

    def _help(self) -> Move:
        self.stage = Stage.HELP
        self.red_replies = 0
        return Move(Stage.HELP, "crisis", STEP1)

    def react(self, level: str | None, text: str) -> Move | None:
        """Реплика человека → шаг ветки или None (обычный ответ модели). `level` — результат детектора ("red" | "yellow")."""
        answer = parse_answer(text)
        if self.stage is Stage.HELP:
            # Ответил, не нажав кнопку: «Я в безопасности» с листа — сразу шаг 2б, иначе спрашиваем о безопасности.
            if answer == "yes" and level != "red":
                return self._safe()
            return self.ask_safe()
        if self.stage is Stage.ASK_SAFE:
            if answer == "yes" and level != "red":
                return self._safe()
            self.stage = Stage.CALL112
            return Move(Stage.CALL112, "crisis", STEP2_UNSAFE, show_call=True)
        if self.stage is Stage.ASK_HOPELESS:
            if answer == "yes":
                return self._help()
            self.stage = Stage.CALM
            if level == "red":
                return self._help()
            return Move(Stage.CALM, "concern", None, text=CALM_BANNER)
        if level == "red":
            if self.red_active:
                return self._listening()
            return self._help()
        if self.red_active:
            return self._listening()
        if level == "yellow" and not self._asked_hopeless and self.stage in (Stage.NONE, Stage.CHECK):
            self._asked_hopeless = True
            self.stage = Stage.ASK_HOPELESS
            return Move(Stage.ASK_HOPELESS, "concern", YELLOW_ASK, text=YELLOW_ASK)
        return None

    def ask_safe(self) -> Move:
        """Шаг 2: человек не нажал кнопку за HELP_WAIT_SECONDS или заговорил."""
        self.stage = Stage.ASK_SAFE
        return Move(Stage.ASK_SAFE, "crisis", STEP2_ASK)

    def _safe(self) -> Move:
        self.stage = Stage.STAY
        self.red_replies = 0
        return Move(Stage.STAY, "crisis", STEP2_SAFE, show_call=True)

    def _listening(self) -> Move | None:
        """Шаг 3: человек продолжает говорить. Раз в REMINDER_EVERY реплик — напоминание вместо ответа модели."""
        self.red_replies += 1
        if self.red_replies % REMINDER_EVERY == 0:
            return Move(self.stage, "crisis", STEP3_REMINDER, show_call=True)
        return None

    def returned(self) -> Move | None:
        """Шаг 4: человек вернулся после звонка. Вне красной ветки возврата нет."""
        if not self.red_active:
            return None
        self.stage = Stage.CHECK
        return Move(Stage.CHECK, "crisis", STEP4_RETURN)
