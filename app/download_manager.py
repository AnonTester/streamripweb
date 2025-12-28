import asyncio
import json
import logging
import os
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List

from streamrip import progress
from streamrip.media.track import Track
from streamrip.rip.main import Main

from .config_manager import StreamripConfigManager

logger = logging.getLogger("streamripweb.download")


def _stringify_artist(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("name") or value.get("artist") or value.get("title")
    if isinstance(value, list):
        parts = [_stringify_artist(v) for v in value]
        return ", ".join([p for p in parts if p])
    return str(value)


@dataclass
class QueueItem:
    job_id: str
    source: str
    media_type: str
    item_id: str
    title: str
    artist: str | None = None
    status: str = "queued"
    attempts: int = 0
    error: str | None = None
    downloaded: bool = False

    def display_label(self) -> str:
        label = self.title
        if self.artist:
            label += f" — {self.artist}"
        return label


class EventBroker:
    def __init__(self):
        self.subscribers: set[asyncio.Queue] = set()
        self.lock = asyncio.Lock()

    async def subscribe(self):
        queue: asyncio.Queue = asyncio.Queue()
        async with self.lock:
            self.subscribers.add(queue)
        try:
            while True:
                event = await queue.get()
                yield event
        finally:
            async with self.lock:
                self.subscribers.discard(queue)

    async def publish(self, event: Dict[str, Any]):
        async with self.lock:
            subscribers = list(self.subscribers)
        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Drop events if a subscriber is too slow.
                pass


class ProgressTap:
    """Bridges streamrip progress callbacks to SSE events."""

    def __init__(self, broker: EventBroker):
        self.broker = broker
        self.original_get_progress = progress.get_progress_callback
        self.original_track_download = Track.download
        self.current_job: ContextVar[str | None] = ContextVar(
            "current_job", default=None
        )
        self.current_track: ContextVar[dict | None] = ContextVar(
            "current_track", default=None
        )
        self.job_totals: dict[str, dict[str, Any]] = {}
        self.latest_progress: dict[str, dict[str, Any]] = {}
        self._patch()

    def _patch(self):
        progress.get_progress_callback = self._patched_get_progress
        original_download = self.original_track_download
        tap = self

        async def patched_download(self_ref: Track, *args, **kwargs):
            job_id = tap.current_job.get()
            logger.debug(
                "Starting track download | job_id=%s track=%s",
                job_id,
                getattr(self_ref.meta.info, "id", None),
            )
            track_info = {
                "track_id": self_ref.meta.info.id,
                "title": self_ref.meta.title,
                "album": getattr(self_ref.meta.album, "album", None),
                "tracknumber": self_ref.meta.tracknumber,
                "discnumber": self_ref.meta.discnumber,
            }
            token = tap.current_track.set(track_info)
            try:
                return await original_download(self_ref, *args, **kwargs)
            finally:
                tap.current_track.reset(token)
                logger.debug(
                    "Finished track download | job_id=%s track=%s",
                    job_id,
                    getattr(self_ref.meta.info, "id", None),
                )

        Track.download = patched_download  # type: ignore

    def start_job(self, job_id: str):
        self.job_totals[job_id] = {
            "tracks": {},
            "started_at": time.monotonic(),
        }
        logger.info("Progress tracking started for job %s", job_id)

    def finish_job(self, job_id: str):
        self.job_totals.pop(job_id, None)
        logger.info("Progress tracking finished for job %s", job_id)

    def _patched_get_progress(self, enabled: bool, total: int, desc: str):
        handle = self.original_get_progress(enabled, total, desc)
        job_id = self.current_job.get()
        track_ctx = self.current_track.get()
        started = time.monotonic()
        state = self.job_totals.setdefault(
            job_id or "unknown",
            {"tracks": {}, "started_at": started},
        )
        track_id = track_ctx.get("track_id") if track_ctx else desc

        def _update_totals(increment: int):
            track_state = state["tracks"].setdefault(
                track_id,
                {"received": 0, "total": total, "title": desc},
            )
            track_state["total"] = total
            track_state["received"] = min(
                track_state["received"] + increment, total
            )
            received_sum = sum(t["received"] for t in state["tracks"].values())
            total_sum = sum(t["total"] for t in state["tracks"].values()) or total
            elapsed = max(time.monotonic() - state["started_at"], 0.0001)
            rate = received_sum / elapsed
            eta_total = (
                (total_sum - received_sum) / rate if rate > 0 else None
            )
            event_data = {
                "job_id": job_id,
                "progress": {
                    "track_id": track_id,
                    "desc": desc,
                    "received": track_state["received"],
                    "total": total,
                    "eta": (total - track_state["received"]) / rate
                    if rate > 0
                    else None,
                },
                "overall": {
                    "received": received_sum,
                    "total": total_sum,
                    "eta": eta_total,
                },
            }
            if track_ctx:
                event_data |= {"track": track_ctx}
            self.latest_progress[job_id or "unknown"] = event_data
            logger.debug(
                "Progress update | job_id=%s track_id=%s received=%s total=%s eta=%s overall_eta=%s",
                job_id,
                track_id,
                track_state["received"],
                total,
                event_data["progress"]["eta"],
                event_data["overall"]["eta"],
            )
            asyncio.create_task(
                self.broker.publish(
                    {"event": "progress", "data": event_data}
                )
            )

        def update(x: int):
            _update_totals(x)
            handle.update(x)

        def done():
            _update_totals(total)
            handle.done()

        return progress.Handle(update, done)

    def snapshot(self) -> dict[str, dict[str, Any]]:
        return dict(self.latest_progress)


class SavedStore:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if not os.path.exists(self.path):
            self._write([])

    def _write(self, data: list[dict]):
        with open(self.path, "w") as f:
            json.dump(data, f, indent=2)

    def list(self) -> list[dict]:
        try:
            with open(self.path) as f:
                return json.load(f)
        except FileNotFoundError:
            return []

    def add(self, items: Iterable[dict]):
        existing = self.list()
        existing.extend(items)
        self._write(existing)

    def remove(self, predicate):
        existing = self.list()
        filtered = [item for item in existing if not predicate(item)]
        self._write(filtered)


class DownloadHistoryStore:
    """Persist completed downloads for future highlighting."""

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if not os.path.exists(self.path):
            self._write([])

    def _write(self, data: list[dict]):
        with open(self.path, "w") as f:
            json.dump(data, f, indent=2)

    def list(self) -> list[dict]:
        try:
            with open(self.path) as f:
                return json.load(f)
        except FileNotFoundError:
            return []

    def add(self, items: Iterable[dict]):
        existing = self.list()
        seen = {(entry.get("source"), str(entry.get("id"))) for entry in existing}
        new_items: list[dict] = []
        for entry in items:
            key = (entry.get("source"), str(entry.get("id")))
            if key in seen:
                continue
            seen.add(key)
            new_items.append(
                {
                    "id": str(entry.get("id")),
                    "source": entry.get("source"),
                    "media_type": entry.get("media_type"),
                    "title": entry.get("title"),
                    "artist": entry.get("artist"),
                }
            )
        if new_items:
            existing.extend(new_items)
            self._write(existing)


class DownloadManager:
    def __init__(
        self,
        config_manager: StreamripConfigManager,
        saved_path: str,
        history_path: str,
    ):
        self.config_manager = config_manager
        self.event_broker = EventBroker()
        self.progress_tap = ProgressTap(self.event_broker)
        self.saved_store = SavedStore(saved_path)
        self.history_store = DownloadHistoryStore(history_path)
        self.downloaded_index: set[tuple[str | None, str]] = {
            (entry.get("source"), str(entry.get("id")))
            for entry in self.history_store.list()
        }
        self.queue: Dict[str, QueueItem] = {}
        self.order: List[str] = []
        self.worker: asyncio.Task | None = None
        self.lock = asyncio.Lock()

    def snapshot(self) -> list[dict]:
        return [self._item_to_dict(self.queue[jid]) for jid in self.order]

    def saved_items(self) -> list[dict]:
        return self.saved_store.list()

    def downloaded_ids(self) -> set[str]:
        return {entry[1] for entry in self.downloaded_index}

    def has_downloaded(self, source: str, item_id: str | int) -> bool:
        return (source, str(item_id)) in self.downloaded_index

    def history_snapshot(self) -> list[dict]:
        return self.history_store.list()

    def queue_state(self) -> dict[str, Any]:
        return self._queue_payload()

    def _queue_payload(self) -> dict[str, Any]:
        return {
            "queue": self.snapshot(),
            "progress": self.progress_tap.snapshot(),
            "history": self.history_snapshot(),
        }

    def _record_download(self, item: QueueItem):
        key = (item.source, str(item.item_id))
        if key in self.downloaded_index:
            return
        self.downloaded_index.add(key)
        self.history_store.add(
            [
                {
                    "id": item.item_id,
                    "source": item.source,
                    "media_type": item.media_type,
                    "title": item.title,
                    "artist": item.artist,
                }
            ]
        )

    def _item_to_dict(self, item: QueueItem) -> dict:
        return {
            "job_id": item.job_id,
            "source": item.source,
            "media_type": item.media_type,
            "item_id": item.item_id,
            "title": item.title,
            "artist": item.artist,
            "status": item.status,
            "attempts": item.attempts,
            "error": item.error,
            "downloaded": item.downloaded,
        }

    async def enqueue(self, entries: list[dict]):
        async with self.lock:
            for entry in entries:
                job_id = str(uuid.uuid4())
                item = QueueItem(
                    job_id=job_id,
                    source=entry["source"],
                    media_type=entry["media_type"],
                    item_id=entry["id"],
                    title=entry.get("title") or entry.get("name") or entry["id"],
                    artist=_stringify_artist(entry.get("artist")),
                    downloaded=entry.get("downloaded", False),
                )
                self.queue[job_id] = item
                self.order.append(job_id)
                logger.info(
                    "Enqueued item | job_id=%s source=%s media_type=%s item_id=%s title=%s",
                    job_id,
                    entry.get("source"),
                    entry.get("media_type"),
                    entry.get("id"),
                    item.title,
                )
            await self.event_broker.publish(
                {"event": "queue", "data": self._queue_payload()}
            )
            if self.worker is None or self.worker.done():
                self.worker = asyncio.create_task(self._worker())
        return self.snapshot()

    async def _worker(self):
        while True:
            async with self.lock:
                if not self.order:
                    return
                job_id = self.order[0]
            item = self.queue[job_id]
            logger.debug("Worker picked job %s with status %s", job_id, item.status)
            if item.status in {"completed", "aborted"}:
                async with self.lock:
                    self.order.pop(0)
                continue
            await self._process_item(item)
            async with self.lock:
                self.order.pop(0)
                await self.event_broker.publish(
                    {"event": "queue", "data": self._queue_payload()}
                )

    async def _process_item(self, item: QueueItem):
        item.status = "in_progress"
        item.error = None
        self.progress_tap.start_job(item.job_id)
        await self.event_broker.publish(
            {"event": "queue", "data": self._queue_payload()}
        )
        backoff = 1.0
        logger.info(
            "Processing job | job_id=%s source=%s media_type=%s item_id=%s title=%s",
            item.job_id,
            item.source,
            item.media_type,
            item.item_id,
            item.title,
        )
        for attempt in range(5):
            item.attempts = attempt + 1
            token = self.progress_tap.current_job.set(item.job_id)
            try:
                await self._run_streamrip(item)
                item.status = "completed"
                item.downloaded = True
                self._record_download(item)
                logger.info("Job completed | job_id=%s attempts=%s", item.job_id, item.attempts)
                self.saved_store.remove(
                    lambda saved: saved.get("id") == item.item_id
                    and saved.get("source") == item.source
                )
                await self.event_broker.publish(
                    {"event": "saved", "data": self.saved_store.list()}
                )
                await self.event_broker.publish(
                    {
                        "event": "queue",
                        "data": self._queue_payload(),
                    }
                )
                self.progress_tap.finish_job(item.job_id)
                return
            except Exception as exc:  # noqa: BLE001
                item.error = str(exc)
                item.status = "retrying"
                logger.exception(
                    "Error during download | job_id=%s attempt=%s error=%s",
                    item.job_id,
                    attempt + 1,
                    exc,
                )
                await self.event_broker.publish(
                    {
                        "event": "queue",
                        "data": self._queue_payload(),
                        "meta": {"message": "retrying", "backoff": backoff},
                    }
                )
                await asyncio.sleep(backoff)
                backoff *= 1.5
            finally:
                self.progress_tap.current_job.reset(token)
        item.status = "failed"
        self.progress_tap.finish_job(item.job_id)
        logger.error("Job failed after retries | job_id=%s error=%s", item.job_id, item.error)
        await self.event_broker.publish(
            {"event": "queue", "data": self._queue_payload()}
        )

    async def _run_streamrip(self, item: QueueItem):
        config = self.config_manager.load()
        # Force progress callbacks to emit for web UI without printing console status noise.
        config.session.cli.progress_bars = True
        config.file.cli.progress_bars = True
        config.session.cli.text_output = False
        config.file.cli.text_output = False
        logger.debug(
            "Launching streamrip Main for job %s | source=%s media_type=%s item_id=%s",
            item.job_id,
            item.source,
            item.media_type,
            item.item_id,
        )
        async with Main(config) as main:
            await main.add_all_by_id(
                [(item.source, item.media_type, item.item_id)]
            )
            logger.debug("Resolved items for job %s; beginning rip", item.job_id)
            await main.resolve()
            await main.rip()

    async def save_for_later(self, job_id: str | None = None, payload: dict | None = None):
        if payload:
            payload = dict(payload)
            payload["artist"] = _stringify_artist(payload.get("artist"))
            self.saved_store.add([payload])
            logger.info(
                "Saved arbitrary payload for later | id=%s source=%s",
                payload.get("id"),
                payload.get("source"),
            )
        elif job_id and job_id in self.queue:
            item = self.queue[job_id]
            self.saved_store.add(
                [
                    {
                        "id": item.item_id,
                        "source": item.source,
                        "media_type": item.media_type,
                        "title": item.title,
                        "artist": item.artist,
                    }
                ]
            )
            logger.info("Saved job for later | job_id=%s", job_id)
        await self.event_broker.publish(
            {"event": "saved", "data": self.saved_store.list()}
        )

    async def retry(self, job_id: str):
        if job_id not in self.queue:
            return
        item = self.queue[job_id]
        item.status = "queued"
        item.error = None
        logger.info("Retrying job %s", job_id)
        async with self.lock:
            self.order.append(job_id)
            if self.worker is None or self.worker.done():
                self.worker = asyncio.create_task(self._worker())
        await self.event_broker.publish(
            {"event": "queue", "data": self._queue_payload()}
        )

    async def abort(self, job_id: str):
        if job_id not in self.queue:
            return
        item = self.queue[job_id]
        item.status = "aborted"
        logger.warning("Aborted job %s", job_id)
        await self.event_broker.publish(
            {"event": "queue", "data": self._queue_payload()}
        )

    async def download_saved(self, entries: list[dict] | None = None):
        entries = entries or self.saved_store.list()
        logger.info("Downloading saved entries count=%s", len(entries))
        await self.enqueue(entries)
        self.saved_store.remove(
            lambda saved: any(
                saved.get("id") == entry.get("id")
                and saved.get("source") == entry.get("source")
                for entry in entries
            )
        )
        await self.event_broker.publish(
            {"event": "saved", "data": self.saved_store.list()}
        )

    async def remove_saved(self, payload: dict):
        target_id = payload.get("id")
        source = payload.get("source")
        self.saved_store.remove(
            lambda saved: saved.get("id") == target_id
            and saved.get("source") == source
        )
        logger.info("Removed saved item | id=%s source=%s", target_id, source)
        await self.event_broker.publish(
            {"event": "saved", "data": self.saved_store.list()}
        )


__all__ = ["DownloadManager", "QueueItem"]
