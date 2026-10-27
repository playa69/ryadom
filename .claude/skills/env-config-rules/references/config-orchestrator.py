import json
import os
import ssl
from logging import DEBUG, INFO
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from pydantic import Field, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from modules.aef_tracing.config import AEFSettings
from modules.langfuse.config import LangfuseSettings

load_dotenv()


class BaseAppSettings(BaseSettings):
    """Base application settings."""

    model_config = SettingsConfigDict(env_ignore_empty=True, enable_decoding=False)

    local: bool = Field(validation_alias="LOCAL", default=False)
    debug: bool = Field(validation_alias="DEBUG", default=False)
    # The same certificates are used for all integrations
    tls_cert_filepath: str | None = Field(validation_alias="TLS_CERT_FILEPATH", default=None)
    key_filepath: str | None = Field(validation_alias="KEY_FILEPATH", default=None)
    ca_bundle_filepath: str | None = Field(validation_alias="CA_BUNDLE_FILEPATH", default=None)

    @property
    def protocol(self) -> str:
        return "https" if self.local else "http"

    def get_ssl_context(self) -> ssl.SSLContext | None:
        ssl_context = None
        if not self.local:
            if self.tls_cert_filepath and self.key_filepath and self.ca_bundle_filepath:
                cert_path = self.__get_absolute_path(self.tls_cert_filepath)
                key_path = self.__get_absolute_path(self.key_filepath)
                ca_path = self.__get_absolute_path(self.ca_bundle_filepath)
                ssl_context = ssl.create_default_context(cafile=ca_path)
                ssl_context.load_cert_chain(certfile=cert_path, keyfile=key_path)
        return ssl_context

    @staticmethod
    def __get_absolute_path(path: str) -> str:
        return str((Path(__file__).parent.parent.parent / path).resolve())


class AppSettings(BaseAppSettings):
    """Application settings."""

    host: str = Field(validation_alias="APP_HOST", default="0.0.0.0")
    port: int = Field(validation_alias="APP_PORT", default=8080)
    kube_net_name: str = Field(validation_alias="PROJECT_NAME", default="AIGATEWAY")
    timezone: str = Field(validation_alias="TIMEZONE", default="Europe/Moscow")


class LogSettings(BaseAppSettings):
    """Logging settings."""

    private_log_file_path: str = Field(validation_alias="LOG_PATH", default=os.getcwd())
    private_log_file_name: str = Field(validation_alias="LOG_FILE_NAME", default="app.log")
    private_metric_file_path: str = Field(validation_alias="METRIC_PATH", default=os.getcwd())
    private_metric_file_name: str = Field(validation_alias="METRIC_FILE_NAME", default="app-metric.log")
    private_audit_file_path: str = Field(validation_alias="AUDIT_LOG_PATH", default=os.getcwd())
    private_audit_file_name: str = Field(validation_alias="AUDIT_LOG_FILE_NAME", default="events.log")
    audit_host_ip: str = Field(validation_alias="HOST_IP", default="127.0.0.1")
    audit_host_uid: str = Field(validation_alias="HOST_UID", default="63bd6cbe-170b-49bf-a65c-3ce967398ccd")
    audit_enabled: bool = Field(validation_alias="AUDIT_LOG_ENABLED", default=False)
    mask_enabled: bool = Field(validation_alias="MASK_ENABLED", default=True)
    log_rotation: str = Field(validation_alias="LOG_ROTATION", default="10 MB")

    @field_validator(
        "private_log_file_path",
        "private_metric_file_path",
        "private_audit_file_path",
    )
    @classmethod
    def validate_path(cls, value: str) -> str:
        if not os.path.exists(value):
            raise ValueError(f"Path does not exist: {value}!")
        if not os.path.isdir(value):
            raise ValueError(f"Path is not a directory: {value}!")
        return value

    @staticmethod
    def get_file_abs_path(path_name: str, file_name: str) -> str:
        return os.path.join(path_name.strip(), file_name.lstrip("/").strip())

    @property
    def log_file_abs_path(self) -> str:
        return self.get_file_abs_path(self.private_log_file_path, self.private_log_file_name)

    @property
    def metric_file_abs_path(self) -> str:
        return self.get_file_abs_path(self.private_metric_file_path, self.private_metric_file_name)

    @property
    def audit_file_abs_path(self) -> str:
        return self.get_file_abs_path(self.private_audit_file_path, self.private_audit_file_name)

    @property
    def log_lvl(self) -> int:
        return DEBUG if self.debug else INFO


def _default_gigachat_models() -> dict[str, str]:
    return {
        "complexity_classifier": "GigaChat-2-Max",
        "small_talk": "GigaChat-2-Max",
        "planner": "GigaChat-2-Max",
        "worker": "GigaChat-2-Max",
        "interrupt_router": "GigaChat-2-Max",
        "validator": "GigaChat-2-Max",
        "suggestions_selector": "GigaChat-2-Pro",
        "summarizer": "GigaChat-2-Max",
        "responder": "GigaChat-2-Max",
        "default": "GigaChat-2-Max",
    }


class GigaChatSettings(BaseAppSettings):
    """GigaChat settings."""

    host: str = Field(
        validation_alias="GIGACHAT_HOST",
        default="gigachat-ift.sberdevices.delta.sbrf.ru",
    )
    port: str = Field(validation_alias="GIGACHAT_PORT", default="443")
    endpoint: str = Field(validation_alias="GIGACHAT_ENDPOINT", default="/v1")
    verify_ssl: bool = Field(validation_alias="GIGACHAT_VERIFY_SSL", default=True)
    scope: str = Field(validation_alias="GIGACHAT_SCOPE", default="GIGACHAT_API_PERS")
    api_key: str = Field(validation_alias="GIGACHAT_API_KEY", default="")
    model: str = Field(validation_alias="GIGACHAT_MODEL", default="GigaChat-2-Max")
    models: dict[str, str] = Field(
        validation_alias="GIGACHAT_MODELS",
        default_factory=_default_gigachat_models,
    )
    preview_models: dict[str, str] = Field(
        validation_alias="GIGACHAT_PREVIEW_MODELS",
        default_factory=dict,
    )
    preview_percent: float = Field(validation_alias="GIGACHAT_PREVIEW_PERCENT", default=0.0, ge=0.0, le=1.0)
    temperature: float = Field(validation_alias="GIGACHAT_TEMPERATURE", default=0.0, ge=0.0, le=2.0)
    timeout: float = Field(validation_alias="GIGACHAT_TIMEOUT", default=30, gt=0.0)
    profanity_check: bool = Field(validation_alias="GIGACHAT_PROFANITY_CHECK", default=False)
    # Reasoning у open-source моделей (glm-5.x и т.п.) на платформе включён по умолчанию.
    # False = выключать его через additional_fields для моделей из
    # THINKING_DISABLE_ADDITIONAL_FIELDS (orchestrator.llm.gigachat).
    enable_thinking: bool = Field(validation_alias="GIGACHAT_ENABLE_THINKING", default=False)
    max_attempts_default: int = Field(default=3, validation_alias="MAX_ATTEMPTS_DEFAULT")
    max_attempts_429: int = Field(default=5, validation_alias="MAX_ATTEMPTS_429")
    max_concurrent_requests: int = Field(default=4, validation_alias="MAX_CONCURRENT_REQUESTS")
    max_rps: int = Field(default=3, validation_alias="MAX_RPS")
    session_cache_per_node: bool = Field(validation_alias="GIGACHAT_SESSION_CACHE_PER_NODE", default=True)

    @field_validator("models", mode="before")
    @classmethod
    def validate_models_field(cls, value: Any, info: ValidationInfo) -> Any:
        return cls._parse_json_dict(value) or cls.model_fields[info.field_name].get_default(call_default_factory=True)

    @field_validator("preview_models", mode="before")
    @classmethod
    def validate_preview_models_field(cls, value: Any, info: ValidationInfo) -> Any:
        return cls._parse_json_dict(value) or cls.model_fields[info.field_name].get_default(call_default_factory=True)

    @model_validator(mode="after")
    def validate_file_path(self):
        for cert_filepath in [
            self.tls_cert_filepath,
            self.key_filepath,
            self.ca_bundle_filepath,
        ]:
            if not cert_filepath:
                continue
            if not os.path.exists(cert_filepath):
                raise ValueError(f"Path does not exist: {cert_filepath}!")
            if os.path.isdir(cert_filepath):
                raise ValueError(f"Path is a directory: {cert_filepath}!")
        return self

    @property
    def base_url(self) -> str:
        host = self.host.strip()
        port = f":{self.port}" if self.port else ""
        if host.startswith("http://") or host.startswith("https://"):
            base_url = f"{host}{port}{self.endpoint}"
        else:
            base_url = f"{self.protocol}://{host}{port}{self.endpoint}"
        return base_url

    @property
    def ssl_context(self) -> dict:
        result = {}
        ssl_context = self.get_ssl_context()
        if ssl_context:
            result["ssl_context"] = ssl_context
        return result

    @property
    def base_params(self) -> dict:
        """GigaChat language model parameters."""
        return {
            "base_url": self.base_url,
            "verify_ssl_certs": self.verify_ssl,
            "model": self.model,
            "temperature": self.temperature,
            "timeout": self.timeout,
            **self.ssl_context,
        }

    @property
    def embeddings_params(self) -> dict:
        """GigaChat embeddings parameters."""
        return {
            "base_url": self.base_url,
            "verify_ssl_certs": self.verify_ssl,
            "timeout": self.timeout,
            **self.ssl_context,
        }

    @staticmethod
    def _parse_json_dict(value: Any) -> dict | None:
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed_value = json.loads(value)
            except json.JSONDecodeError:
                parsed_value = None
            if isinstance(parsed_value, dict):
                return parsed_value
        return None


class OrchestratorSettings(BaseAppSettings):
    """Orchestrator settings."""

    agent_id: str = Field(default="orchestrator", validation_alias="ORCHESTRATOR_AGENT_ID")
    supported_content_types: list[str] = Field(
        default=["text", "text/plain"],
        validation_alias="SUPPORTED_CONTENT_TYPES",
    )
    default_agent_names: list[str] = Field(
        default=[
            "client-context-search-agent-service",
            "financial-analyst-ai-agent",
            "client-profile-composer",
        ],
        validation_alias="DEFAULT_AGENT_NAMES",
    )
    interval_seconds: int = Field(default=24 * 60 * 60, validation_alias="INTERVAL_SECONDS")
    initial_delay_seconds: int = Field(default=0, validation_alias="INITIAL_CRON_DELAY_SECONDS")
    artifacts_dir: str | None = Field(validation_alias="ORCHESTRATOR_ARTIFACTS_DIR", default="/opt/app-root/artifacts")

    @field_validator("supported_content_types", "default_agent_names", mode="before")
    @classmethod
    def validate_list_field(cls, value: Any, info: ValidationInfo) -> Any:
        correct_value = None
        if isinstance(value, list | tuple):
            correct_value = list(value)
        if isinstance(value, str):
            try:
                parsed_value = json.loads(value)
            except json.JSONDecodeError:
                parsed_value = None
            if isinstance(parsed_value, list):
                correct_value = parsed_value
        return correct_value or cls.model_fields[info.field_name].default


class AdapterSettings(BaseAppSettings):
    """Adapter settings."""

    url: str = Field(validation_alias="ADAPTER_URL", default="http://aigateway-mas-router-svc:8080")


class FeatureFlags(BaseAppSettings):
    """Feature toggles for application modules."""

    api_metrics_enabled: bool = Field(
        default=True, validation_alias="API_METRICS_ENABLED"
    )  # todo <cleanup> <P2> удалить неиспользуемый флаг
    # Точно не используется? src/aigw/api/__init__.py:43
    api_system_enabled: bool = Field(
        default=True, validation_alias="API_SYSTEM_ENABLED"
    )  # todo <cleanup> <P2> удалить неиспользуемый флаг
    # Точно не используется? src/aigw/api/__init__.py:45
    api_ui_enabled: bool = Field(default=True, validation_alias="API_UI_ENABLED")
    api_inspector_enabled: bool = Field(default=False, validation_alias="API_INSPECTOR_ENABLED")
    a2a_server_enabled: bool = Field(default=True, validation_alias="A2A_SERVER_ENABLED")
    a2a_client_enabled: bool = Field(default=True, validation_alias="A2A_CLIENT_ENABLED")
    adapter_enabled: bool = Field(default=True, validation_alias="ADAPTER_ENABLED")
    database_enabled: bool = Field(default=False, validation_alias="DATABASE_ENABLED")
    langfuse_enabled: bool = Field(default=False, validation_alias="LANGFUSE_ENABLED")
    mcp_client_enabled: bool = Field(default=True, validation_alias="MCP_CLIENT_ENABLED")


class SecretsSettings(BaseSettings):
    """Secrets collection."""

    ...


class Config:
    """Aggregated configuration instances."""

    app: AppSettings = AppSettings()
    log: LogSettings = LogSettings()
    gigachat: GigaChatSettings = GigaChatSettings()
    orchestrator: OrchestratorSettings = OrchestratorSettings()
    adapter: AdapterSettings = AdapterSettings()
    flags: FeatureFlags = FeatureFlags()
    secrets: SecretsSettings = SecretsSettings()
    langfuse: LangfuseSettings = LangfuseSettings()
    aef_tracing: AEFSettings = AEFSettings()


APP_CONFIG = Config()


__all__ = ["Config", "APP_CONFIG"]
