"""Итоги недели (add-mood-diary, D6): `POST /v1/users/{userId}/digests`.

Агент пишет текст по кодам отметок и ничего не хранит: ни запрос, ни ответ. Тела запроса и ответа в журнал не попадают.
"""

import datetime
import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.deps import canonical_user_id, require_token
from app.clients.background_model import BackgroundModel, ModelError
from app.core.errors import AgentError, validation_error
from app.core.tracing import NullTracer
from app.prompts.provider import PromptUnavailable, prompt_metadata
from app.services import digests

logger = logging.getLogger("agent.digests")

router = APIRouter(prefix="/v1/users/{user_id}/digests", dependencies=[Depends(require_token)])

MAX_MARKS = 7
MAX_RECAPS = 100
ATTEMPTS = 2  # ответ, не прошедший проверку, просим один раз повторить


def _date(value: str) -> str:
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise ValueError("дата должна быть YYYY-MM-DD") from error


class Mark(BaseModel):
    model_config = ConfigDict(extra="ignore")

    date: str
    mood: int = Field(ge=1, le=5)
    factor: Literal["work", "people", "health", "money", "sleep"] | None = None

    _date = field_validator("date")(_date)


class WeekRecap(BaseModel):
    """Итог разговора недели (add-mood-diary, D13): свободный текст, второй вход текста недели. Не хранится и в журнал не пишется."""

    model_config = ConfigDict(extra="ignore")

    date: str
    text: str = Field(min_length=1, max_length=500)

    _date = field_validator("date")(_date)


class DigestBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["week"]
    period_start: str = Field(alias="periodStart")
    marks: list[Mark] = Field(max_length=MAX_MARKS)
    recaps: list[WeekRecap] = Field(default_factory=list, max_length=MAX_RECAPS)

    _period = field_validator("period_start")(_date)


@router.post("")
async def create_digest(user_id: str, body: DigestBody, request: Request) -> dict[str, object]:
    if canonical_user_id(user_id) is None:
        raise validation_error("userId должен быть UUID")
    marks = [m.model_dump() for m in body.marks]
    recaps = [r.model_dump() for r in body.recaps]
    stats = digests.stats_of(marks)

    model: BackgroundModel | None = request.app.state.background
    if model is None:
        # Запасного текста нет: итоги недели пишет только модель.
        raise AgentError(502, "DIGEST_UNAVAILABLE", "Модели нет, итоги не написаны")
    # Тексты, написанные человеком или о нём (итоги разговоров), дословно в итог не берём.
    sources = [r["text"] for r in recaps]
    provider = request.app.state.prompt_provider
    hard_week = stats["hardDays"] >= digests.HARD_WEEK_DAYS
    try:
        system = provider.resolve("agent.digest.weekly.system")
        components = [system]
        hard_suffix = ""
        if hard_week:
            hard_prompt = provider.resolve("agent.digest.weekly.hard-week-suffix")
            hard_suffix = hard_prompt.text
            components.append(hard_prompt)
        marks_text = "\n".join(
            f"{m['date']}: {m['mood']}" + (f", фактор: {digests.FACTORS[m['factor']]}" if m.get("factor") else "")
            for m in marks
        )
        recap_block = ""
        if recaps:
            recap_block = "\nИтоги разговоров недели, без привязки к дням (написаны для самого человека):\n" + "\n".join(
                f"- {r['text']}" for r in recaps
            )
        task = provider.resolve(
            "agent.digest.weekly.task",
            period_start=body.period_start,
            sentence_min=digests.WEEK_SENTENCES[0],
            sentence_max=digests.WEEK_SENTENCES[1],
            hard_week_instruction=hard_suffix,
            marks=marks_text,
            recap_block=recap_block,
        )
        components.append(task)
    except PromptUnavailable as error:
        raise AgentError(502, "DIGEST_UNAVAILABLE", "Промпт итогов недоступен") from error
    messages = digests.build_messages(body.kind, body.period_start, marks, recaps, system=system, task=task)
    tracer = request.app.state.tracer or NullTracer()
    trace = tracer.start_turn(
        name="weekly_digest",
        session_id="digest",
        user_id=user_id,
        model=model.name,
        input=messages,
        metadata={"operation": "weekly_digest", **prompt_metadata(system)},
        prompt=system.prompt,
        prompt_components=[component.metadata for component in components],
        tags=["background", "digest"],
    )
    text: str | None = None
    try:
        for attempt in range(1, ATTEMPTS + 1):
            try:
                reply = await model.complete(messages)
                trace.update(output=reply)
            except ModelError as error:
                logger.warning("digest model failed kind=%s", body.kind, exc_info=False)
                trace.update(level="WARNING", status="модель не ответила")
                raise AgentError(502, "DIGEST_UNAVAILABLE", "Модель не написала итоги") from error
            text = digests.clean_digest(body.kind, reply, marks, source_texts=sources)
            if text is not None:
                break
            logger.info("digest rejected by the validator kind=%s attempt=%d", body.kind, attempt)
        if text is None:
            trace.update(level="WARNING", status="ответ не прошёл проверку")
            raise AgentError(502, "DIGEST_UNAVAILABLE", "Ответ модели не прошёл проверку")
        logger.info("digest kind=%s marks=%d chars=%d", body.kind, len(marks), len(text))
        return {"text": text, "stats": stats}
    finally:
        trace.end()
