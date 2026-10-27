"""Базовый асинхронный REST API коннектор с retry и health-check."""

import logging
import ssl
from abc import abstractmethod
from http import HTTPStatus
from ssl import SSLContext
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp
import tenacity
from tenacity.stop import stop_base
from tenacity.wait import wait_base

from aigw_service.logger.utils import format_body_meta

from modules.core import BaseAsyncInterface
from modules.core import ClientError, RetryError, ServerError
from modules.core import HealthCheckError


class BaseRESTApiAsyncConnector(BaseAsyncInterface):
    """Базовый класс для асинхронных REST API клиентов.

    Args:
        base_url: Базовый URL целевого API.
        logger: Логгер.
        retry_stop: Максимальное количество попыток повторных запросов
            или готовый объект стратегии остановки из tenacity.stop.
        retry_wait: Интервал ожидания между попытками (в секундах)
            или готовый объект стратегии ожидания из tenacity.wait.
        request_timeout: Таймаут запроса по умолчанию.
        debug_mode: Режим отладки (если ``True``, пропускает проверку здоровья).
        ca_bundle: Путь до сертификата-цепочки.
        client_cert: Путь до клиентского сертификата.
        client_key: Путь до клиентского ключа.
        ssl_context: SSL-контекст для безопасного соединения.
    """

    @property
    def post_method(self) -> Callable[..., Any]:
        """HTTP метод POST из aiohttp."""
        return self._session.post

    @property
    def put_method(self) -> Callable[..., Any]:
        """HTTP метод PUT из aiohttp."""
        return self._session.put

    @property
    def delete_method(self) -> Callable[..., Any]:
        """HTTP метод DELETE из aiohttp."""
        return self._session.delete

    @property
    def patch_method(self) -> Callable[..., Any]:
        """HTTP метод PATCH из aiohttp."""
        return self._session.patch

    @property
    def get_method(self) -> Callable[..., Any]:
        """HTTP метод GET из aiohttp."""
        return self._session.get

    # pylint: disable=R0917
    def __init__(
        self,
        base_url: str,
        logger: logging.Logger,
        retry_stop: int | stop_base,
        retry_wait: float | int | wait_base,
        request_timeout: int = 10,
        debug_mode: bool = False,
        ca_bundle: str | None = None,
        client_cert: str | None = None,
        client_key: str | None = None,
        ssl_context: SSLContext | None = None,
    ) -> None:
        """Инициализирует асинхронного REST API клиента.

        Args:
            base_url: Базовый URL целевого API.
            logger: Логгер.
            retry_stop: Максимальное количество попыток повторных запросов
                или готовый объект стратегии остановки из tenacity.stop.
            retry_wait: Интервал ожидания между попытками (в секундах)
                или готовый объект стратегии ожидания из tenacity.wait.
            request_timeout: Таймаут запроса по умолчанию.
            debug_mode: Режим отладки (если ``True``, пропускает проверку здоровья).
            ca_bundle: Путь до сертификата-цепочки.
            client_cert: Путь до клиентского сертификата.
            client_key: Путь до клиентского ключа.
            ssl_context: SSL-контекст для безопасного соединения.
        """
        self.logger = logger

        self._session: aiohttp.ClientSession | None = None

        self._ssl_ctx: SSLContext | bool = False

        if ssl_context:
            self._ssl_ctx = ssl_context
        elif ca_bundle:
            self._ssl_ctx = ssl.create_default_context(cafile=ca_bundle)
            self._ssl_ctx.check_hostname = False
            self._ssl_ctx.verify_mode = ssl.CERT_OPTIONAL
            _client_certs = (client_cert, client_key)

            if all(_client_certs):
                self._ssl_ctx.load_cert_chain(*_client_certs)

        self.base_url = base_url
        self.request_timeout = request_timeout

        self._debug_mode = debug_mode

        if isinstance(retry_stop, int):
            stop_strategy = tenacity.stop_after_attempt(max_attempt_number=retry_stop)
        else:
            stop_strategy = retry_stop

        if isinstance(retry_wait, (int, float)):
            wait_strategy = tenacity.wait_incrementing(start=retry_wait, increment=retry_wait)
        else:
            wait_strategy = retry_wait

        self.call_retry = tenacity.retry(
            stop=stop_strategy,
            after=tenacity.after_log(self.logger, logging.getLevelName(logging.DEBUG)),
            before=tenacity.before_log(self.logger, logging.getLevelName(logging.DEBUG)),
            retry=tenacity.retry_if_exception_type((ServerError, TimeoutError, RetryError)),
            wait=wait_strategy,
            reraise=True,
        )

    @abstractmethod
    async def success_response_status_validation(self, response: aiohttp.ClientResponse) -> dict | None:
        """Абстрактный метод обработки успешных ответов API (200 ≤ статус < 400).

        Должен быть реализован в дочерних классах.

        Args:
            response: Объект ответа от сервера.

        Returns:
            Результат обработки ответа: словарь с данными или ``None``.
        """
        pass

    @abstractmethod
    async def health_check(self) -> None:
        """Абстрактный метод проверки работоспособности API.

        Raises:
            HealthCheckError: Если API недоступно.
        """
        pass

    async def make_request(
        self,
        request_func: Callable[..., Any],
        url: str,
        headers: dict[str, str],
        *args: Any,
        extra_timeout: int = 0,
        **kwargs: Any,
    ) -> dict | None:
        """Выполняет HTTP запрос с обработкой ошибок и попытками повторных запросов.

        Args:
            request_func: HTTP метод из aiohttp (POST, GET, PUT и т.д.).
            url: Конечная точка API (относительный путь).
            headers: Заголовки HTTP запроса.
            extra_timeout: Дополнительный таймаут к базовому.
            *args: Позиционные аргументы для request_func.
            **kwargs: Ключевые аргументы для request_func.

        Returns:
            Результат вызова ``success_response_status_validation``.

        Raises:
            ServerError: При ошибках сервера (status ≥ 500).
            ClientError: При ошибках клиента (400 ≤ status < 500).
            TimeoutError: При превышении таймаута запроса.
            RetryError: При исчерпании лимита повторных запросов.
        """
        timeout = self.request_timeout + extra_timeout
        _ = self._resolve_method_name(request_func)
        full_url, host = self._resolve_request_target(url)

        # Propagate trace-id and request-time to downstream services
        from datetime import datetime
        from aigw_service.context import APP_CTX

        rq_uid = APP_CTX.get_context_vars_container().context_vars.rqUId
        if rq_uid:
            headers = {**headers, "x-trace-id": rq_uid}
        headers = {**headers, "x-request-time": datetime.now(APP_CTX.get_pytz_timezone()).isoformat()}

        body_meta = self._body_meta(*args, **kwargs)

        @self.call_retry
        async def _make_request() -> dict | None:
            self.logger.info(
                f"Отправлен запрос в {host}",
                serviceType=f"Отправлен запрос в {host}",
                args={"headers": dict(headers), "message": f"url={full_url} {body_meta}"},
                message_type="outbound_request",
            )
            async with request_func(url, *args, timeout=timeout, headers=headers, **kwargs) as response:
                self.logger.info(
                    f"Получен ответ от {host}",
                    serviceType=f"Получен ответ от {host}",
                    args={"headers": dict(headers), "message": f"status={response.status}"},
                    message_type="outbound_response",
                )
                if HTTPStatus.OK <= response.status < HTTPStatus.BAD_REQUEST:
                    result = await self.success_response_status_validation(response)
                    self.logger.info(
                        f"Response payload from {host}",
                        serviceType=f"Получен ответ от {host}",
                        args={"headers": dict(headers), "message": self._describe_payload(result)},
                        message_type="outbound_response",
                    )
                    return result

                details = await response.text()

                if response.status == HTTPStatus.TOO_MANY_REQUESTS:
                    self.logger.error(
                        f"Too Many Requests from {host}",
                        serviceType=f"Получен ответ от {host}",
                        args={
                            "headers": dict(headers),
                            "message": f"status={response.status} url={full_url} details={details}",
                        },
                        message_type="outbound_response",
                    )
                    raise RetryError(response.status, url, details)

                if response.status >= HTTPStatus.INTERNAL_SERVER_ERROR:
                    self.logger.error(
                        f"Server Error from {host}",
                        serviceType=f"Получен ответ от {host}",
                        args={
                            "headers": dict(headers),
                            "message": f"status={response.status} url={full_url} details={details}",
                        },
                        message_type="outbound_response",
                    )
                    raise ServerError(response.status, details, url)

                self.logger.error(
                    f"Client Error from {host}",
                    serviceType=f"Получен ответ от {host}",
                    args={
                        "headers": dict(headers),
                        "message": f"status={response.status} url={full_url} details={details}",
                    },
                    message_type="outbound_response",
                )
                raise ClientError(response.status, details, url)

        return await _make_request()

    @staticmethod
    def _body_meta(*args: Any, **kwargs: Any) -> str:
        """Возвращает мета-информацию о body: длину и ключи (без значений)."""
        data = kwargs.get("json") or kwargs.get("data")
        return format_body_meta(data)

    @staticmethod
    def _resolve_method_name(request_func: Callable[..., Any]) -> str:
        """Определяет имя HTTP метода по вызываемому объекту."""
        method_name = getattr(request_func, "__name__", None)
        if isinstance(method_name, str) and method_name:
            return method_name.upper()
        return request_func.__class__.__name__.upper()

    def _resolve_request_target(self, url: str) -> tuple[str, str]:
        """Формирует полный URL и определяет хост целевого сервиса."""
        if str(url).startswith(("http://", "https://")):
            full_url = str(url)
        else:
            full_url = urljoin(f"{self.base_url.rstrip('/')}/", str(url).lstrip("/"))
        host = urlparse(full_url).netloc or self.base_url
        return full_url, host

    @staticmethod
    def _describe_payload(payload: dict | list | None) -> str:
        """Формирует краткое описание полезной нагрузки ответа для логирования."""
        if payload is None:
            return "payload=None"
        if isinstance(payload, list):
            return f"payload=list len={len(payload)}"
        if not isinstance(payload, dict):
            return f"payload={type(payload).__name__}"

        parts = [f"keys={sorted(str(key) for key in payload.keys())}"]

        result = payload.get("result")
        if isinstance(result, dict):
            parts.append(f"result_keys={sorted(str(key) for key in result.keys())}")

        hits = payload.get("hits")
        if isinstance(hits, dict):
            raw_hits = hits.get("hits")
            if isinstance(raw_hits, list):
                parts.append(f"hits={len(raw_hits)}")

            total = hits.get("total")
            if isinstance(total, dict):
                total = total.get("value")
            if isinstance(total, int):
                parts.append(f"total={total}")

        return "payload=dict " + " ".join(parts)

    async def init_session(self) -> None:
        """Инициализирует клиентскую сессию.

        Raises:
            aiohttp.ClientConnectionError: Если произошла ошибка подключения к API.
        """
        self.logger.info("HTTP client session initialization")
        try:
            self._session = aiohttp.ClientSession(
                base_url=self.base_url,
                connector=aiohttp.TCPConnector(ssl=self._ssl_ctx),
            )
        except aiohttp.ClientConnectionError as exc:
            self.logger.error(f"HTTP client session with '{self.base_url}' was failed: {exc}")
            raise

    async def on_startup(self) -> None:
        """Инициализирует клиентскую сессию и проверяет работоспособность API.

        Raises:
            aiohttp.ClientConnectionError: Если произошла ошибка подключения к API.
            HealthCheckError: Если API недоступно.
        """
        self.logger.info(f"HTTP client session with '{self.base_url}' startup")
        try:
            await self.init_session()
            if not self._debug_mode:
                await self.health_check()
            self.logger.info(f"HTTP client session with '{self.base_url}' has started")
        except (aiohttp.ClientConnectionError, HealthCheckError) as exc:
            self.logger.error(f"HTTP client startup session with '{self.base_url}' failed: {exc}")
            await self._safe_close()
            raise

    async def on_shutdown(self) -> None:
        """Закрывает клиентскую сессию при остановке приложения."""
        self.logger.info(f"HTTP client session with '{self.base_url}' shutdown")
        await self._safe_close()

    async def _safe_close(self) -> None:
        """Безопасно закрывает клиентскую сессию."""
        self.logger.info("HTTP client session closing")
        if not self._session:
            self.logger.warning(f"HTTP client session with '{self.base_url}' has not started")
            return
        try:
            await self._session.close()
            self.logger.info(f"HTTP client session with '{self.base_url}' has stopped")
        except Exception as exc:
            self.logger.error(f"HTTP client session with '{self.base_url}' error closing: {exc}")
        finally:
            self._session = None
