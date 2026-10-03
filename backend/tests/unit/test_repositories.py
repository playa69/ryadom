"""Юнит-тесты репозиториев на тестовой БД (задачи 3.1–3.3)."""

import uuid
from datetime import UTC, datetime, timedelta

from app.core.security import hash_token
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.auth_repository import AuthRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import AuthIdentityRepository, UserRepository
from app.services.anti_spam_service import build_contact_handles


async def test_create_user_with_device_identity_and_find(db_session):
    users = UserRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-1", secret_hash="hash-1"
    )
    await db_session.commit()

    found = await users.get_by_identity("device", "dev-1")
    assert found is not None
    assert found.id == user.id
    assert found.is_active
    # Поиск по email-identity того же пользователя — пусто
    assert await users.get_by_identity("email", "dev-1") is None


async def test_get_user_by_email_identity(db_session):
    users = UserRepository(db_session)
    identities = AuthIdentityRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-2", secret_hash="hash-1"
    )
    await identities.create(
        user_id=user.id, kind="email", identifier="u@example.com", secret_hash="hash-2"
    )
    await db_session.commit()

    found = await users.get_by_identity("email", "u@example.com")
    assert found is not None and found.id == user.id
    assert await users.get_by_id(user.id) is not None


async def test_upsert_device(db_session):
    users = UserRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-3", secret_hash="hash-1"
    )
    first = await users.upsert_device(
        user_id=user.id, device_id="dev-3", platform="ios", app_version="1.0"
    )
    second = await users.upsert_device(
        user_id=user.id, device_id="dev-3", app_version="1.1"
    )
    await db_session.commit()
    assert first.id == second.id
    assert second.platform == "ios"
    assert second.app_version == "1.1"


async def test_auth_repository_refresh_lifecycle(db_session):
    users = UserRepository(db_session)
    auth = AuthRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-4", secret_hash="hash-1"
    )
    token_hash = hash_token("refresh-token-value")
    await auth.create_refresh_token(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=datetime.now(UTC) + timedelta(days=30),
        device_id="dev-4",
    )
    await db_session.commit()

    active = await auth.get_active_refresh_token(token_hash)
    assert active is not None
    assert active.device_id == "dev-4"

    await auth.revoke_refresh_token(active)
    await db_session.commit()
    assert await auth.get_active_refresh_token(token_hash) is None
    by_hash = await auth.get_refresh_token_by_hash(token_hash)
    assert by_hash is not None and by_hash.revoked_at is not None


async def test_auth_repository_revoke_all_for_user(db_session):
    users = UserRepository(db_session)
    auth = AuthRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-5", secret_hash="hash-1"
    )
    hashes = [hash_token(f"t{i}") for i in range(3)]
    for h in hashes:
        await auth.create_refresh_token(
            user_id=user.id, token_hash=h, expires_at=datetime.now(UTC) + timedelta(days=30)
        )
    await db_session.commit()
    await auth.revoke_refresh_tokens_for_user(user.id)
    await db_session.commit()
    for h in hashes:
        assert await auth.get_active_refresh_token(h) is None


async def test_auth_repository_password_reset_tokens(db_session):
    users = UserRepository(db_session)
    auth = AuthRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-6", secret_hash="hash-1"
    )
    old_hash = hash_token("old-reset")
    await auth.create_password_reset_token(
        user_id=user.id, token_hash=old_hash, expires_at=datetime.now(UTC) + timedelta(minutes=30)
    )
    await db_session.commit()

    # Новый запрос инвалидирует предыдущие токены
    await auth.invalidate_active_password_reset_tokens(user.id)
    await db_session.commit()
    assert await auth.get_active_password_reset_token(old_hash) is None

    new_hash = hash_token("new-reset")
    reset = await auth.create_password_reset_token(
        user_id=user.id, token_hash=new_hash, expires_at=datetime.now(UTC) + timedelta(minutes=30)
    )
    await db_session.commit()
    assert await auth.get_active_password_reset_token(new_hash) is not None

    await auth.mark_password_reset_token_used(reset)
    await db_session.commit()
    assert await auth.get_active_password_reset_token(new_hash) is None


async def test_expired_refresh_token_not_active(db_session):
    users = UserRepository(db_session)
    auth = AuthRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-7", secret_hash="hash-1"
    )
    expired_hash = hash_token("expired")
    await auth.create_refresh_token(
        user_id=user.id,
        token_hash=expired_hash,
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    await db_session.commit()
    assert await auth.get_active_refresh_token(expired_hash) is None


async def test_audit_log_repository_masked_contact(db_session):
    audits = AuditLogRepository(db_session)
    (handle,) = build_contact_handles(email="secret.person@example.com")
    await audits.create(
        action="auth.email_login.failed",
        entity_type="contact",
        entity_id=handle.entity_id,
        ip="1.2.3.4",
        user_agent="ios/1.0",
        payload={"email_masked": handle.masked_value},
    )
    await db_session.commit()

    count = await audits.count_recent(
        actions=("auth.email_login.failed",),
        entity_type="contact",
        entity_id=handle.entity_id,
        since=datetime.now(UTC) - timedelta(minutes=1),
    )
    assert count == 1


async def test_consent_repository(db_session):
    users = UserRepository(db_session)
    consents = ConsentRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier="dev-8", secret_hash="hash-1"
    )
    await db_session.commit()

    assert await consents.get_kinds(user.id) == set()
    assert not await consents.has_all_required(user.id)

    await consents.upsert(user_id=user.id, kind="age_confirmation", version="1")
    await consents.upsert(user_id=user.id, kind="disclaimer", version="1")
    await consents.upsert(user_id=user.id, kind="offer", version="2026-09-01")
    await db_session.commit()

    kinds = await consents.get_kinds(user.id)
    assert kinds == {"age_confirmation", "disclaimer", "offer"}
    assert await consents.has_all_required(user.id)

    # Повторная фиксация — обновление версии, без дубликата
    await consents.upsert(user_id=user.id, kind="offer", version="2026-10-01")
    await db_session.commit()
    assert len(await consents.get_kinds(user.id)) == 3
