"""Бюджет входных токенов Gemini Live в минуту (TPM): учёт и пауза после превышения квоты.

У проекта Google один лимит на всех: 400 000 входных токенов в минуту (Tier 2), отдельных лимитов на запросы и сессии нет.
Сверх лимита Google закрывает соединение кодом 1011 «You exceeded your current quota» и при открытии сессии, и посреди
хода. Агент сам не видел свой расход, после 1011 тут же пробовал снова, а отказы ложились случайно на все разговоры.

Как Google считает Live в TPM (эксперимент на gemini-3.8-live, Tier 2, график AI Studio «Peak input tokens per minute»):
  - открытие сессии с историей считается сразу, без единого хода, и щедрее настоящих токенов: история 40 сообщений
    (≈80 тыс. знаков кириллицы, по usage 24 213 токенов) — ≈37 тыс. на открытие. Это сходится с оценкой «байты UTF-8 / 4»
    (кириллица — 2 байта на знак). usage при открытии не приходит;
  - ход в открытой сессии почти ничего не добавил сверх открытия (сессия + короткий ход ≈35 тыс., а не 37 + 24 тыс.);
  - на каждый ход Google добавляет постоянные 156 токенов (prompt_audio = 156 даже без звука).

Модель учёта (`TokenBudget`, один на процесс; в k8s одна реплика агента), скользящее окно 60 секунд:
  - открытие: резерв `estimate_open` = байты UTF-8 (системная инструкция + история) / 4 × `GEMINI_TPM_OPEN_FACTOR` ставится
    до подключения и становится фактом, когда сессия открылась (не открылась — снимается). Эта же сумма — «учтённый
    контекст» сессии;
  - ход: резерв `estimate_turn` = 156 + новый ввод (текст: байты / 4, голос: 32 токена в секунду) ставится до того, как
    модель начнёт отвечать. Когда приходит usage хода, в окно ложится max(резерв, prompt_token_count − учтённый контекст
    сессии), а учтённый контекст растёт на эту сумму: факт поднимает учёт, только если контекст вырос больше, чем мы уже
    посчитали за открытие и прошлые ходы, и открытие не учитывается дважды;
  - резерв без факта (ход оборван, usage не пришёл) живёт в окне 60 секунд, как если бы токены списались при отправке;
  - открытие не считается (`GEMINI_TPM_OPEN_FACTOR=0`): тогда ход оплачивает весь контекст сессии. Резерв хода = prompt_all
    прошлого хода + надбавка (пока ходов не было — 2 500), а факт ложится в окно целиком (учтённый контекст сессии 0).

Резервы: `reserve` (id), `settle` (заменить фактом), `cancel` (снять, ход не состоялся).

Окно только измеряется: метрики `agent_gemini_tpm_window_tokens` и `agent_gemini_tpm_limit_tokens` сравнивают с графиком
AI Studio. Поведение разговоров оно не меняет: новые разговоры не отсекаются, история не сокращается, ход не получает отказ.
Единственное, что агент делает сам, — пауза после 1011 (`cooling`): новые сессии Gemini не открываются
`GEMINI_QUOTA_COOLDOWN_SECONDS` (5 с, растёт вдвое до 60 с, сбрасывается после удачных ходов), потому что открытие заведомо
получило бы тот же отказ. `GEMINI_QUOTA_COOLDOWN_SECONDS=0` выключает и паузу.

`GEMINI_TPM_LIMIT=0` выключает учёт: методы ничего не делают.

Часы подставляются (`clock`): тесты гоняют окно и паузы без настоящего ожидания.
"""

import logging
import math
import time
import weakref
from collections import deque
from collections.abc import Callable, Iterable

from app.core.config import GeminiSettings
from app.core.metrics import GEMINI_QUOTA_ERRORS_TOTAL, GEMINI_TPM_LIMIT_TOKENS, GEMINI_TPM_WINDOW_TOKENS

logger = logging.getLogger("agent.budget")

WINDOW_SECONDS = 60.0
# Текст во входных токенах по счёту квоты Google: байты UTF-8 / 4 (эксперимент: 80 тыс. знаков кириллицы ≈ 37 тыс.).
BYTES_PER_TOKEN = 4
# Постоянная надбавка Google на каждый ход (prompt_audio = 156 даже в сессии без звука).
TURN_OVERHEAD_TOKENS = 156
# Звук реплики во входных токенах: около 32 токенов в секунду (на стенде ~300 токенов за реплику в 8-10 с).
AUDIO_TOKENS_PER_SECOND = 32
PCM_BYTES_PER_SECOND = 16_000 * 2  # голос человека: PCM16, 16 кГц, моно
# Пауза после 1011 растёт вдвое с каждой новой ошибкой (5 → 10 → 20 → 40 → 60 с) и сбрасывается после стольких удачных ходов.
COOLDOWN_MAX_SECONDS = 60.0
COOLDOWN_RESET_TURNS = 3
# Резерв хода, когда открытие не считается (GEMINI_TPM_OPEN_FACTOR=0) и прошлого хода с prompt_all ещё не было.
DEFAULT_TURN_TOKENS = 2500


def text_tokens(text: str) -> int:
    """Текст в токенах по счёту квоты: байты UTF-8 / 4, с округлением вверх."""
    return math.ceil(len(text.encode("utf-8")) / BYTES_PER_TOKEN)


def estimate_open(texts: Iterable[str], factor: float = 1.0) -> int:
    """Сколько квоты съест открытие сессии: системная инструкция и загруженная история, байты / 4 × коэффициент."""
    if factor <= 0:
        return 0
    return math.ceil(sum(len(text.encode("utf-8")) for text in texts) / BYTES_PER_TOKEN * factor)


def estimate_turn(text: str | None = None, audio_seconds: float | None = None, carried: int = 0) -> int:
    """Новый ввод хода: надбавка Google, набранный текст или звук реплики, и `carried` — то, что легло в контекст сессии
    после прошлого хода на ней же (ответ модели), если сессия не свежая."""
    tokens = TURN_OVERHEAD_TOKENS + max(0, carried)
    if text:
        tokens += text_tokens(text)
    if audio_seconds:
        tokens += math.ceil(audio_seconds * AUDIO_TOKENS_PER_SECOND)
    return tokens


class TokenBudget:
    def __init__(
        self,
        settings: GeminiSettings,
        clock: Callable[[], float] = time.monotonic,
        metrics: bool = True,
    ) -> None:
        self._limit = settings.tpm_limit
        self.enabled = settings.tpm_limit > 0
        self._cooldown_base = settings.quota_cooldown_seconds
        self._open_factor = settings.tpm_open_factor
        self._clock = clock
        self._spent: deque[tuple[float, int]] = deque()  # (когда, токенов) за последние 60 с
        self._spent_total = 0
        self._reserved: dict[int, tuple[float, int]] = {}  # id → (когда, оценка)
        self._next_id = 1
        # Учтённый контекст каждой открытой сессии: оценка открытия плюс засчитанные ходы (ключ — сама сессия).
        self._counted: weakref.WeakKeyDictionary[object, int] = weakref.WeakKeyDictionary()
        self._cooldown_until = 0.0
        self._step = 0  # сколько раз подряд Google отказал по квоте (растёт пауза)
        self._good = 0  # удачных ходов после последней паузы
        if self.enabled and metrics:
            # Метрики окна считаются в момент опроса Prometheus: окно сползает и без новых ходов.
            GEMINI_TPM_WINDOW_TOKENS.set_function(self.window_tokens)
            GEMINI_TPM_LIMIT_TOKENS.set_function(self.limit)

    @classmethod
    def disabled(cls) -> "TokenBudget":
        """Бюджет, который ничего не считает: сессии, созданные без приложения (тесты внутренних шагов)."""
        return cls(GeminiSettings.model_validate({"GEMINI_TPM_LIMIT": 0}))

    # ─── окно ─────────────────────────────────────────────────────────────────

    def _prune(self) -> float:
        now = self._clock()
        edge = now - WINDOW_SECONDS
        while self._spent and self._spent[0][0] <= edge:
            self._spent_total -= self._spent.popleft()[1]
        for rid in [rid for rid, (at, _) in self._reserved.items() if at <= edge]:
            del self._reserved[rid]  # факт так и не пришёл: оценка отслужила своё в окне
        return now

    def window_tokens(self) -> int:
        """Засчитанные входные токены за последние 60 секунд (то, что считает Google), без резервов."""
        if not self.enabled:
            return 0
        self._prune()
        return self._spent_total

    def reserved_tokens(self) -> int:
        if not self.enabled:
            return 0
        self._prune()
        return sum(tokens for _, tokens in self._reserved.values())

    def limit(self) -> int:
        """Настроенный лимит (`GEMINI_TPM_LIMIT`): с ним сравнивают окно."""
        return self._limit

    def reserve(self, estimate: int) -> int | None:
        """Поставить оценку в окно до отправки. Возвращает id резерва (None, если учёт выключен)."""
        if not self.enabled:
            return None
        now = self._prune()
        rid = self._next_id
        self._next_id += 1
        self._reserved[rid] = (now, max(0, int(estimate)))
        return rid

    def reserved(self, rid: int | None) -> int:
        """Сколько стоит в резерве `rid` (0, если его нет)."""
        entry = self._reserved.get(rid) if rid is not None else None
        return entry[1] if entry is not None else 0

    def cancel(self, rid: int | None) -> None:
        """Ход или открытие не состоялись: резерв снимается, токены не списаны."""
        if rid is not None:
            self._reserved.pop(rid, None)

    def settle(self, rid: int | None, actual: int) -> None:
        """Резерв заменяется фактом. Без резерва факт просто ложится в окно."""
        if not self.enabled:
            return
        self.cancel(rid)
        now = self._prune()
        if actual > 0:
            self._spent.append((now, int(actual)))
            self._spent_total += int(actual)

    def charge(self, tokens: int) -> None:
        """Токены вне хода: сразу в окно."""
        self.settle(None, tokens)

    # ─── открытие сессии и ход ────────────────────────────────────────────────

    @property
    def counts_open(self) -> bool:
        """Открытия сессий учитываются (`GEMINI_TPM_OPEN_FACTOR` > 0); иначе каждый ход платит за весь свой контекст."""
        return self._open_factor > 0

    def counted(self, session: object) -> int:
        """Учтённый контекст сессии: оценка её открытия и засчитанные с тех пор ходы."""
        return self._counted.get(session, 0) if session is not None else 0

    def open_estimate(self, texts: Iterable[str]) -> int:
        """Оценка открытия сессии с этим контекстом (0, если учёт выключен или GEMINI_TPM_OPEN_FACTOR=0)."""
        return estimate_open(texts, self._open_factor) if self.enabled else 0

    def opening(self, cost: int) -> int | None:
        """Открытие начато: его оценка в резерве, пока сессия не открылась (Google считает его при подключении)."""
        return self.reserve(cost) if self.enabled and cost > 0 else None

    def opened(self, session: object, rid: int | None) -> None:
        """Сессия открылась: оценка открытия — факт в окне и учтённый контекст сессии."""
        if not self.enabled:
            return
        cost = self.reserved(rid)
        self.settle(rid, cost)
        if session is not None:
            self._counted[session] = cost

    def settle_turn(self, session: object, rid: int | None, prompt: int) -> int:
        """Пришёл usage хода: в окно ложится max(резерв хода, prompt − учтённый контекст сессии). Возвращает засчитанное."""
        if not self.enabled:
            return 0
        estimate = self.reserved(rid)
        counted = self.counted(session)
        charge = max(estimate, prompt - counted)
        if session is not None:
            self._counted[session] = counted + charge
        self.settle(rid, charge)
        if prompt > 0 and not self.cooling():
            self._good += 1
            if self._good >= COOLDOWN_RESET_TURNS:
                self._step = 0  # Google снова отвечает: следующая пауза опять начнётся с начальной
        return charge

    # ─── пауза после отказа Google по квоте ───────────────────────────────────

    def cooling(self) -> bool:
        """Идёт пауза после 1011: новые сессии Gemini не открываются."""
        return self.enabled and self._clock() < self._cooldown_until

    def cooldown_left(self) -> float:
        return max(0.0, self._cooldown_until - self._clock()) if self.enabled else 0.0

    def on_quota_error(self, where: str, dialog: str | None = None) -> None:
        """Google отказал по квоте (1011). `where`: open | session | tts.

        Пауза растёт вдвое с каждой новой ошибкой после конца прошлой паузы; ошибки во время паузы (их много разом: отказ
        приходит всем идущим разговорам) её не продлевают.
        """
        GEMINI_QUOTA_ERRORS_TOTAL.labels(where).inc()
        if not self.enabled:
            return
        window, reserved = self.window_tokens(), self.reserved_tokens()
        if self.cooling():
            logger.info("gemini quota error during cooldown where=%s dialog=%s window=%d", where, dialog, window)
            return
        self._step += 1
        self._good = 0
        seconds = 0.0
        if self._cooldown_base > 0:
            seconds = min(COOLDOWN_MAX_SECONDS, self._cooldown_base * 2 ** (self._step - 1))
            self._cooldown_until = self._clock() + seconds
        logger.warning(
            "gemini quota exceeded where=%s dialog=%s window=%d reserved=%d limit=%d cooldown_s=%.1f step=%d",
            where,
            dialog,
            window,
            reserved,
            self.limit(),
            seconds,
            self._step,
        )
