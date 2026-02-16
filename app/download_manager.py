import asyncio
import json
import logging
import os
import time
import uuid
from collections import Counter
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List
from urllib.parse import urlparse

from streamrip import progress
from streamrip.media import PendingSingle, PendingTrack
from streamrip.media.track import Track, global_download_semaphore
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


def _is_lastfm_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return host == "www.last.fm" or host == "last.fm"


@dataclass
class QueueItem:
    job_id: str
    source: str
    media_type: str
    item_id: str
    title: str
    artist: str | None = None
    url: str | None = None
    status: str = "queued"
    attempts: int = 0
    error: str | None = None
    downloaded: bool = False
    force_no_db: bool = False

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
        logger.debug(
            "Publishing event to %s subscribers | type=%s keys=%s",
            len(subscribers),
            event.get("event"),
            list(event.keys()),
        )
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
        self.original_track_postprocess = Track.postprocess
        self.original_pending_track_resolve = PendingTrack.resolve
        self.original_pending_single_resolve = PendingSingle.resolve
        self.current_job: ContextVar[str | None] = ContextVar(
            "current_job", default=None
        )
        self.current_track: ContextVar[dict | None] = ContextVar(
            "current_track", default=None
        )
        self.job_totals: dict[str, dict[str, Any]] = {}
        self.latest_progress: dict[str, dict[str, Any]] = {}
        self._patch()

    def _normalize_track_id(self, track_id: str | int | None) -> str | None:
        if track_id is None:
            return None
        return str(track_id)

    def _patch(self):
        progress.get_progress_callback = self._patched_get_progress
        tap = self

        async def patched_pending_resolve(self_ref: PendingTrack, *args, **kwargs):
            job_id = tap.current_job.get()
            track_id = tap._normalize_track_id(getattr(self_ref, "id", None))
            track_ctx = {
                "track_id": track_id,
                "album": getattr(self_ref.album, "album", None),
                "source": getattr(getattr(self_ref, "client", None), "source", None),
            }
            tap._mark_track_status(
                job_id,
                track_id,
                status="resolving",
                track_ctx=track_ctx,
                desc=f"Track {track_id}",
                received=0,
                total=1,
                message=None,
            )
            already_downloaded = False
            try:
                already_downloaded = bool(self_ref.db.downloaded(self_ref.id))
                if already_downloaded:
                    tap._mark_track_status(
                        job_id,
                        track_id,
                        status="skipped",
                        track_ctx=track_ctx,
                        desc=f"Track {track_id}",
                        received=1,
                        total=1,
                        message="Already downloaded in database",
                    )
                    return None
                track = await tap.original_pending_track_resolve(self_ref, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                tap._mark_track_status(
                    job_id,
                    track_id,
                    status="failed",
                    track_ctx=track_ctx,
                    desc=f"Track {track_id}",
                    received=1,
                    total=1,
                    message=str(exc),
                )
                raise

            if track is None:
                status = "skipped" if already_downloaded else "failed"
                tap._mark_track_status(
                    job_id,
                    track_id,
                    status=status,
                    track_ctx=track_ctx,
                    desc=f"Track {track_id}",
                    received=1,
                    total=1,
                    message=(
                        "Already downloaded in database"
                        if status == "skipped"
                        else "Track unavailable or failed to resolve"
                    ),
                )
                return None

            track_ctx = {
                "track_id": tap._normalize_track_id(
                    getattr(track.meta.info, "id", track_id)
                ),
                "title": track.meta.title,
                "album": getattr(track.meta.album, "album", None),
                "tracknumber": track.meta.tracknumber,
                "discnumber": track.meta.discnumber,
            }
            tap._mark_track_status(
                job_id,
                track_ctx["track_id"],
                status="ready",
                track_ctx=track_ctx,
                desc=track.meta.title,
                received=0,
                total=1,
                message=None,
            )
            return track

        async def patched_single_resolve(self_ref: PendingSingle, *args, **kwargs):
            job_id = tap.current_job.get()
            track_id = tap._normalize_track_id(getattr(self_ref, "id", None))
            track_ctx = {
                "track_id": track_id,
                "album": None,
                "source": getattr(getattr(self_ref, "client", None), "source", None),
            }
            tap._mark_track_status(
                job_id,
                track_id,
                status="resolving",
                track_ctx=track_ctx,
                desc=f"Track {track_id}",
                received=0,
                total=1,
                message=None,
            )
            already_downloaded = False
            try:
                already_downloaded = bool(self_ref.db.downloaded(self_ref.id))
                if already_downloaded:
                    tap._mark_track_status(
                        job_id,
                        track_id,
                        status="skipped",
                        track_ctx=track_ctx,
                        desc=f"Track {track_id}",
                        received=1,
                        total=1,
                        message="Already downloaded in database",
                    )
                    return None
                track = await tap.original_pending_single_resolve(self_ref, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                tap._mark_track_status(
                    job_id,
                    track_id,
                    status="failed",
                    track_ctx=track_ctx,
                    desc=f"Track {track_id}",
                    received=1,
                    total=1,
                    message=str(exc),
                )
                raise

            if track is None:
                status = "skipped" if already_downloaded else "failed"
                tap._mark_track_status(
                    job_id,
                    track_id,
                    status=status,
                    track_ctx=track_ctx,
                    desc=f"Track {track_id}",
                    received=1,
                    total=1,
                    message=(
                        "Already downloaded in database"
                        if status == "skipped"
                        else "Track unavailable or failed to resolve"
                    ),
                )
                return None

            track_ctx = {
                "track_id": tap._normalize_track_id(
                    getattr(track.meta.info, "id", track_id)
                ),
                "title": track.meta.title,
                "album": getattr(track.meta.album, "album", None),
                "tracknumber": track.meta.tracknumber,
                "discnumber": track.meta.discnumber,
            }
            tap._mark_track_status(
                job_id,
                track_ctx["track_id"],
                status="ready",
                track_ctx=track_ctx,
                desc=track.meta.title,
                received=0,
                total=1,
                message=None,
            )
            return track

        original_download = self.original_track_download

        async def patched_download(self_ref: Track, *args, **kwargs):
            job_id = tap.current_job.get()
            logger.debug(
                "Starting track download | job_id=%s track=%s",
                job_id,
                getattr(self_ref.meta.info, "id", None),
            )
            track_info = {
                "track_id": tap._normalize_track_id(self_ref.meta.info.id),
                "title": self_ref.meta.title,
                "album": getattr(self_ref.meta.album, "album", None),
                "tracknumber": self_ref.meta.tracknumber,
                "discnumber": self_ref.meta.discnumber,
            }
            token = tap.current_track.set(track_info)
            try:
                track_id = track_info.get("track_id")
                tap._mark_track_status(
                    job_id,
                    track_id,
                    status="downloading",
                    track_ctx=track_info,
                    desc=self_ref.meta.title,
                    message=None,
                )
                success, error_message = await tap._download_with_tracking(
                    self_ref, *args, **kwargs
                )
                if success:
                    tap._mark_track_status(
                        job_id,
                        track_id,
                        status="downloaded",
                        track_ctx=track_info,
                        desc=self_ref.meta.title,
                        message=None,
                    )
                else:
                    tap._mark_track_status(
                        job_id,
                        track_id,
                        status="failed",
                        track_ctx=track_info,
                        desc=self_ref.meta.title,
                        message=error_message or "Download failed",
                    )
                return success
            finally:
                tap.current_track.reset(token)
                logger.debug(
                    "Finished track download | job_id=%s track=%s",
                    job_id,
                    getattr(self_ref.meta.info, "id", None),
                )

        Track.download = patched_download  # type: ignore
        PendingTrack.resolve = patched_pending_resolve  # type: ignore
        PendingSingle.resolve = patched_single_resolve  # type: ignore

        original_postprocess = self.original_track_postprocess

        async def patched_postprocess(self_ref: Track, *args, **kwargs):
            job_id = tap.current_job.get()
            track_id = getattr(self_ref.meta.info, "id", None)
            if getattr(self_ref, "_download_failed", False):
                tap._mark_track_status(
                    job_id,
                    track_id,
                    status="failed",
                    track_ctx={
                        "track_id": track_id,
                        "title": self_ref.meta.title,
                        "album": getattr(self_ref.meta.album, "album", None),
                        "tracknumber": self_ref.meta.tracknumber,
                        "discnumber": self_ref.meta.discnumber,
                    },
                    desc=self_ref.meta.title,
                    message="Download failed before post-processing",
                )
                logger.debug(
                    "Skipping postprocess for failed track | job_id=%s track=%s",
                    job_id,
                    track_id,
                )
                return None
            result = await original_postprocess(self_ref, *args, **kwargs)
            tap._mark_track_status(
                job_id,
                track_id,
                status="downloaded",
                track_ctx={
                    "track_id": track_id,
                    "title": self_ref.meta.title,
                    "album": getattr(self_ref.meta.album, "album", None),
                    "tracknumber": self_ref.meta.tracknumber,
                    "discnumber": self_ref.meta.discnumber,
                },
                desc=self_ref.meta.title,
                message=None,
            )
            return result

        Track.postprocess = patched_postprocess  # type: ignore

    def start_job(self, job_id: str):
        self.job_totals[job_id] = {
            "tracks": {},
            "started_at": time.monotonic(),
            "finished": False,
        }
        self.latest_progress.pop(job_id, None)
        logger.info("Progress tracking started for job %s", job_id)

    def finish_job(self, job_id: str):
        summary = self.summarize_job(job_id)
        if job_id in self.job_totals:
            self.job_totals[job_id]["finished"] = True
        if job_id in self.latest_progress:
            self.latest_progress[job_id]["summary"] = summary
        else:
            self.latest_progress[job_id] = {
                "job_id": job_id,
                "summary": summary,
                "tracks": {},
            }
        self.job_totals.pop(job_id, None)
        logger.info(
            "Progress tracking finished for job %s | summary=%s", job_id, summary
        )

    def _patched_get_progress(self, enabled: bool, total: int, desc: str):
        handle = self.original_get_progress(enabled, total, desc)
        job_id = self.current_job.get() or "unknown"
        started = time.monotonic()
        state = self.job_totals.setdefault(
            job_id,
            {"tracks": {}, "started_at": started, "finished": False},
        )
        initial_track_ctx = self.current_track.get()
        track_id = (
            self._normalize_track_id(initial_track_ctx.get("track_id"))
            if initial_track_ctx
            else desc
        )

        def _update_totals(increment: int):
            # Track context may change while the download is in flight (e.g., retries).
            # Always pull the latest context so the UI stays in sync.
            track_ctx = self.current_track.get() or initial_track_ctx
            if track_ctx:
                track_ctx = dict(track_ctx)
                track_ctx["track_id"] = self._normalize_track_id(
                    track_ctx.get("track_id")
                )
            track_state = state["tracks"].setdefault(
                track_id,
                {
                    "received": 0,
                    "total": max(total, 1),
                    "title": desc,
                    "started_at": time.monotonic(),
                    "status": "downloading",
                },
            )
            track_state["started_at"] = track_state.get("started_at") or time.monotonic()
            track_state["total"] = total
            track_state["received"] = min(
                track_state["received"] + increment, total
            )
            if track_ctx:
                track_state["track_ctx"] = track_ctx
                track_state["title"] = track_ctx.get("title") or desc
            track_state["status"] = track_state.get("status") or "downloading"
            event_data = self._build_progress_event(
                job_id, track_id, track_state, track_ctx, desc, total_override=total
            )
            self.latest_progress[job_id] = event_data
            logger.debug(
                "Progress update | job_id=%s track_id=%s received=%s total=%s status=%s",
                job_id,
                track_id,
                track_state["received"],
                total,
                track_state.get("status"),
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
            _update_totals(total - state["tracks"].get(track_id, {}).get("received", 0))
            handle.done()

        return progress.Handle(update, done)

    def snapshot(self) -> dict[str, dict[str, Any]]:
        return dict(self.latest_progress)

    def _effective_total(self, track_state: dict[str, Any]) -> int:
        total = track_state.get("total") or 0
        return total if total > 0 else 1

    def summarize_job(self, job_id: str) -> dict[str, Any]:
        state = self.job_totals.get(job_id) or {}
        tracks = state.get("tracks", {})
        counts = Counter(t.get("status", "unknown") for t in tracks.values())
        total_tracks = len(tracks)
        summary = {
            "counts": dict(counts),
            "total_tracks": total_tracks,
            "downloaded": counts.get("downloaded", 0),
            "failed": counts.get("failed", 0),
            "skipped": counts.get("skipped", 0),
        }
        summary["all_downloaded"] = (
            total_tracks > 0 and summary["downloaded"] == total_tracks
        )
        return summary

    def _build_progress_event(
        self,
        job_id: str,
        track_id: str | int,
        track_state: dict[str, Any],
        track_ctx: dict | None,
        desc: str,
        *,
        total_override: int | None = None,
    ) -> dict[str, Any]:
        state = self.job_totals.setdefault(
            job_id,
            {"tracks": {}, "started_at": time.monotonic(), "finished": False},
        )
        track_id = self._normalize_track_id(track_id)
        state["tracks"][track_id] = track_state
        received_sum = sum(t.get("received", 0) for t in state["tracks"].values())
        total_sum = sum(self._effective_total(t) for t in state["tracks"].values()) or (
            total_override or track_state.get("total") or 1
        )
        elapsed = max(time.monotonic() - state.get("started_at", time.monotonic()), 0.0001)
        overall_rate = received_sum / elapsed
        track_elapsed = max(
            time.monotonic() - track_state.get("started_at", state.get("started_at", time.monotonic())),
            0.0001,
        )
        track_rate = track_state.get("received", 0) / track_elapsed
        eta_total = (
            (total_sum - received_sum) / overall_rate if overall_rate > 0 else None
        )
        per_track_eta = (
            (track_state.get("total", 0) - track_state.get("received", 0)) / track_rate
            if track_rate > 0
            else None
        )
        summary = self.summarize_job(job_id)
        event_data = {
            "job_id": job_id,
            "progress": {
                "track_id": track_id,
                "desc": desc,
                "received": track_state.get("received", 0),
                "total": track_state.get("total", 0),
                "eta": per_track_eta,
                "status": track_state.get("status"),
                "message": track_state.get("message"),
            },
            "overall": {
                "received": received_sum,
                "total": total_sum,
                "eta": eta_total,
            },
            "summary": summary,
            "tracks": {
                str(tid): {
                    "received": ts.get("received", 0),
                    "total": ts.get("total", 0),
                    "status": ts.get("status"),
                    "message": ts.get("message"),
                    "title": ts.get("title"),
                }
                for tid, ts in state["tracks"].items()
            },
        }
        if track_ctx:
            event_data |= {"track": track_ctx}
        return event_data

    def _mark_track_status(
        self,
        job_id: str | None,
        track_id: str | int | None,
        *,
        status: str,
        track_ctx: dict | None,
        desc: str,
        message: str | None = None,
        received: int | None = None,
        total: int | None = None,
    ):
        if job_id is None or track_id is None:
            return
        track_id = self._normalize_track_id(track_id)
        if track_ctx:
            track_ctx = dict(track_ctx)
            track_ctx["track_id"] = self._normalize_track_id(track_ctx.get("track_id"))
        state = self.job_totals.setdefault(
            job_id, {"tracks": {}, "started_at": time.monotonic(), "finished": False}
        )
        track_state = state["tracks"].setdefault(
            track_id,
            {
                "received": 0,
                "total": max(total or 1, 1),
                "title": desc,
                "started_at": time.monotonic(),
            },
        )
        if received is not None:
            track_state["received"] = received
        if total is not None:
            track_state["total"] = max(total, 1)
        track_state["status"] = status
        track_state["message"] = message
        track_state["title"] = track_ctx.get("title") if track_ctx else desc
        if track_ctx:
            track_state["track_ctx"] = track_ctx
        event_data = self._build_progress_event(
            job_id, track_id, track_state, track_ctx, desc
        )
        self.latest_progress[job_id] = event_data
        logger.debug(
            "Track status update | job_id=%s track_id=%s status=%s message=%s",
            job_id,
            track_id,
            status,
            message,
        )
        asyncio.create_task(
            self.broker.publish({"event": "progress", "data": event_data})
        )

    async def _download_with_tracking(
        self, track: Track, *args, **kwargs
    ) -> tuple[bool, str | None]:
        error_message: str | None = None
        success = False
        track._download_failed = False  # type: ignore[attr-defined]
        downloads_config = track.config.session.downloads
        async with global_download_semaphore(downloads_config):
            desc = f"Track {track.meta.tracknumber}"
            try:
                size = await track.downloadable.size()
            except Exception as exc:  # noqa: BLE001
                track._download_failed = True  # type: ignore[attr-defined]
                return False, str(exc)
            with progress.get_progress_callback(
                track.config.session.cli.progress_bars,
                size,
                desc,
            ) as callback:
                try:
                    await track.downloadable.download(track.download_path, callback)
                    success = True
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "Error downloading track '%s', retrying: %s",
                        track.meta.title,
                        exc,
                    )
                    error_message = str(exc)
                    success = False
            if success:
                return True, None

            desc_retry = f"{desc} (retry)"
            with progress.get_progress_callback(
                track.config.session.cli.progress_bars,
                size,
                desc_retry,
            ) as callback:
                try:
                    await track.downloadable.download(track.download_path, callback)
                    success = True
                except Exception as exc:  # noqa: BLE001
                    error_message = str(exc)
                    logger.error(
                        "Persistent error downloading track '%s', skipping: %s",
                        track.meta.title,
                        exc,
                    )
                    track.db.set_failed(
                        track.downloadable.source, "track", track.meta.info.id
                    )
                    track._download_failed = True  # type: ignore[attr-defined]

        if not success and error_message is None:
            error_message = "Download failed"
        return success, error_message


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
        self.display_order: List[str] = []
        self.worker: asyncio.Task | None = None
        self.lock = asyncio.Lock()

    def snapshot(self) -> list[dict]:
        valid_ids = [jid for jid in self.display_order if jid in self.queue]
        self.display_order = valid_ids
        return [self._item_to_dict(self.queue[jid]) for jid in valid_ids]

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
                    "url": item.url,
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
            "url": item.url,
            "status": item.status,
            "attempts": item.attempts,
            "error": item.error,
            "downloaded": item.downloaded,
            "force_no_db": item.force_no_db,
        }

    async def enqueue(self, entries: list[dict]):
        async with self.lock:
            for entry in entries:
                existing = next(
                    (
                        jid
                        for jid, queued in self.queue.items()
                        if queued.source == entry["source"]
                        and str(queued.item_id) == str(entry["id"])
                    ),
                    None,
                )
                if existing:
                    if existing not in self.display_order:
                        self.display_order.append(existing)
                    logger.info(
                        "Skipping duplicate enqueue | source=%s media_type=%s item_id=%s existing_job=%s",
                        entry.get("source"),
                        entry.get("media_type"),
                        entry.get("id"),
                        existing,
                    )
                    continue
                job_id = str(uuid.uuid4())
                item = QueueItem(
                    job_id=job_id,
                    source=entry["source"],
                    media_type=entry["media_type"],
                    item_id=entry["id"],
                    title=entry.get("title") or entry.get("name") or entry["id"],
                    artist=_stringify_artist(entry.get("artist")),
                    downloaded=entry.get("downloaded", False),
                    force_no_db=bool(entry.get("force_no_db") or entry.get("no_db")),
                )
                self.queue[job_id] = item
                self.order.append(job_id)
                if job_id not in self.display_order:
                    self.display_order.append(job_id)
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
                summary = self.progress_tap.summarize_job(item.job_id)
                if summary.get("all_downloaded"):
                    item.status = "completed"
                    item.downloaded = True
                    item.force_no_db = False
                    self._record_download(item)
                else:
                    item.status = "partial"
                    item.downloaded = False
                    item.error = (
                        f"Tracks failed: {summary.get('failed', 0)}; "
                        f"skipped: {summary.get('skipped', 0)}"
                    )
                logger.info(
                    "Job completed | job_id=%s attempts=%s summary=%s",
                    item.job_id,
                    item.attempts,
                    summary,
                )
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
                if item.status == "completed":
                    await self._drop_completed(item.job_id)
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

    async def _drop_completed(self, job_id: str):
        async with self.lock:
            self.queue.pop(job_id, None)
            if job_id in self.display_order:
                self.display_order.remove(job_id)
        self.progress_tap.latest_progress.pop(job_id, None)
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
        if item.force_no_db:
            config.session.database.downloads_enabled = False
            logger.info(
                "Bypassing downloads database for job %s (force_no_db enabled)",
                item.job_id,
            )
        logger.debug(
            "Launching streamrip Main for job %s | source=%s media_type=%s item_id=%s",
            item.job_id,
            item.source,
            item.media_type,
            item.item_id,
        )
        async with Main(config) as main:
            if item.source == "lastfm" or item.media_type == "lastfm":
                await main.resolve_lastfm(item.url or item.item_id)
                await main.rip()
                return
            if item.media_type == "url" or item.source == "url":
                await main.add_all([item.url or item.item_id])
            else:
                await main.add_all_by_id(
                    [(item.source, item.media_type, item.item_id)]
                )
            logger.debug("Resolved items for job %s; beginning rip", item.job_id)
            await main.resolve()
            await main.rip()

    async def enqueue_urls(self, urls: list[str]):
        entries = []
        for url in urls:
            is_lastfm = _is_lastfm_url(url)
            normalized_url = (
                url.replace("://last.fm", "://www.last.fm", 1)
                if is_lastfm and "://last.fm" in url
                else url
            )
            source = "lastfm" if is_lastfm else "url"
            media_type = "lastfm" if is_lastfm else "url"
            entries.append(
                {
                    "source": source,
                    "media_type": media_type,
                    "id": normalized_url,
                    "title": normalized_url,
                    "url": normalized_url,
                }
            )
        return await self.enqueue(entries)

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
                        "url": item.url,
                    }
                ]
            )
            logger.info("Saved job for later | job_id=%s", job_id)
        await self.event_broker.publish(
            {"event": "saved", "data": self.saved_store.list()}
        )

    async def retry(self, job_id: str, *, force_no_db: bool = False):
        if job_id not in self.queue:
            return
        item = self.queue[job_id]
        item.status = "queued"
        item.error = None
        item.downloaded = False
        if force_no_db:
            item.force_no_db = True
        logger.info(
            "Retrying job %s | force_no_db=%s attempts=%s",
            job_id,
            force_no_db,
            item.attempts,
        )
        async with self.lock:
            self.order.append(job_id)
            if self.worker is None or self.worker.done():
                self.worker = asyncio.create_task(self._worker())
        await self.event_broker.publish(
            {"event": "queue", "data": self._queue_payload()}
        )

    async def abort(self, job_id: str):
        async with self.lock:
            item = self.queue.get(job_id)
            if not item:
                return
            item.status = "aborted"
            if job_id in self.order:
                self.order.remove(job_id)
            if job_id in self.display_order:
                self.display_order.remove(job_id)
            self.queue.pop(job_id, None)
        self.progress_tap.latest_progress.pop(job_id, None)
        self.progress_tap.job_totals.pop(job_id, None)
        logger.warning("Aborted job %s", job_id)
        await self.event_broker.publish(
            {"event": "queue", "data": self._queue_payload()}
        )

    async def force_redownload(self, job_id: str):
        logger.info("Force re-download requested | job_id=%s", job_id)
        await self.retry(job_id, force_no_db=True)

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
