from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAtMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.user import User


class Device(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    __tablename__ = "devices"
    __table_args__ = (sa.UniqueConstraint("user_id", "device_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    device_id: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    platform: Mapped[str | None] = mapped_column(sa.String(16), nullable=True)
    app_version: Mapped[str | None] = mapped_column(sa.String(32), nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship(back_populates="devices")
