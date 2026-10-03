"""Юнит-тесты app/core/security.py (задача 4.1)."""

from datetime import timedelta

import pytest

from app.core.security import (
    JWTTokenType,
    TokenValidationError,
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    decode_and_validate_jwt,
    hash_password,
    hash_token,
    verify_password,
)


def test_create_and_validate_access_token():
    issued = create_access_token("user-uuid-1")
    assert issued.expires_in == 900  # 15 минут по спецификации
    payload = decode_and_validate_jwt(issued.token)
    assert payload.sub == "user-uuid-1"
    assert payload.token_type == JWTTokenType.ACCESS


def test_expired_token_rejected():
    issued = create_access_token("user-uuid-1", expires_delta=timedelta(seconds=-1))
    with pytest.raises(TokenValidationError, match="expired"):
        decode_and_validate_jwt(issued.token)


def test_tampered_token_rejected():
    issued = create_access_token("user-uuid-1")
    with pytest.raises(TokenValidationError, match="invalid"):
        decode_and_validate_jwt(issued.token + "tampered")


def test_token_without_required_claims_rejected():
    import jwt as pyjwt

    from app.core.config import APP_CONFIG

    token = pyjwt.encode(
        {"sub": "x"}, APP_CONFIG.jwt.secret_key.get_secret_value(), algorithm="HS256"
    )
    with pytest.raises(TokenValidationError):
        decode_and_validate_jwt(token)


def test_argon2_hash_and_verify():
    password_hash = hash_password("s3cret-password")
    assert password_hash.startswith("$argon2")
    assert verify_password("s3cret-password", password_hash)
    assert not verify_password("wrong-password", password_hash)


def test_refresh_token_entropy_and_hash():
    issued = create_refresh_token()
    assert len(issued.token) >= 48
    assert issued.expires_in == 30 * 24 * 3600
    token_hash = hash_token(issued.token)
    assert len(token_hash) == 64
    assert hash_token(issued.token) == token_hash
    assert token_hash != issued.token


def test_password_reset_token():
    issued = create_password_reset_token()
    assert len(issued.token) >= 32
    assert issued.expires_in == 30 * 60
