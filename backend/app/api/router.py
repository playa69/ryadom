"""Сборка API-роутеров v1."""

from fastapi import APIRouter

from app.api.v1 import auth, users

api_v1_router = APIRouter()
api_v1_router.include_router(auth.router)
api_v1_router.include_router(users.router)
