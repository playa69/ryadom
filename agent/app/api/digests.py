"""Итоги недели (add-mood-diary, D6): `POST /v1/users/{userId}/digests`.

Агент пишет текст по кодам отметок и ничего не хранит: ни запрос, ни ответ. Тела запроса и ответа в журнал не попадают.
"""

import datetime
import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.deps import canonical_user_id, require_token
from app.clients.llm import ChatModel, ModelError
from app.core.errors import AgentError, validation_error
from app.services import digests

logger = logging.getLogger("agent.digests")

router = APIRouter(prefix="/v1/users/{user_id}/digests", dependencies=[Depends(require_token)])

MAX_MARKS = 7
MAX_RECAPS = 20


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
    """Итог разговора недели (add-mood-diary, D13): второй вход текста недели. Не хранится и в журнал не пишется."""

    model_config = ConfigDict(extra="ignore")

    date: str
    about: str = Field(max_length=600)
    main: str = Field(max_length=600)
    agreements: list[str] = Field(default_factory=list, max_length=3)

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

    chat: ChatModel | None = request.app.state.chat
    text: str | None = None
    if chat is not None:
        try:
            reply = await chat.complete(digests.build_messages(body.kind, body.period_start, marks, recaps))
        except ModelError as error:
            # Текст ошибки может нести кусок ответа модели, поэтому в журнал идёт только факт.
            logger.warning("digest model failed kind=%s", body.kind, exc_info=False)
            raise AgentError(502, "DIGEST_UNAVAILABLE", "Модель не написала итоги") from error
        # Тексты, написанные человеком или о нём (итоги разговоров), дословно в итог не берём.
        sources = [" ".join([r["about"], r["main"], *r["agreements"]]) for r in recaps]
        text = digests.clean_digest(body.kind, reply, marks, source_texts=sources)
        if text is None:
            logger.info("digest rejected by the validator kind=%s", body.kind)
    if text is None:
        text = digests.template_digest(body.kind, marks, recaps)
    logger.info("digest kind=%s marks=%d chars=%d", body.kind, len(marks), len(text))
    return {"text": text, "stats": stats}
