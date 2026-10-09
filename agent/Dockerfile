# syntax=docker/dockerfile:1
# Упрощённый агент. Сборка из каталога agent/:
#   docker build -t ryadom-agent .
#   docker run --rm -p 8001:8001 -e AGENT_INTERNAL_TOKEN=<токен> -e TTS_MODE=espeak ryadom-agent
FROM python:3.12-slim

# espeak-ng: запасной голос, пока у агента нет ключа SaluteSpeech.
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /srv/agent
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/srv/agent/.venv/bin:$PATH"

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin agent
USER agent

EXPOSE 8001
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=2).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
