"""Общие фикстуры тестов agent."""

import os

# Обязательные env для импорта APP_CONFIG до сбора тестов (fail-fast конфиг).
os.environ.setdefault("LLM_API_KEY", "test-llm-key")
os.environ.setdefault("LLM_CHAT_MODEL", "test-chat-model")
os.environ.setdefault("LLM_CLASSIFIER_MODEL", "test-classifier-model")
os.environ.setdefault("LLM_EMBEDDING_MODEL", "test-embedding-model")
os.environ.setdefault("SALUTE_SPEECH_AUTH_KEY", "test-salute-key")
os.environ.setdefault("PG_PASSWORD", "test-pg-password")
os.environ.setdefault("AGENT_INTERNAL_TOKEN", "test-internal-token")
os.environ.setdefault("LANGFUSE_PUBLIC_KEY", "test-lf-public")
os.environ.setdefault("LANGFUSE_SECRET_KEY", "test-lf-secret")
