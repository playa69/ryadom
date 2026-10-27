"""Возврат памяти (app/core/reclaim.py, MEMORY_RECLAIM_SECONDS) и сеансы без ссылочных циклов.

Цикл (объект → своя отменённая задача → её CancelledError → traceback → кадр с self → объект) освобождается только полной
сборкой мусора: до неё живёт всё, что держит объект, — сокет, очереди звука, буферы TLS. Здесь проверяется, что после
закрытия сеанса таких циклов нашего кода не остаётся, а остатки собирает периодический возврат памяти.
"""

import asyncio
import gc
import logging
import sys
import threading
import time
import types
from contextlib import AsyncExitStack
from typing import Any

import pytest
from prometheus_client import REGISTRY

from app.api.dialog_live import LiveTurn
from app.api.dialog_ws import DialogSession, Synthesis
from app.clients.gemini_live import GeminiLiveLink
from app.core import reclaim
from app.core.config import APP_CONFIG
from app.core.reclaim import MemoryReclaimer, forget_cancellation
from tests.conftest import AUTH, FakeChat, FakeTts, has, make_client, read_frames, send_user_message, start_dialog, ws_url
from tests.fake_live import FakeConnector, reply_done, speak_turn
from tests.test_live import make_live_client

OURS = (DialogSession, Synthesis, LiveTurn, GeminiLiveLink)


def cyclic_garbage() -> list[Any]:
    """Объекты, которые держатся только ссылочными циклами: их освободила бы лишь сборка мусора."""
    gc.set_debug(gc.DEBUG_SAVEALL)
    try:
        gc.collect()
        return list(gc.garbage)
    finally:
        gc.set_debug(0)
        gc.garbage.clear()


def ours_in(garbage: list[Any]) -> list[str]:
    """Наши объекты и кадры нашего кода среди мусора в циклах."""
    found = [type(o).__name__ for o in garbage if isinstance(o, OURS)]
    found += [
        o.f_code.co_qualname
        for o in garbage
        if isinstance(o, types.FrameType) and "/app/" in o.f_code.co_filename.replace("\\", "/")
    ]
    return found


def runs() -> float:
    return REGISTRY.get_sample_value("agent_process_memory_reclaim_runs_total") or 0.0


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


# ─── циклы ────────────────────────────────────────────────────────────────────


async def test_a_cancelled_task_does_not_hold_its_owner_in_a_cycle() -> None:
    class Owner:
        def __init__(self, forget: bool) -> None:
            self.task = asyncio.create_task(self.wait())
            if forget:
                self.task.add_done_callback(forget_cancellation)

        async def wait(self) -> None:
            await asyncio.sleep(10)

    gc.collect()
    for forget in (False, True):
        owner = Owner(forget)
        await asyncio.sleep(0)
        owner.task.cancel()
        await asyncio.sleep(0.01)  # задачу никто не ждёт (gather с return_exceptions и await забирают исключение сами)
        del owner
        held = [o for o in cyclic_garbage() if type(o).__name__ == "Owner"]
        assert bool(held) is not forget  # без колбэка отменённая задача держит владельца циклом, с ним — нет


async def test_a_cut_off_synthesis_is_freed_without_the_collector() -> None:
    class Stuck:
        name = "stuck"

        async def stream(self, text: str, voice: str) -> Any:
            yield b"\x00\x00" * 100
            await asyncio.sleep(10)  # синтез завис: его обрывают

    gc.collect()
    synthesis = Synthesis(Stuck(), "Длинный ответ.", "male", True)  # type: ignore[arg-type]
    assert await synthesis.pieces.get()
    synthesis.cancel()
    await asyncio.gather(synthesis.task, return_exceptions=True)
    await asyncio.sleep(0)  # колбэк задачи
    del synthesis
    assert ours_in(cyclic_garbage()) == []


def test_a_closed_live_session_leaves_no_cycles_of_our_code(user_id: str) -> None:
    gc.collect()
    connector = FakeConnector(turn_complete=True)
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне сегодня тревожно")
            read_frames(ws, reply_done)
            speak_turn(ws)
            read_frames(ws, reply_done)
    assert ours_in(cyclic_garbage()) == []


def test_a_session_closed_while_the_memory_loads_leaves_no_cycles(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Загрузка памяти, не успевшая к открытию сессии, идёт и после закрытия сокета; дойдя, она не оставляет сеанс в цикле."""
    monkeypatch.setattr("app.api.dialog_live.MEMORY_WAIT_SECONDS", 0.05)
    loaded = threading.Event()
    gc.collect()
    with make_live_client(FakeConnector(turn_complete=True), FakeTts()) as client:
        store = client.app.state.store
        real = store.memory

        class SlowMemory:
            def __getattr__(self, name: str) -> Any:
                return getattr(real, name)

            async def prepare(self, dialog: Any) -> None:
                await asyncio.sleep(0.3)
                loaded.set()

        store.memory = SlowMemory()
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне сегодня тревожно")
            read_frames(ws, reply_done)
            assert not loaded.is_set()  # сокет закрывается, пока память ещё грузится
        assert loaded.wait(3)
        time.sleep(0.05)  # колбэки законченной задачи
    assert ours_in(cyclic_garbage()) == []


def test_cut_off_speech_leaves_no_cycles_of_our_code(user_id: str) -> None:
    class Slow(FakeTts):
        async def stream(self, text: str, voice: str = "male") -> Any:
            yield b"\x01\x00" * 4800
            await asyncio.sleep(5)  # озвучка ещё идёт, когда человек пишет снова
            yield b"\x01\x00" * 4800

    gc.collect()
    with make_client(Slow(), chat=FakeChat(reply="Первый ответ.")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_start"))  # приветствие зазвучало и застряло
            send_user_message(ws, "c-1", "раз")  # перебивает его
            read_frames(ws, lambda f: has(f, "assistant_end"))
    assert ours_in(cyclic_garbage()) == []


async def test_a_closed_gemini_connection_leaves_no_keepalive_cycle() -> None:
    """Обход цикла keepalive в websockets (app/clients/gemini_live.py): закрытое соединение не держит себя задачей.

    Настоящие websockets и AsyncSession google-genai: проверка заодно ловит смену их внутренностей, на которые опирается обход.
    Другой цикл остаётся: ClientConnection ссылается на LoggerAdapter, а тот на него же (`{"websocket": self}` в
    websockets/asyncio/connection.py). Он в библиотеке и намеренный, его собирает периодическая сборка (app/core/reclaim.py).
    """
    from google.genai.live import AsyncSession
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve

    async def handler(server_side: Any) -> None:
        async for _ in server_side:
            pass

    gc.collect()
    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        stack = AsyncExitStack()
        ws = await stack.enter_async_context(connect(f"ws://127.0.0.1:{port}"))
        assert ws.keepalive_task is not None  # иначе проверять нечего
        link = GeminiLiveLink(stack, AsyncSession(api_client=None, websocket=ws), "male")  # type: ignore[arg-type]
        await link.aclose()
        del link, ws, stack
        await asyncio.sleep(0.05)  # отмена keepalive доходит до задачи на следующих итерациях цикла
        garbage = cyclic_garbage()
    # серверная сторона теста устроена так же и цикл держит; считаем только клиентское соединение
    keepalives = [
        o
        for o in garbage
        if isinstance(o, types.FrameType)
        and o.f_code.co_name == "keepalive"
        and type(o.f_locals.get("self")).__name__ == "ClientConnection"
    ]
    assert keepalives == []


# ─── периодический возврат памяти ─────────────────────────────────────────────


def test_malloc_trim_is_skipped_outside_linux_and_said_once(monkeypatch: pytest.MonkeyPatch, caplog) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    reclaim.malloc_trim.cache_clear()
    try:
        with caplog.at_level(logging.INFO, logger="agent.reclaim"):
            assert reclaim.malloc_trim() is None
            assert reclaim.malloc_trim() is None
        assert len([r for r in caplog.records if "malloc_trim" in r.getMessage()]) == 1
    finally:
        reclaim.malloc_trim.cache_clear()


def test_malloc_trim_is_skipped_without_glibc(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_libc(name: str) -> Any:
        raise OSError(f"{name}: cannot open shared object file")

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(reclaim.ctypes, "CDLL", no_libc)
    reclaim.malloc_trim.cache_clear()
    try:
        assert reclaim.malloc_trim() is None
    finally:
        reclaim.malloc_trim.cache_clear()


async def test_reclaim_without_malloc_trim_still_collects_and_never_fails(caplog) -> None:
    before = runs()
    reclaimer = MemoryReclaimer(0.01, trim=None)
    reclaimer.start()
    await asyncio.sleep(0.2)
    await reclaimer.stop()
    assert runs() > before
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


async def test_malloc_trim_runs_outside_the_event_loop_thread() -> None:
    calls: list[tuple[int, bool]] = []

    def trim(pad: int) -> int:
        calls.append((pad, threading.current_thread() is threading.main_thread()))
        return 1

    reclaimer = MemoryReclaimer(0.01, trim=trim)
    reclaimer.start()
    await asyncio.sleep(0.2)
    await reclaimer.stop()
    assert calls and calls[0] == (0, False)  # malloc_trim(0) и не в потоке цикла событий: звук он не держит


async def test_stop_does_not_wait_for_a_running_trim() -> None:
    entered, release = threading.Event(), threading.Event()

    def slow_trim(pad: int) -> int:
        entered.set()
        release.wait(5)
        return 0

    reclaimer = MemoryReclaimer(0.01, trim=slow_trim)
    reclaimer.start()
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        started = time.monotonic()
        await asyncio.wait_for(reclaimer.stop(), 1)
        assert time.monotonic() - started < 0.5
    finally:
        release.set()


@pytest.mark.parametrize(("seconds", "reclaims"), [(0, False), (1, True)])
def test_reclaim_is_switched_by_the_setting(monkeypatch: pytest.MonkeyPatch, seconds: int, reclaims: bool) -> None:
    monkeypatch.setattr(APP_CONFIG.memory_reclaim, "seconds", seconds)
    before = runs()
    with make_client(None):
        deadline = time.monotonic() + 2
        while not gc.get_freeze_count() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert gc.get_freeze_count() > 0  # стартовые объекты заморожены при любой настройке
        time.sleep(1.4)
    assert (runs() > before) is reclaims
    assert gc.get_freeze_count() == 0  # при остановке замороженное вернулось сборщику


async def test_a_pass_is_counted_and_timed_and_reports_what_it_freed(monkeypatch: pytest.MonkeyPatch) -> None:
    class Loop:
        pass

    garbage = []
    for _ in range(50):
        a, b = Loop(), Loop()
        a.other, b.other = b, a  # цикл: освободит только сборка мусора
        garbage.append((a, b))
    del a, b, garbage
    rss = iter([300 << 20, 120 << 20])  # до сборки и после: опустилась на 180 МиБ
    monkeypatch.setattr(reclaim, "rss_bytes", lambda: next(rss))
    before = {
        "runs": runs(),
        "gc": sample("agent_process_memory_reclaim_seconds_count", step="gc"),
        "trim": sample("agent_process_memory_reclaim_seconds_count", step="trim"),
        "found": sample("agent_process_memory_reclaim_collected_objects_total"),
        "freed": sample("agent_process_memory_reclaimed_bytes_total"),
    }
    await MemoryReclaimer(60, trim=lambda pad: 1).reclaim()
    assert runs() == before["runs"] + 1
    assert sample("agent_process_memory_reclaim_seconds_count", step="gc") == before["gc"] + 1
    assert sample("agent_process_memory_reclaim_seconds_count", step="trim") == before["trim"] + 1
    assert sample("agent_process_memory_reclaim_collected_objects_total") >= before["found"] + 100  # пятьдесят пар
    assert sample("agent_process_memory_reclaimed_bytes_total") == before["freed"] + (180 << 20)


async def test_a_pass_without_a_trim_has_no_trim_timing_and_memory_that_grew_is_not_counted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rss = iter([100 << 20, 130 << 20])  # за время прохода память выросла (другие потоки): «освобождено» не уходит в минус
    monkeypatch.setattr(reclaim, "rss_bytes", lambda: next(rss))
    trims, freed = sample("agent_process_memory_reclaim_seconds_count", step="trim"), sample("agent_process_memory_reclaimed_bytes_total")
    await MemoryReclaimer(60, trim=None).reclaim()
    assert sample("agent_process_memory_reclaim_seconds_count", step="trim") == trims
    assert sample("agent_process_memory_reclaimed_bytes_total") == freed


async def test_a_failing_pass_is_logged_and_the_next_one_still_runs(caplog) -> None:
    calls: list[int] = []

    def trim(pad: int) -> int:
        calls.append(pad)
        if len(calls) == 1:
            raise RuntimeError("malloc_trim отказал")
        return 1

    reclaimer = MemoryReclaimer(0.01, trim=trim)
    reclaimer.start()
    await asyncio.sleep(0.3)
    await reclaimer.stop()
    assert len(calls) > 1
    assert [r for r in caplog.records if r.levelno >= logging.ERROR and "memory reclaim failed" in r.getMessage()]


async def test_stopping_twice_or_without_starting_is_harmless() -> None:
    reclaimer = MemoryReclaimer(60, trim=None)
    await reclaimer.stop()
    reclaimer.start()
    await reclaimer.stop()
    await reclaimer.stop()


async def test_the_pass_waits_for_the_warm_up_before_it_freezes_anything() -> None:
    done = asyncio.Event()
    warm_up = asyncio.create_task(done.wait())
    frozen = gc.get_freeze_count()
    reclaimer = MemoryReclaimer(0, trim=None)
    reclaimer.start(warm_up)
    try:
        await asyncio.sleep(0.1)
        assert gc.get_freeze_count() == frozen  # прогрев идёт: его объекты ещё не стартовые
        done.set()
        await asyncio.sleep(0.1)
        assert gc.get_freeze_count() > frozen
    finally:
        await reclaimer.stop()
        await warm_up
    assert gc.get_freeze_count() == frozen


def test_metrics_endpoint_lists_the_process_memory_gc_and_reclaim_metrics() -> None:
    with make_client(None) as client:
        text = client.get("/metrics").text
    for name in (
        "python_gc_collections_total",
        "python_gc_objects_collected_total",
        "agent_process_memory_reclaim_runs_total",
        "agent_process_memory_reclaim_seconds",
        "agent_process_memory_reclaim_collected_objects_total",
        "agent_process_memory_reclaimed_bytes_total",
    ):
        assert name in text
    if sys.platform.startswith("linux"):  # стандартный сборщик prometheus_client читает /proc
        assert "process_resident_memory_bytes" in text


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="malloc_trim и /proc есть только в Linux с glibc")
async def test_on_linux_the_real_malloc_trim_runs_and_rss_is_readable() -> None:
    assert reclaim.malloc_trim() is not None
    assert (reclaim.rss_bytes() or 0) > 0
    before = runs()
    await MemoryReclaimer(60).reclaim()
    assert runs() == before + 1

