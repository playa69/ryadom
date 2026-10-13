"""Собирает понятный Word-отчёт (.docx) по результатам прогона Locust.

Читает CSV, которые Locust пишет с флагом --csv=<prefix>:
  <prefix>_stats.csv           — агрегаты по метрикам за весь прогон;
  <prefix>_stats_history.csv   — те же метрики по 5-секундным срезам.

Запуск:
  python report.py out/run1            # префикс, как в --csv
  python report.py out/run1 --title "Прогон 10 RPS" -o out/otchet.docx
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.shared import Pt

# Метрики и их человекочитаемые описания для отчёта.
METRIC_TITLES = {
    "REST start_dialog": "Старт диалога (REST)",
    "REST refresh": "Обновление access-токена (REST)",
    "WS connect": "Подключение WebSocket",
    "WS connect+hello": "Подключение WebSocket + hello (аутентификация)",
    "WS turn ttft": "Ход диалога: время до первого ответа LLM (TTFT)",
    "WS turn streaming": "Ход диалога: стриминг текста (искусственный, ~60 мс/слово)",
    "WS turn tts": "Ход диалога: генерация и приём озвучки (TTS)",
    "WS turn total": "Ход диалога: полное время ответа",
}

# Пороги для автоматических выводов (мс).
SLO = {
    "WS turn ttft": {"good": 8000, "ok": 15000},
    "WS turn total": {"good": 30000, "ok": 55000},
    "WS connect": {"good": 500, "ok": 1500},
    "WS connect+hello": {"good": 800, "ok": 2000},
    "REST start_dialog": {"good": 300, "ok": 1000},
    "REST refresh": {"good": 300, "ok": 1000},
}


def read_stats(prefix: str) -> list[dict[str, str]]:
    """Читает <prefix>_stats.csv в список строк-словарей."""
    with open(f"{prefix}_stats.csv", newline="", encoding="utf-8") as fh:
        return [row for row in csv.DictReader(fh) if row.get("Name") not in (None, "Aggregated")]


def read_history(prefix: str) -> list[dict[str, str]]:
    """Читает <prefix>_stats_history.csv; пусто, если файла нет."""
    path = Path(f"{prefix}_stats_history.csv")
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def verdict(metric: str, p95: float, errors: int, requests: int) -> str:
    """Формирует текстовый вывод по одной метрике."""
    error_rate = errors / requests * 100 if requests else 0
    if requests == 0:
        return "запросов не было"
    if error_rate > 1:
        return f"ПЛОХО: ошибок {error_rate:.1f}%"
    slo = SLO.get(metric)
    if slo is None:
        return f"ошибок {error_rate:.2f}%"
    if p95 <= slo["good"]:
        return "отлично"
    if p95 <= slo["ok"]:
        return "приемлемо"
    return f"медленно (p95 выше целевых {slo['ok'] / 1000:.0f} с)"


def fmt_ms(value: str) -> str:
    """Форматирует миллисекунды: 1234 -> '1.23 с', 123 -> '123 мс'."""
    ms = float(value)
    return f"{ms / 1000:.2f} с" if ms >= 1000 else f"{ms:.0f} мс"


def build_report(prefix: str, title: str, output: str) -> None:
    """Собирает .docx-отчёт по CSV-префиксу прогона."""
    stats = read_stats(prefix)
    history = read_history(prefix)

    doc = Document()
    doc.add_heading(f"Нагрузочное тестирование агента «Слышу Рядом»", level=0)
    doc.add_paragraph(title)
    doc.add_paragraph(f"Дата формирования отчёта: {datetime.now():%d.%m.%Y %H:%M}")

    if history:
        first_ts = int(history[0]["Timestamp"])
        last_ts = int(history[-1]["Timestamp"])
        duration_min = (last_ts - first_ts) / 60
        max_users = max(int(row["User Count"]) for row in history)
        doc.add_paragraph(
            f"Длительность прогона: {duration_min:.0f} мин, "
            f"пиковое число виртуальных пользователей: {max_users}."
        )

    doc.add_heading("1. Сводная статистика", level=1)
    table = doc.add_table(rows=1, cols=8)
    table.style = "Light Grid Accent 1"
    headers = ["Метрика", "Запросов", "Ошибок", "Среднее", "p50", "p95", "p99", "Макс"]
    for i, text in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = text
        cell.paragraphs[0].runs[0].font.bold = True
        cell.paragraphs[0].runs[0].font.size = Pt(9)

    aggregated: dict[str, str] | None = None
    for row in stats:
        cells = table.add_row().cells
        name = row["Name"]
        cells[0].text = METRIC_TITLES.get(name, name)
        cells[1].text = row["Request Count"]
        cells[2].text = row["Failure Count"]
        cells[3].text = fmt_ms(row["Average Response Time"])
        cells[4].text = fmt_ms(row["50%"])
        cells[5].text = fmt_ms(row["95%"])
        cells[6].text = fmt_ms(row["99%"])
        cells[7].text = fmt_ms(row["Max Response Time"])
        for cell in cells[1:]:
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(9)

    with open(f"{prefix}_stats.csv", newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row.get("Name") == "Aggregated":
                aggregated = row

    if aggregated:
        doc.add_paragraph(
            f"Всего событий: {aggregated['Request Count']}, "
            f"ошибок: {aggregated['Failure Count']}, "
            f"средняя интенсивность: {float(aggregated['Requests/s']):.2f} RPS."
        )

    doc.add_heading("2. Выводы по метрикам", level=1)
    for row in stats:
        name = row["Name"]
        text = verdict(
            name,
            float(row["95%"]),
            int(row["Failure Count"]),
            int(row["Request Count"]),
        )
        paragraph = doc.add_paragraph(style="List Bullet")
        paragraph.add_run(f"{METRIC_TITLES.get(name, name)}: ").bold = True
        paragraph.add_run(
            f"p95 = {fmt_ms(row['95%'])}, ошибок {row['Failure Count']} — {text}."
        )

    doc.add_heading("3. Как читать отчёт", level=1)
    doc.add_paragraph(
        "«Время до первого ответа (TTFT)» — сколько пользователь ждёт, пока агент "
        "начнёт отвечать: это чистая работа LLM и оркестрации. "
        "«Стриминг» — время досылки ответа по словам; в MVP оно искусственное "
        "(пауза ~60 мс на слово на стороне агента) и масштабом нагрузки почти не "
        "управляется. «Полное время ответа» = TTFT + стриминг."
    )
    doc.add_paragraph(
        "Ориентиры: TTFT p95 до 8 с — отлично, до 15 с — приемлемо, выше — "
        "пользователи замечают «зависание». Ошибки выше 1% — повод разбирать "
        "логи агента (kubectl logs -n agent deploy/agent)."
    )

    doc.save(output)
    print(f"Отчёт сохранён: {output}")


def main() -> None:
    """Разбирает аргументы и строит отчёт."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", help="префикс CSV Locust (как в --csv=...)")
    parser.add_argument("--title", default="Прогон нагрузочного теста", help="подзаголовок отчёта")
    parser.add_argument("-o", "--output", help="куда сохранить .docx")
    args = parser.parse_args()

    output = args.output or f"{args.prefix}-report.docx"
    build_report(args.prefix, args.title, output)


if __name__ == "__main__":
    main()
