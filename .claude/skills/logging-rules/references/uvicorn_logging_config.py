"""Конфигурация логирования uvicorn для приложения."""

LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": "uvicorn.logging.DefaultFormatter",
            "fmt": "%(levelname)-7s | %(asctime)s.%(msecs)03d | %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S",
        }
    },
    "handlers": {
        "default": {
            "formatter": "default",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
        }
    },
    "loggers": {
        "uvicorn": {
            "handlers": ["default"],
            "level": "INFO",
            "propagate": False,
        },
        # httpx логгер отвечает за логирование langchain
        "httpx": {
            "handlers": ["default"],
            "level": "WARNING",
            "propagate": False,
        },
    },
}
