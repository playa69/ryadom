#!/usr/bin/env python3
"""Разовая миграция диалогов агента из старого SQLite-файла (PVC agent-data, образы < 0.8.0) в PostgreSQL.

Запускается с АДМИН-МАШИНЫ (в образе агента SQLite нет совсем), ей нужен psycopg:

    # 1. Забрать файл из пода (PVC ещё смонтирован):
    kubectl -n agent cp $(kubectl -n agent get pod -l app=agent -o name | cut -d/ -f2):/data/dialogs.sqlite3 /tmp/dialogs.sqlite3
    # 2. Порт-форвард PostgreSQL:
    kubectl -n ryadom-db port-forward svc/ryadom-db-rw 55432:5432
    # 3. Прогон (macOS/Linux, uv подтянет psycopg сам):
    uv run --with 'psycopg[binary]' k8s/agent/migrate_dialogs_sqlite_to_pg.py \
        /tmp/dialogs.sqlite3 "postgresql://agent:<пароль>@localhost:55432/agent"

Что переносится: диалоги с сообщениями и идентификаторами клиента, выбор голоса. Расход моделей (model_usage)
переносится, только если в целевой базе его ещё нет (у таблицы нет ключа — повторный прогон не смог бы отличить
свои строки). Факты и согласия SQLite-памяти НЕ переносятся: память агента — Cognee, согласие заводится заново
в профиле (решение владельца).

Идемпотентно: диалоги, сообщения и выбор голоса пишутся upsert'ом, повторный запуск ничего не дублирует.
Скрипт только добавляет данные, из SQLite не удаляет — файл остаётся как копия до удаления PVC.
В конце — сверка счётчиков: пока они не сошлись, PVC не трогать.
"""

import argparse
import sqlite3
import sys

import psycopg


def clean(value):
    """Непарный суррогат (оборванная половина эмодзи) не кодируется в UTF-8 и ронял бы вставку — заменяем на «?»."""
    return value.encode("utf-8", "replace").decode("utf-8") if isinstance(value, str) else value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("sqlite_path")
    parser.add_argument("dsn")
    args = parser.parse_args()

    src = sqlite3.connect(f"file:{args.sqlite_path}?mode=ro", uri=True)
    pg = psycopg.connect(args.dsn, connect_timeout=10, application_name="agent-migrate", autocommit=True)

    dialogs = src.execute(
        "SELECT id, user_id, started_at, ended_at, summary, greeting, voice, reply_index, memory_mode, crisis_seen "
        "FROM dialogs"
    ).fetchall()
    messages = src.execute(
        "SELECT id, dialog_id, position, role, text, created_at, audio_seconds FROM messages"
    ).fetchall()
    client_ids = src.execute("SELECT dialog_id, client_id, message_id FROM client_ids").fetchall()
    prefs = src.execute("SELECT user_id, voice FROM voice_prefs").fetchall()
    usage_count = src.execute("SELECT COUNT(*) FROM model_usage").fetchone()[0]
    print(f"sqlite: диалогов {len(dialogs)}, сообщений {len(messages)}, расход {usage_count}")

    with pg.cursor() as cur, cur.connection.transaction():
        cur.executemany(
            "INSERT INTO dialogs (id, user_id, started_at, ended_at, summary, greeting, voice, reply_index, "
            "memory_mode, crisis_seen) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "ended_at = EXCLUDED.ended_at, summary = EXCLUDED.summary, greeting = EXCLUDED.greeting, "
            "voice = EXCLUDED.voice, reply_index = EXCLUDED.reply_index, "
            "crisis_seen = GREATEST(dialogs.crisis_seen, EXCLUDED.crisis_seen)",
            [tuple(clean(v) for v in row) for row in dialogs],
        )
        cur.executemany(
            "INSERT INTO messages (id, dialog_id, position, role, text, created_at, audio_seconds) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (dialog_id, id) DO UPDATE SET "
            "text = EXCLUDED.text, position = EXCLUDED.position, audio_seconds = EXCLUDED.audio_seconds",
            [tuple(clean(v) for v in row) for row in messages],
        )
        cur.executemany(
            "INSERT INTO client_ids (dialog_id, client_id, message_id) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            [tuple(clean(v) for v in row) for row in client_ids],
        )
        cur.executemany(
            "INSERT INTO voice_prefs (user_id, voice) VALUES (%s, %s) "
            "ON CONFLICT (user_id) DO UPDATE SET voice = EXCLUDED.voice",
            [tuple(clean(v) for v in row) for row in prefs],
        )
        pg_usage = pg.execute("SELECT COUNT(*) FROM model_usage").fetchone()[0]
        if usage_count and pg_usage == 0:
            usage = src.execute(
                "SELECT dialog_id, message_id, created_at, model, task, direction, modality, unit, amount FROM model_usage"
            ).fetchall()
            cur.executemany(
                "INSERT INTO model_usage (dialog_id, message_id, created_at, model, task, direction, modality, unit, "
                "amount) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [tuple(clean(v) for v in row) for row in usage],
            )
            print(f"расход моделей: перенесено {len(usage)} строк")
        elif usage_count:
            print(f"расход моделей: в целевой базе уже {pg_usage} строк, пропускаю (в sqlite их {usage_count})")

    pg_dialogs = pg.execute("SELECT COUNT(*) FROM dialogs").fetchone()[0]
    pg_messages = pg.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    print(f"сверка: sqlite {len(dialogs)}/{len(messages)}, postgres {pg_dialogs}/{pg_messages}")
    if (len(dialogs), len(messages)) != (pg_dialogs, pg_messages):
        sys.exit("НЕ СОШЛОСЬ: счётчики sqlite и postgres различаются — разобраться до удаления PVC")
    print("OK: счётчики совпали, PVC можно отключать")


if __name__ == "__main__":
    main()
