from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAtMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.user import User


class IdentityKind:
    DEVICE = "device"
    EMAIL = "email"


class AuthIdentity(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """Способ входа пользователя (design.md D2): device или email."""

    __tablename__ = "auth_identities"
    __table_args__ = (sa.UniqueConstraint("kind", "identifier"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    identifier: Mapped[str] = mapped_column(sa.String(320), nullable=False)
    secret_hash: Mapped[str] = mapped_column(sa.String(255), nullable=False)

    user: Mapped[User] = relationship(back_populates="identities")
