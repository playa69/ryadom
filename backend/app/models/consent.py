from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.user import User


class ConsentKind:
    AGE_CONFIRMATION = "age_confirmation"
    DISCLAIMER = "disclaimer"
    OFFER = "offer"

    ALL = (AGE_CONFIRMATION, DISCLAIMER, OFFER)


class Consent(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "consents"
    __table_args__ = (sa.UniqueConstraint("user_id", "kind"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    version: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship(back_populates="consents")
