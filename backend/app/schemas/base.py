"""Базовый класс Pydantic-схем API."""

from pydantic import BaseModel, ConfigDict


class APIModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
