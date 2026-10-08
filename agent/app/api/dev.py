"""Dev-эндпоинты озвучки. Не входят в контракт agent-api.

`GET /dev/tts?text=Привет` отдаёт WAV (24 кГц, PCM16): послушать голос агента можно без приложения.
`GET /dev/tts` без текста показывает режим озвучки; `POST /dev/tts {"mode": "auto" | "none"}` переключает его на
лету (`none` ведёт себя как агент с отказавшей озвучкой: ответы приходят текстом, а клиент читает их сам).
Тот же переключатель есть у `dev/agent-mock`, поэтому e2e-тесты приложения работают с обоими агентами.
Всё под тем же внутренним токеном, что и /v1.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel

from app.api.deps import active_tts, get_tts, require_token
from app.clients.speech import TextToSpeech, TtsError, Voice, pcm_to_wav
from app.core.errors import AgentError
from app.services.replies import split_sentences

router = APIRouter(dependencies=[Depends(require_token)])


class SpeechMode(BaseModel):
    mode: Literal["auto", "none"]


def _status(request: Request) -> dict[str, str | None]:
    configured = request.app.state.tts
    effective = active_tts(request.app)
    return {
        "mode": request.app.state.tts_mode,
        "provider": configured.name if configured else None,
        "effective": effective.name if effective else None,
    }


@router.get("/dev/tts", response_model=None)
async def say(
    request: Request,
    tts: Annotated[TextToSpeech | None, Depends(get_tts)],
    text: Annotated[str | None, Query(min_length=1, max_length=500)] = None,
    voice: Voice = "male",
) -> Response | dict[str, str | None]:
    if text is None:
        return _status(request)
    if tts is None:
        raise AgentError(503, "VOICE_UNAVAILABLE", "Озвучка не настроена или выключена: нет ключа SaluteSpeech и espeak-ng")
    try:
        pcm = b"".join([await tts.synthesize(sentence, voice) for sentence in split_sentences(text) or [text]])
    except TtsError as error:
        raise AgentError(503, "VOICE_UNAVAILABLE", str(error)) from error
    return Response(pcm_to_wav(pcm), media_type="audio/wav", headers={"X-Tts-Provider": tts.name})


@router.post("/dev/tts")
async def set_speech_mode(body: SpeechMode, request: Request) -> dict[str, str | None]:
    request.app.state.tts_mode = body.mode
    return _status(request)
