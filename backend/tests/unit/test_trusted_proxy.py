"""Юнит-тесты trusted-proxy XFF (задача 1.9)."""

from unittest.mock import patch

from fastapi import Request

from app.api.deps import _is_trusted_proxy, get_request_security_context


def _make_request(
    *,
    client_host: str | None = "10.0.0.5",
    xff: str | None = None,
    x_real_ip: str | None = None,
    user_agent: str | None = "test-agent/1.0",
) -> Request:
    headers = []
    if xff is not None:
        headers.append((b"x-forwarded-for", xff.encode()))
    if x_real_ip is not None:
        headers.append((b"x-real-ip", x_real_ip.encode()))
    if user_agent is not None:
        headers.append((b"user-agent", user_agent.encode()))
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": headers,
        "client": (client_host, 12345) if client_host else None,
    }
    return Request(scope)


class TestIsTrustedProxy:
    def test_plain_ip_match(self):
        assert _is_trusted_proxy("10.1.2.3", ["10.1.2.3"])

    def test_cidr_match(self):
        assert _is_trusted_proxy("10.112.133.5", ["10.112.128.0/17"])

    def test_no_match(self):
        assert not _is_trusted_proxy("192.168.1.1", ["10.112.128.0/17"])

    def test_empty_config(self):
        assert not _is_trusted_proxy("10.112.133.5", [])

    def test_invalid_direct_host(self):
        assert not _is_trusted_proxy("not-an-ip", ["10.112.128.0/17"])

    def test_broken_cidr_entry_skipped(self):
        # Битая запись не роняет проверку и не даёт доверия
        assert not _is_trusted_proxy("10.112.133.5", ["999.999.0.0/8"])
        # ...но валидная запись после битой всё ещё работает
        assert _is_trusted_proxy("10.112.133.5", ["broken", "10.112.128.0/17"])


class TestGetRequestSecurityContext:
    def test_trusted_proxy_uses_last_xff_entry(self):
        request = _make_request(
            client_host="10.112.133.5",
            xff="1.2.3.4, 5.6.7.8",
        )
        with patch("app.api.deps.APP_CONFIG") as config:
            config.app.trusted_proxy_ips = ["10.112.128.0/17"]
            context = get_request_security_context(request)
        # Последний адрес цепочки — дописан доверенным edge-прокси
        assert context.ip_address == "5.6.7.8"
        assert context.user_agent == "test-agent/1.0"

    def test_untrusted_source_xff_ignored(self):
        request = _make_request(client_host="203.0.113.9", xff="1.2.3.4")
        with patch("app.api.deps.APP_CONFIG") as config:
            config.app.trusted_proxy_ips = ["10.112.128.0/17"]
            context = get_request_security_context(request)
        assert context.ip_address == "203.0.113.9"

    def test_xff_spoof_first_entries_ignored(self):
        # Клиент подделал первые записи XFF — берётся только последняя
        request = _make_request(
            client_host="10.112.133.5",
            xff="6.6.6.6, 198.51.100.23",
        )
        with patch("app.api.deps.APP_CONFIG") as config:
            config.app.trusted_proxy_ips = ["10.112.128.0/17"]
            context = get_request_security_context(request)
        assert context.ip_address == "198.51.100.23"

    def test_trusted_proxy_x_real_ip(self):
        request = _make_request(client_host="10.112.133.5", x_real_ip="198.51.100.7")
        with patch("app.api.deps.APP_CONFIG") as config:
            config.app.trusted_proxy_ips = ["10.112.128.0/17"]
            context = get_request_security_context(request)
        assert context.ip_address == "198.51.100.7"

    def test_no_client_unknown(self):
        request = _make_request(client_host=None)
        with patch("app.api.deps.APP_CONFIG") as config:
            config.app.trusted_proxy_ips = []
            context = get_request_security_context(request)
        assert context.ip_address == "unknown"
