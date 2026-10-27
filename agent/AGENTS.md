# agent/: code rules

General repository rules are in the root `AGENTS.md`. This file is about how the agent code is built (Python 3.12,
FastAPI, uv); running and checks — skill `local-dev`.

## Configuration

- Only `app/core/config.py` reads environment variables; the rest of the code does not use `os.environ` or `os.getenv`.
- Settings are domain classes on `BaseAppSettings` (`DialogSettings`, `GeminiSettings`, `LangfuseSettings` and so on),
  every field is `Field(validation_alias="VARIABLE_NAME", default=…)`; secrets are `SecretStr`.
- A config error stops the start right away (fail-fast): required fields have no default, consistency between values is
  checked by `@model_validator(mode="after")` in the settings class.
- Code takes settings from the `APP_CONFIG` singleton instead of reading env itself. Derived values are `@property` on
  the settings class, not separate variables.
- A new variable — a field in its domain class, a line in `agent/.env.example` and, if production needs it, a key in
  `k8s/agent/00-config.yaml` (a secret goes into a Secret; the repository holds only its name).
- Tests set env in `tests/conftest.py` before importing the app: the config is read at import time.

## Logs

- Standard `logging`: `logger = logging.getLogger("agent.<area>")` in the module; `main.py` sets the format and level
  (`logging.basicConfig`, level from `APP_CONFIG`). Output goes to stdout; in the cluster Loki collects it.
- Turn texts, email addresses, names and other personal data never go into the log: only identifiers (`user_id`,
  `dialog_id`), durations, sizes and counters. The same for Langfuse: texts are not sent there
  (`LANGFUSE_TRACE_TEXT=false`, `app/core/tracing.py`).
- Metrics — Prometheus, `app/core/metrics.py`; names `agent_*`.

## Tracing headers

The api passes five headers to the agent (`x-trace-id`, `x-request-time`, `x-client-id`, `x-session-id`, `x-user-id`),
but the agent currently neither reads nor logs them. Services are linked by `user_id` and `dialog_id` from the request
path.

## Other

- Comments and docstrings — in Russian, about reasons, not retelling the code.
- Tests — pytest without network or models: fakes for models, speech synthesis and the database are in
  `tests/conftest.py` and `tests/fake_db.py`.
