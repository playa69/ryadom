"""Pydantic-модели настроек приложения, загружаемых из переменных окружения."""

import json
import logging
import ssl
import hashlib
from pathlib import Path
from datetime import datetime, UTC
import os
from logging import DEBUG, INFO
from typing import Any, Literal

from cryptography import x509
from cryptography.hazmat.primitives import serialization

from dotenv import load_dotenv
from pydantic import field_validator, model_validator, ValidationInfo
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, computed_field

# Загружаем .env из корня репозитория независимо от текущей директории
load_dotenv()

logger = logging.getLogger(__name__)


class BaseAppSettings(BaseSettings):
    """Базовый класс для настроек приложения."""

    local: bool = Field(validation_alias="LOCAL", default=False)
    debug: bool = Field(validation_alias="DEBUG", default=False)

    @property
    def protocol(self) -> str:
        """Протокол в зависимости от режима local."""
        return "https" if self.local else "http"


class AppSettings(BaseAppSettings):
    """Настройки приложения."""

    app_host: str = Field(validation_alias="APP_HOST", default="0.0.0.0")
    app_port: int = Field(validation_alias="APP_PORT", default=8080)
    kube_net_name: str = Field(validation_alias="PROJECT_NAME", default="AIGATEWAY")
    app_name: str = Field(validation_alias="APP_NAME", default="usecase-agent")
    timezone: str = Field(validation_alias="TIMEZONE", default="Europe/Moscow")
    default_healthrate_info: float = Field(validation_alias="DEFAULT_HEALTHRATE_INFO", default=0.991)
    default_readyrate_info: float = Field(validation_alias="DEFAULT_READYRATE_INFO", default=0.999)
    cluster_name: str = Field(validation_alias="CLUSTER_NAME", default="")
    pod_name: str = Field(validation_alias="POD_NAME", default="")
    service_name: str = Field(validation_alias="SERVICE_NAME", default="")
    project_name: str = Field(validation_alias="PROJECT_NAME", default="AIGATEWAY")


class LogSettings(BaseAppSettings):
    """Настройки логирования."""

    private_log_file_path: str = Field(validation_alias="LOG_PATH", default=os.getcwd())
    private_log_file_name: str = Field(validation_alias="LOG_FILE_NAME", default="app.log")
    log_rotation: str = Field(validation_alias="LOG_ROTATION", default="10 MB")
    private_metric_file_path: str = Field(validation_alias="METRIC_PATH", default=os.getcwd())
    private_metric_file_name: str = Field(validation_alias="METRIC_FILE_NAME", default="app-metric.log")
    private_audit_file_path: str = Field(validation_alias="AUDIT_LOG_PATH", default=os.getcwd())
    private_audit_file_name: str = Field(validation_alias="AUDIT_LOG_FILE_NAME", default="events.log")
    audit_host_ip: str = Field(validation_alias="HOST_IP", default="127.0.0.1")
    audit_host_uid: str = Field(validation_alias="HOST_UID", default="63bd6cbe-170b-49bf-a65c-3ce967398ccd")

    @field_validator(
        "private_log_file_path",
        "private_metric_file_path",
        "private_audit_file_path",
    )
    @classmethod
    def validate_path(cls, value: str) -> str:
        """Проверяет, что путь к лог-директории существует и является директорией."""
        if not os.path.exists(value):
            raise ValueError(f"Path does not exist: {value}")
        if not os.path.isdir(value):
            raise ValueError(f"Path is not a directory: {value}")
        return value

    @staticmethod
    def get_file_abs_path(path_name: str, file_name: str) -> str:
        """Формирует абсолютный путь до файла."""
        return os.path.join(path_name.strip(), file_name.lstrip("/").strip())

    @property
    def log_file_abs_path(self) -> str:
        """Абсолютный путь до файла логов."""
        return self.get_file_abs_path(self.private_log_file_path, self.private_log_file_name)

    @property
    def metric_file_abs_path(self) -> str:
        """Абсолютный путь до файла метрик."""
        return self.get_file_abs_path(self.private_metric_file_path, self.private_metric_file_name)

    @property
    def audit_file_abs_path(self) -> str:
        """Абсолютный путь до audit-файла."""
        return self.get_file_abs_path(self.private_audit_file_path, self.private_audit_file_name)

    @property
    def log_lvl(self) -> int:
        """Уровень логирования в зависимости от режима debug."""
        return DEBUG if self.debug else INFO


class GigachatSettings(BaseAppSettings):
    """Настройки GigaChat."""

    mock_toggle: bool = Field(validation_alias="GIGACHAT_MOCK_TOGGLE", default=False)
    gigachat_mock_variant: int = Field(validation_alias="GIGACHAT_MOCK_VARIANT", default=1)

    is_hard_health: bool = Field(validation_alias="GIGACHAT_IS_HARD_HEALTH", default=True)
    # OAuth авторизация (приоритетный способ)
    gigachat_credentials: str = Field(validation_alias="GIGACHAT_CREDENTIALS", default="")
    gigachat_scope: str = Field(validation_alias="GIGACHAT_SCOPE", default="GIGACHAT_API_PERS")
    gigachat_verify_ssl: bool = Field(validation_alias="GIGACHAT_VERIFY_SSL", default=True)
    gigachat_temperature: float = Field(validation_alias="GIGACHAT_TEMPERATURE", default=0.7)
    gigachat_profanity_check: bool = Field(validation_alias="GIGACHAT_PROFANITY_CHECK", default=False)

    # Сертификатная авторизация (альтернативный способ для LOCAL=True)
    gigachat_host: str = Field(validation_alias="GIGACHAT_HOST", default="")
    gigachat_port: str = Field(validation_alias="GIGACHAT_PORT", default="")
    gigachat_endpoint: str = Field(validation_alias="GIGACHAT_ENDPOINT", default="/v1")
    gigachat_tls_cert_filepath: None | str = Field(validation_alias="GIGACHAT_TLS_CERT_FILEPATH", default="")
    gigachat_key_filepath: None | str = Field(validation_alias="GIGACHAT_KEY_FILEPATH", default="")
    gigachat_ca_bundle_filepath: None | str = Field(validation_alias="GIGACHAT_CA_BUNDLE_FILEPATH", default="")

    gigachat_model_name: None | str = Field(validation_alias="GIGACHAT_MODEL_NAME", default="GigaChat-2-Max")
    gigachat_embedding_model_name: None | str = Field(
        validation_alias="GIGACHAT_EMBEDDING_MODEL_NAME", default="Embeddings"
    )
    gigachat_critic_counter: int = Field(validation_alias="GIGACHAT_CRITIC_COUNTER", default=2)

    # Weighted-random routing between primary and preview models
    gigachat_model_primary: str = Field(validation_alias="GIGACHAT_MODEL_PRIMARY", default="")
    gigachat_model_preview: str = Field(validation_alias="GIGACHAT_MODEL_PREVIEW", default="")
    gigachat_model_preview_probability: float = Field(
        validation_alias="GIGACHAT_MODEL_PREVIEW_PROBABILITY", default=0.0
    )

    gigachat_embedding_model_primary: str = Field(validation_alias="GIGACHAT_EMBEDDING_MODEL_PRIMARY", default="")
    gigachat_embedding_model_preview: str = Field(validation_alias="GIGACHAT_EMBEDDING_MODEL_PREVIEW", default="")
    gigachat_embedding_model_preview_probability: float = Field(
        validation_alias="GIGACHAT_EMBEDDING_MODEL_PREVIEW_PROBABILITY", default=0.0
    )

    gigachat_retry_max_attempts_default: int = Field(validation_alias="GIGACHAT_RETRY_MAX_ATTEMPTS_DEFAULT", default=5)
    gigachat_retry_max_attempts_429: int = Field(validation_alias="GIGACHAT_RETRY_MAX_ATTEMPTS_429", default=10)
    gigachat_max_concurrent_requests: int = Field(validation_alias="GIGACHAT_MAX_CONCURRENT_REQUESTS", default=10)
    gigachat_max_rps: int = Field(validation_alias="GIGACHAT_MAX_RPS", default=10)

    gigachat_default_temperature: float = Field(validation_alias="GIGACHAT_DEFAULT_TEMPERATURE", default=0)
    gigachat_creative_temperature: float = Field(validation_alias="GIGACHAT_CREATIVE_TEMPERATURE", default=0.32)

    @model_validator(mode="after")
    def validate_file_path(self) -> "GigachatSettings":
        """Валидирует пути сертификатов при сертификатной авторизации."""
        # Валидация сертификатов только если используем сертификатную авторизацию
        if self.gigachat_credentials:
            return self  # OAuth — сертификаты не нужны

        if self.local:
            for gigachat_cert_file in [
                self.gigachat_tls_cert_filepath,
                self.gigachat_ca_bundle_filepath,
                self.gigachat_key_filepath,
            ]:
                if not gigachat_cert_file:
                    raise ValueError("Certificate paths required when LOCAL=True and no GIGACHAT_CREDENTIALS")
                if not os.path.exists(gigachat_cert_file):
                    raise ValueError(f"Path does not exist: {gigachat_cert_file}")
                if os.path.isdir(gigachat_cert_file):
                    raise ValueError(f"Path is a directory: {gigachat_cert_file}")
        return self

    @model_validator(mode="after")
    def validate_model_weights(self) -> "GigachatSettings":
        """Проверяет корректность весов preview-моделей."""
        for prefix, _primary_field, preview_field, prob_field in [
            ("LLM", self.gigachat_model_primary, self.gigachat_model_preview, self.gigachat_model_preview_probability),
            (
                "embeddings",
                self.gigachat_embedding_model_primary,
                self.gigachat_embedding_model_preview,
                self.gigachat_embedding_model_preview_probability,
            ),
        ]:
            if not (0.0 <= prob_field <= 1.0):
                raise ValueError(f"{prefix} preview probability must be in [0.0, 1.0], got {prob_field}")
            if prob_field > 0 and not preview_field:
                raise ValueError(f"{prefix} preview model is required when preview probability > 0")
        return self

    @property
    def gigachat_model_weights(self) -> dict[str, float] | None:
        """Веса для weighted-random выбора LLM-модели."""
        primary = self.gigachat_model_primary or self.gigachat_model_name
        preview = self.gigachat_model_preview
        prob = self.gigachat_model_preview_probability
        if not primary or not preview or prob <= 0:
            return None
        return {primary: 1.0 - prob, preview: prob}

    @property
    def gigachat_embedding_model_weights(self) -> dict[str, float] | None:
        """Веса для weighted-random выбора embeddings-модели."""
        primary = self.gigachat_embedding_model_primary or self.gigachat_embedding_model_name
        preview = self.gigachat_embedding_model_preview
        prob = self.gigachat_embedding_model_preview_probability
        if not primary or not preview or prob <= 0:
            return None
        return {primary: 1.0 - prob, preview: prob}

    @property
    def gigachat_base_url(self) -> str:
        """Базовый URL GigaChat."""
        return f"{self.protocol}://{self.gigachat_host}:{self.gigachat_port}{self.gigachat_endpoint}"

    def _debug_ssl_certs(self, cert_path: str, key_path: str, ca_path: str) -> None:
        """Выводит диагностику SSL-сертификатов при DEBUG=True."""
        print("\n" + "=" * 60)
        print("SSL CERTIFICATE DIAGNOSTICS")
        print("=" * 60)

        # Проверка существования файлов
        for name, path in [("cert", cert_path), ("key", key_path), ("ca", ca_path)]:
            exists = os.path.exists(path)
            readable = os.access(path, os.R_OK) if exists else False
            status = "OK" if exists and readable else "FAIL"
            print(f"[{status}] {name}: {path}")

        # Загрузка и анализ сертификата
        try:
            with open(cert_path, "rb") as f:
                cert_data = f.read()
            cert = x509.load_pem_x509_certificate(cert_data)

            print("\nCertificate info:")
            print(f"  Subject: {cert.subject.rfc4514_string()}")
            print(f"  Issuer:  {cert.issuer.rfc4514_string()}")
            print(f"  Serial:  {cert.serial_number}")
            print(f"  Valid from: {cert.not_valid_before_utc}")
            print(f"  Valid to:   {cert.not_valid_after_utc}")

            now = datetime.now(UTC)
            if now < cert.not_valid_before_utc:
                print("  [WARN] Certificate is not yet valid!")
            elif now > cert.not_valid_after_utc:
                print("  [WARN] Certificate has EXPIRED!")
            else:
                days_left = (cert.not_valid_after_utc - now).days
                print(f"  [OK] Certificate is valid ({days_left} days left)")

            # Получаем modulus сертификата
            cert_pubkey = cert.public_key()
            cert_pubkey_bytes = cert_pubkey.public_bytes(
                encoding=serialization.Encoding.DER, format=serialization.PublicFormat.SubjectPublicKeyInfo
            )
            cert_hash = hashlib.md5(cert_pubkey_bytes).hexdigest()
            print(f"  Cert public key MD5: {cert_hash}")

        except Exception as e:
            print(f"  [ERROR] Failed to load certificate: {e}")
            cert_hash = None

        # Загрузка и проверка ключа
        try:
            with open(key_path, "rb") as f:
                key_data = f.read()
            private_key = serialization.load_pem_private_key(key_data, password=None)

            key_pubkey_bytes = private_key.public_key().public_bytes(
                encoding=serialization.Encoding.DER, format=serialization.PublicFormat.SubjectPublicKeyInfo
            )
            key_hash = hashlib.md5(key_pubkey_bytes).hexdigest()
            print(f"  Key public key MD5:  {key_hash}")

            if cert_hash and key_hash:
                if cert_hash == key_hash:
                    print("  [OK] Certificate and key MATCH")
                else:
                    print("  [FAIL] Certificate and key DO NOT MATCH!")

        except Exception as e:
            print(f"  [ERROR] Failed to load private key: {e}")

        # Проверка CA
        try:
            with open(ca_path, "rb") as f:
                ca_data = f.read()
            ca_cert = x509.load_pem_x509_certificate(ca_data)
            print("\nCA Certificate:")
            print(f"  Subject: {ca_cert.subject.rfc4514_string()}")
            print(f"  Issuer:  {ca_cert.issuer.rfc4514_string()}")
        except Exception as e:
            print(f"  [ERROR] Failed to load CA certificate: {e}")

        print("=" * 60 + "\n")

    @property
    def gigachat_certs(self) -> dict[str, Any]:
        """Возвращает SSL-контекст для GigaChat при LOCAL=True."""
        certs = {}
        if self.local:
            current_path = lambda p: str((Path(__file__).parent.parent.parent / Path(p)).resolve())

            cert_path = current_path(self.gigachat_tls_cert_filepath)
            key_path = current_path(self.gigachat_key_filepath)
            ca_path = current_path(self.gigachat_ca_bundle_filepath)

            if self.debug:
                self._debug_ssl_certs(cert_path, key_path, ca_path)

            ssl_context = ssl.create_default_context(cafile=ca_path)
            ssl_context.load_cert_chain(certfile=cert_path, keyfile=key_path)

            certs = {"ssl_context": ssl_context}
        return certs

    @property
    def pkap_certs(self) -> dict[str, Any]:
        """Возвращает SSL-контекст и пути к сертификатам для ПКАП."""
        certs = {}
        if self.local:
            current_path = lambda p: str((Path(__file__).parent.parent.parent / Path(p)).resolve())

            cert_path = current_path(self.gigachat_tls_cert_filepath)
            key_path = current_path(self.gigachat_key_filepath)
            ca_path = current_path(self.gigachat_ca_bundle_filepath)

            if self.debug:
                self._debug_ssl_certs(cert_path, key_path, ca_path)

            ssl_context = ssl.create_default_context(cafile=ca_path)
            ssl_context.load_cert_chain(certfile=cert_path, keyfile=key_path)

            certs = {
                "ssl_context": ssl_context,
                "cert_path": cert_path,
                "key_path": key_path,
                "ca_path": ca_path,
            }
        return certs

    @property
    def base_params(self) -> dict[str, Any]:
        """Базовые параметры для инициализации GigaChat-клиента."""
        # OAuth авторизация (приоритет)
        if self.gigachat_credentials:
            params = {
                "credentials": self.gigachat_credentials,
                "scope": self.gigachat_scope,
                "verify_ssl_certs": self.gigachat_verify_ssl,
                # "temperature": self.gigachat_temperature,
                "profanity_check": self.gigachat_profanity_check,
            }
            # Если задан хост, позволяем переопределить endpoint и для OAuth.
            if self.gigachat_host:
                params["base_url"] = self.gigachat_base_url
            return params
        return {
            "base_url": self.gigachat_base_url,
            "verify_ssl_certs": False,
            **self.gigachat_certs,
        }


class CasesAgentSettings(BaseAppSettings):
    """Настройки поведения cases_agent: retry, память, лимиты кейсов."""

    critic_max_retries: int = Field(
        validation_alias="CASES_AGENT_CRITIC_MAX_RETRIES",
        default=2,
        description="Максимальное количество попыток критика улучшить ответ.",
    )
    history_limit: int = Field(
        validation_alias="CASES_AGENT_HISTORY_LIMIT",
        default=8,
        description="Лимит сообщений в истории диалога.",
    )
    default_cases_limit: int = Field(
        validation_alias="CASES_AGENT_DEFAULT_CASES_LIMIT",
        default=3,
        description="Количество кейсов по умолчанию, если пользователь не указал другое.",
    )

    @model_validator(mode="after")
    def validate_positive(self) -> "CasesAgentSettings":
        """Проверяет, что числовые параметры положительны."""
        for field_name, value in [
            ("critic_max_retries", self.critic_max_retries),
            ("history_limit", self.history_limit),
            ("default_cases_limit", self.default_cases_limit),
        ]:
            if value < 1:
                raise ValueError(f"{field_name} must be >= 1, got {value}")
        return self


class PostgreSettings(BaseAppSettings):
    """PostgreSQL pool configuration for ~10 RPS with K8s keepalives."""

    is_hard_health: bool = Field(validation_alias="PG_IS_HARD_HEALTH", default=True)
    user: None | str = Field(validation_alias="PG_USER", default="usecase_advisor_ai_agent_app")
    password: None | str = Field(validation_alias="PG_PASSWORD")
    host: None | str = Field(validation_alias="PG_HOST", default="postgres.internal")
    port: None | str = Field(validation_alias="PG_PORT", default="5433")
    database: None | str = Field(validation_alias="PG_NAME", default="upp_agents")
    schema_name: None | str = Field(validation_alias="PG_SCHEMA", default="usecase_advisor_ai_agent_context_db")
    sslmode: None | str = Field(validation_alias="SSLMODE_OPTION", default="disable")

    pool_min_size: int = Field(default=5, validation_alias="PG_POOL_MIN_SIZE")
    pool_max_size: int = Field(default=20, validation_alias="PG_POOL_MAX_SIZE")
    pool_max_overflow: int = Field(default=5, validation_alias="PG_POOL_MAX_OVERFLOW")
    pool_getconn_timeout: float = Field(default=10.0, validation_alias="PG_POOL_GETCONN_TIMEOUT")
    pool_max_idle: float = Field(default=120.0, validation_alias="PG_POOL_MAX_IDLE")
    keepalive_interval: float = Field(default=10.0, validation_alias="PG_KEEPALIVE_INTERVAL")
    keepalive_count: int = Field(default=5, validation_alias="PG_KEEPALIVE_COUNT")

    # Connection timeout для быстрого failover (libpq connect_timeout)
    connect_timeout: float = Field(
        default=5.0,
        validation_alias="PG_CONNECT_TIMEOUT",
        description="Таймаут подключения к PostgreSQL (сек). "
        "Быстрый таймаут позволяет psycopg перебирать хосты при failover.",
    )
    pool_reconnect_timeout: float = Field(
        default=5.0,
        validation_alias="PG_POOL_RECONNECT_TIMEOUT",
        description="psycopg_pool reconnect_timeout (сек). "
        "Время, в течение которого пул пытается восстановить мертвые соединения.",
    )

    # ClusterIP random LB: сколько попыток делать при попадании на standby
    standby_max_retries: int = Field(
        default=10,
        validation_alias="PG_STANDBY_MAX_RETRIES",
        description="Макс. попыток при попадании на standby через K8s ClusterIP random LB. "
        "Каждая попытка — новое соединение через ClusterIP. "
        "При исчерпании — пересоздание пула.",
    )

    # Failover / multi-host (аналог JDBC targetServerType)
    replica_hosts: None | str = Field(
        default=None,
        validation_alias="PG_REPLICA_HOSTS",
        description="Список реплик через запятую. Используется для failover при недоступности PG_HOST.",
    )
    target_session_attrs: str = Field(
        default="primary",
        validation_alias="PG_TARGET_SESSION_ATTRS",
        description="psycopg target_session_attrs: primary | standby | read-write | any. "
        "При primary драйвер подключается только к мастеру, перебирая все хоста.",
    )

    @model_validator(mode="after")
    def validate_pool_sizes(self) -> "PostgreSettings":
        """Проверяет корректность размеров пула подключений."""
        if self.pool_max_size < self.pool_min_size:
            raise ValueError("pool_max_size должен быть >= pool_min_size")
        if self.pool_max_overflow < 0:
            raise ValueError("pool_max_overflow должен быть >= 0")
        if self.pool_getconn_timeout <= 0:
            raise ValueError("pool_getconn_timeout должен быть > 0")
        return self

    @property
    def encoded_pass(self) -> str:
        """URL-encoded пароль для DSN."""
        from urllib.parse import quote_plus

        return quote_plus(self.password)

    @property
    def all_hosts(self) -> str:
        """Все хосты (master + replicas) через запятую для multi-host conninfo."""
        hosts = [self.host]
        if self.replica_hosts:
            hosts.extend(h.strip() for h in self.replica_hosts.split(",") if h.strip())
        return ",".join(hosts)

    @computed_field
    @property
    def conninfo(self) -> str:
        """Connection string с TCP keepalives и multi-host failover для K8s.

        WARNING: search_path НЕ кладём в libpq `options=-c search_path=...` —
        PgBouncer (transaction/statement mode) рвёт такое подключение
        с `FATAL: unsupported startup parameter in options: search_path`.
        Схема выставляется через `configure` callback пула psycopg
        и/или `SET LOCAL` внутри явной транзакции.
        """
        return (
            f"postgresql://{self.user}:{self.encoded_pass}"
            f"@{self.all_hosts}:{self.port}/{self.database}"
            f"?sslmode={self.sslmode}"
            f"&keepalives=1"
            f"&keepalives_idle={int(self.pool_max_idle)}"
            f"&keepalives_interval={int(self.keepalive_interval)}"
            f"&keepalives_count={self.keepalive_count}"
            f"&connect_timeout={int(self.connect_timeout)}"
            f"&target_session_attrs={self.target_session_attrs}"
        )

    @computed_field
    @property
    def sqlalchemy_url(self) -> str:
        """SQLAlchemy DSN для `postgresql+psycopg` с multi-host failover.

        WARNING: search_path НЕ кладём в options — PgBouncer отбивает.
        SQLAlchemy использует `schema_translate_map` и `connect` event
        для фиксации схемы runtime.
        """
        return (
            f"postgresql+psycopg://{self.user}:{self.encoded_pass}"
            f"@{self.all_hosts}:{self.port}/{self.database}"
            f"?sslmode={self.sslmode}"
            f"&target_session_attrs={self.target_session_attrs}"
            f"&keepalives=1"
            f"&keepalives_idle={int(self.pool_max_idle)}"
            f"&keepalives_interval={int(self.keepalive_interval)}"
            f"&keepalives_count={self.keepalive_count}"
            f"&connect_timeout={int(self.connect_timeout)}"
        )

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str | None) -> str:
        """Валидация пароля для подключения к БД."""
        if not v:
            logger.warning("PostgreSettings: postgres_password is not set")
            raise ValueError("PostgreSettings: postgres_password is required")
        logger.info("PostgreSettings: postgres_password has been set")
        return v


class LangfuseSettings(BaseAppSettings):
    """Настройки Langfuse observability с полной SSL-поддержкой."""

    is_hard_health: bool = Field(validation_alias="LANGFUSE_IS_HARD_HEALTH", default=False)
    stage: str = Field(validation_alias="LANGFUSE_STAGE", default="dev")
    public_key: str = Field(validation_alias="LANGFUSE_PUBLIC_KEY")
    secret_key: str = Field(validation_alias="LANGFUSE_SECRET_KEY")
    host: str = Field(validation_alias="LANGFUSE_HOST", default="ift-voice360.cloud.delta.sbrf.ru")
    port: str = Field(validation_alias="LANGFUSE_PORT", default="9443")
    path: str = Field(validation_alias="LANGFUSE_PATH", default="/langfuse_v3")

    # SSL настройки (аналогично GigaChat)
    langfuse_ca_bundle_filepath: None | str = Field(validation_alias="LANGFUSE_CA_BUNDLE_FILEPATH", default="")
    langfuse_tls_cert_filepath: None | str = Field(validation_alias="LANGFUSE_TLS_CERT_FILEPATH", default="")
    langfuse_key_filepath: None | str = Field(validation_alias="LANGFUSE_KEY_FILEPATH", default="")

    mask_state_in_traces: bool = Field(
        validation_alias="LANGFUSE_MASK_STATE_IN_TRACES",
        default=True,
        description="Если True, входные/выходные данные state в Langfuse заменяются на ***.",
    )

    flush_interval_sec: float = Field(
        validation_alias="LANGFUSE_FLUSH_INTERVAL_SEC",
        default=15.0,
        description="Периодичность фонового сброса событий Langfuse в секундах.",
    )

    @field_validator("public_key", "secret_key")
    @classmethod
    def validate_keys(cls, v: str | None) -> str | None:
        """Проверяет, что ключи Langfuse заданы, иначе трейсинг отключён."""
        if not v:
            logger.warning("Langfuse keys not set - tracing disabled")
        return v

    @field_validator("host")
    @classmethod
    def validate_host(cls, v: str) -> str:
        """Проверяет, что host не содержит протокол."""
        # host всегда без протокола — как у GigaChat
        if ("http://" in v.lower()) or ("https://" in v.lower()):
            logger.warning("Langfuse host should not contain protocol - use only hostname or hostname:port")
        return v

    @field_validator("path")
    @classmethod
    def normalize_path(cls, v: str) -> str:
        """Нормализует путь Langfuse: обрезает пробелы, гарантирует ведущий `/`."""
        v = (v or "").strip()
        if not v:
            return "/"
        if not v.startswith("/"):
            v = "/" + v
        # "/langfuse/" -> "/langfuse"
        if len(v) > 1 and v.endswith("/"):
            v = v[:-1]
        return v

    @model_validator(mode="after")
    def validate_ssl_files(self) -> "LangfuseSettings":
        """Валидация SSL файлов только если они указаны."""
        if self.local and any(
            [self.langfuse_ca_bundle_filepath, self.langfuse_tls_cert_filepath, self.langfuse_key_filepath]
        ):
            ssl_files = [
                self.langfuse_ca_bundle_filepath,
                self.langfuse_tls_cert_filepath,
                self.langfuse_key_filepath,
            ]
            for f in ssl_files:
                if f and not os.path.exists(f):
                    raise ValueError(f"Langfuse SSL file does not exist: {f}")
                if f and os.path.isdir(f):
                    raise ValueError(f"Langfuse SSL path is a directory: {f}")
        return self

    @property
    def base_url(self) -> str:
        """Полный URL до Langfuse, аналог gigachat_base_url."""
        # если кто-то запишет порт прямо в HOST, не дублируем
        if ":" in self.host:
            netloc = self.host
        else:
            netloc = f"{self.host}:{self.port}" if self.port else self.host

        return f"{self.protocol}://{netloc}{self.path}"

    def _debug_langfuse_ssl(self) -> None:
        """Диагностика Langfuse SSL-сертификатов."""
        if not self.debug or not self.local:
            return

        print("\n" + "=" * 60)
        print("LANGFUSE SSL CERTIFICATE DIAGNOSTICS")
        print("=" * 60)

        files = [
            ("CA bundle", self.langfuse_ca_bundle_filepath),
            ("TLS cert", self.langfuse_tls_cert_filepath),
            ("Private key", self.langfuse_key_filepath),
        ]

        for name, path in files:
            if path:
                exists = os.path.exists(path)
                readable = os.access(path, os.R_OK) if exists else False
                status = "OK" if exists and readable else "FAIL"
                print(f"[{status}] {name}: {path}")
            else:
                print(f"[SKIP] {name}: not configured")

        print("=" * 60 + "\n")

    @property
    def langfuse_certs(self) -> tuple[str | None, str | None, str | None]:
        """Возвращает кортеж (tls_cert, key, ca_bundle) для AsyncLangfuseClient."""
        if not self.local:
            self._debug_langfuse_ssl()
            return (None, None, None)

        current_path = lambda p: str((Path(__file__).parent.parent.parent / Path(p)).resolve())

        tls_cert = current_path(self.langfuse_tls_cert_filepath) if self.langfuse_tls_cert_filepath else None
        key_file = current_path(self.langfuse_key_filepath) if self.langfuse_key_filepath else None
        ca_bundle = current_path(self.langfuse_ca_bundle_filepath) if self.langfuse_ca_bundle_filepath else None

        self._debug_langfuse_ssl()
        return (tls_cert, key_file, ca_bundle)

    @property
    def langfuse_ca_bundle(self) -> str | None:
        """Путь к CA bundle для AsyncLangfuseClient."""
        if not self.local or not self.langfuse_ca_bundle_filepath:
            return None

        return str((Path(__file__).parent.parent.parent / Path(self.langfuse_ca_bundle_filepath)).resolve())


class IDPSettings(BaseAppSettings):
    """Для работы с векторной базой данных по кейсам."""

    is_hard_health: bool = Field(validation_alias="IDP_IS_HARD_HEALTH", default=False)
    host: str = Field(validation_alias="IDP_URL", default="sm.apps.dev-terra000003-ids.ocp.delta.sbrf.ru")
    port: str = Field(validation_alias="IDP_PORT", default="443")
    source_id: str = Field(validation_alias="IDP_SOURCE_ID", default="f2c46feb-8018-43bd-ac04-cdfcbc33b7a0")
    idp_index_id: str = Field(
        validation_alias="IDP_INDEX_ID", default="1a0cbc8d-5df4-4bb2-abda-b4bdddfd708d_nofaq_transformat_1"
    )
    idp_filter_path: str = Field(
        validation_alias="IDP_FILTER_PATH",
        default="Цифровая трансформация как сервис/AI Гипотезы и AI кейсы/Агент Кейсы и Рекомендации",
    )

    max_retry: int = Field(validation_alias="IDP_MAX_RETRY", default=5)
    wait_retry: float = Field(validation_alias="IDP_WAIT_RETRY", default=2.0)
    request_timeout: float = Field(validation_alias="IDP_REQUEST_TIMEOUT", default=30.0)

    is_idp_reranker: bool = Field(validation_alias="IS_IDP_RERANKER", default=False)
    idp_search_limit: int = Field(validation_alias="IDP_SEARCH_LIMIT", default=80)
    idp_retrival_limit: int = Field(validation_alias="IDP_RETRIVAL_LIMIT", default=42)
    idp_bm25_weight: float = Field(validation_alias="IDP_BM25_WEIGHT", default=0.45)

    idp_ca_bundle_filepath: None | str = Field(validation_alias="IDP_CA_BUNDLE_FILEPATH", default="")
    idp_tls_cert_filepath: None | str = Field(validation_alias="IDP_TLS_CERT_FILEPATH", default="")
    idp_key_filepath: None | str = Field(validation_alias="IDP_KEY_FILEPATH", default="")

    @property
    def url(self) -> str:
        """Базовый URL IDP."""
        return f"{self.protocol}://{self.host}:{self.port}"

    @property
    def idp_certs(self) -> dict[str, str | None]:
        """Возвращает словарь с путями к сертификатам IDP."""
        if not self.local:
            return {"tls_cert": None, "key_file": None, "ca_bundle": None}

        current_path = lambda p: str((Path(__file__).parent.parent.parent / Path(p)).resolve())

        tls_cert = current_path(self.idp_tls_cert_filepath) if self.idp_tls_cert_filepath else None
        key_file = current_path(self.idp_key_filepath) if self.idp_key_filepath else None
        ca_bundle = current_path(self.idp_ca_bundle_filepath) if self.idp_ca_bundle_filepath else None
        return {"tls_cert": tls_cert, "key_file": key_file, "ca_bundle": ca_bundle}

    @property
    def filter_config(self) -> dict[str, Any]:
        """Конфигурация фильтра по breadcrumbs для поиска IDP."""
        return {
            "operator": "or",
            "elements": [{"operator": "prefix", "field": "breadcrumbs", "value": f"{self.idp_filter_path}"}],
        }


class PKAPSettings(BaseAppSettings):
    """Для взаимодействия с ПКАП ФП Умный поиск."""

    is_hard_health: bool = Field(validation_alias="PKAP_IS_HARD_HEALTH", default=False)

    host: str = Field(validation_alias="PKAP_HOST", default="geo-mtls-ai-pcapkksb-pvs-ift.delta.sbrf.ru")

    domen: str = Field(validation_alias="PKAP_DOMEN", default="/api/v1/pcap-kksb-pvs/ai-partner-registry")

    port: int = Field(validation_alias="PKAP_PORT", default=443)

    prefix_solutions_index: str = Field(
        validation_alias="PREFIX_CUSTOMERS", default="fox-dm_global_search_customer_data-index"
    )

    pkap_cache_timeout: int = Field(validation_alias="PKAP_CACHE_TIMEOUT", default=600)

    pkap_ca_bundle_filepath: None | str = Field(validation_alias="PKAP_CA_BUNDLE_FILEPATH", default="")
    pkap_tls_cert_filepath: None | str = Field(validation_alias="PKAP_TLS_CERT_FILEPATH", default="")
    pkap_key_filepath: None | str = Field(validation_alias="PKAP_KEY_FILEPATH", default="")

    retries_backoff_factor: int = Field(validation_alias="PKAP_RETRIES_BACKOFF_FACTOR", default=1)
    retries_total: int = Field(validation_alias="PKAP_RETRIES_TOTAL", default=0)
    timeout: int = Field(validation_alias="PKAP_TIMEOUT", default=30)

    pool_min_size: int = Field(default=5, validation_alias="PKAP_POOL_MIN_SIZE")
    pool_max_size: int = Field(default=20, validation_alias="PKAP_POOL_MAX_SIZE")
    pool_max_idle: float = Field(default=60.0, validation_alias="PKAP_POOL_MAX_IDLE")

    @property
    def url(self) -> str:
        """Базовый URL до ПКАП."""
        if self.local:
            return f"{self.protocol}://{self.host}{self.domen}"
        else:
            return f"{self.protocol}://{self.host}:{self.port}{self.domen}"

    @property
    def certs(self) -> dict[str, str | None]:
        """Возвращает словарь с путями к сертификатам ПКАП."""
        if not self.local:
            return {"tls_cert": None, "key_file": None, "ca_bundle": None}

        current_path = lambda p: str((Path(__file__).parent.parent.parent / Path(p)).resolve())

        tls_cert = current_path(self.pkap_tls_cert_filepath) if self.pkap_tls_cert_filepath else None
        key_file = current_path(self.pkap_key_filepath) if self.pkap_key_filepath else None
        ca_bundle = current_path(self.pkap_ca_bundle_filepath) if self.pkap_ca_bundle_filepath else None
        return {"tls_cert": tls_cert, "key_file": key_file, "ca_bundle": ca_bundle}


class A2AServerSettings(BaseSettings):
    """Настройки A2A сервера из переменных окружения.

    Эти настройки управляют поведением сервера без импорта бизнес-логики.
    """

    model_config = SettingsConfigDict(env_ignore_empty=True, enable_decoding=False)

    host: str = Field(default="127.0.0.1", validation_alias="APP_HOST")
    port: int = Field(default=8080, validation_alias="APP_PORT")

    agent_name: str = Field(default="usecase-agent", validation_alias="A2A_AGENT_NAME")
    agent_version: str = Field(default="1.0.0", validation_alias="A2A_AGENT_VERSION")
    agent_description: str = Field(
        default="AI агент для подбора кейсов и рекомендаций.",
        validation_alias="A2A_AGENT_DESCRIPTION",
    )

    agent_card_path: str = Field(
        default="/api/v1/usecase-agent/chat/.well-known/agent-card.json",
        validation_alias="A2A_AGENT_CARD_PATH",
    )
    agent_rpc_path: str = Field(
        default="/api/v1/usecase-agent/chat",
        validation_alias="A2A_AGENT_RPC_PATH",
    )

    enable_push_notifications: bool = Field(default=False, validation_alias="A2A_PUSH_NOTIFICATIONS")
    database_create_tables: bool = Field(default=True, validation_alias="A2A_DATABASE_CREATE_TABLES")
    error_message: str = Field(
        default="Произошла ошибка при обработке запроса. Пожалуйста, попробуйте позже.",
        validation_alias="A2A_ERROR_MESSAGE",
    )
    supported_content_types: list[str] = Field(
        default=["text", "text/plain"],
        validation_alias="A2A_SUPPORTED_CONTENT_TYPES",
    )

    @field_validator("supported_content_types", mode="before")
    @classmethod
    def validate_list_field(cls, value: Any, info: ValidationInfo) -> list[str]:
        """Парсит список content types из строки JSON или возвращает дефолт."""
        correct_value = None
        if isinstance(value, (list, tuple)):
            correct_value = list(value)
        if isinstance(value, str):
            try:
                parsed_value = json.loads(value)
            except json.JSONDecodeError:
                parsed_value = None
            if isinstance(parsed_value, list):
                correct_value = parsed_value
        return correct_value or cls.model_fields[info.field_name].default

    @field_validator("agent_card_path", "agent_rpc_path")
    @classmethod
    def normalize_a2a_paths(cls, value: str) -> str:
        """Нормализует A2A-пути: обрезает пробелы, гарантирует ведущий `/`."""
        value = (value or "").strip()
        if not value:
            raise ValueError("A2A path must not be empty")
        if not value.startswith("/"):
            value = "/" + value
        return value


class CacheExtSettings(BaseSettings):
    """Настройки семантического кеша."""

    model_config = SettingsConfigDict(populate_by_name=True)

    backend: Literal["local", "redis"] = Field(
        default="local",
        validation_alias="CACHE_EXT_BACKEND",
        description="Бэкенд хранилища: local (dict) или redis",
    )
    redis_host: str = Field(
        default="localhost",
        validation_alias="CACHE_EXT_REDIS_HOST",
        description="Redis хост",
    )
    redis_port: int = Field(
        default=6379,
        ge=1,
        le=65535,
        validation_alias="CACHE_EXT_REDIS_PORT",
        description="Redis порт",
    )
    redis_db: int = Field(
        default=0,
        ge=0,
        validation_alias="CACHE_EXT_REDIS_DB",
        description="Номер Redis БД",
    )
    redis_username: str | None = Field(
        default=None,
        validation_alias="CACHE_EXT_REDIS_USERNAME",
        description="Redis username",
    )
    redis_password: str | None = Field(
        default=None,
        validation_alias="CACHE_EXT_REDIS_PASSWORD",
        description="Redis пароль",
    )
    redis_key_prefix: str = Field(
        default="semantic_cache",
        validation_alias="CACHE_EXT_REDIS_KEY_PREFIX",
        description="Префикс ключей Redis",
    )
    max_entries_per_tag: int = Field(
        default=64,
        ge=1,
        validation_alias="CACHE_EXT_MAX_ENTRIES_PER_TAG",
        description="Максимальное количество записей на один тег",
    )
    similarity_threshold: float = Field(
        default=0.96,
        ge=0.0,
        le=1.0,
        validation_alias="CACHE_EXT_SIMILARITY_THRESHOLD",
        description="Порог косинусного сходства по умолчанию",
    )
    ttl_seconds: int | None = Field(
        default=3600,
        ge=1,
        validation_alias="CACHE_EXT_TTL_SECONDS",
        description="TTL записей в секундах. None — без ограничения.",
    )
    extract_relevant_cases_threshold: float = Field(
        default=0.95,
        ge=0.0,
        le=1.0,
        validation_alias="CACHE_EXT_EXTRACT_RELEVANT_THRESHOLD",
        description="Порог для ноды extract_relevant_cases.",
    )
    expert_recommendation_threshold: float = Field(
        default=0.95,
        ge=0.0,
        le=1.0,
        validation_alias="CACHE_EXT_EXPERT_THRESHOLD",
        description="Порог для ноды expert_recommendation.",
    )

    @property
    def redis_url(self) -> str:
        """Сформировать Redis URL из компонентов."""
        if self.redis_username and self.redis_password:
            auth = f"{self.redis_username}:{self.redis_password}@"
        elif self.redis_password:
            auth = f":{self.redis_password}@"
        else:
            auth = ""
        return f"redis://{auth}{self.redis_host}:{self.redis_port}/{self.redis_db}"


class Secrets:
    """Агрегирует все настройки приложения в единый контейнер."""

    app: AppSettings = AppSettings()
    log: LogSettings = LogSettings()
    gigachat: GigachatSettings = GigachatSettings()
    cases_agent: CasesAgentSettings = CasesAgentSettings()
    postgre: PostgreSettings = PostgreSettings()
    langfuse: LangfuseSettings = LangfuseSettings()
    idp: IDPSettings = IDPSettings()
    pkap: PKAPSettings = PKAPSettings()
    a2a: A2AServerSettings = A2AServerSettings()
    cache_ext: CacheExtSettings = CacheExtSettings()


APP_CONFIG = Secrets()

__all__ = [
    "Secrets",
    "APP_CONFIG",
]
