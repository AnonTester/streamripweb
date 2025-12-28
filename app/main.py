import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.request import urlopen, Request

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config_manager import StreamripConfigManager
from .download_manager import DownloadManager

try:  # Prefer sse-starlette if available for nicer handling
    from sse_starlette.sse import EventSourceResponse

    def sse_response(generator):
        return EventSourceResponse(generator)

except Exception:  # pragma: no cover - fallback to StreamingResponse

    def sse_response(generator):
        return StreamingResponse(generator, media_type="text/event-stream")


APP_VERSION = "0.1.1"
APP_REPO = os.getenv("STREAMRIP_WEB_REPO", "nathom/streamripweb")
STREAMRIP_REPO = os.getenv("STREAMRIP_REPO", "nathom/streamrip")

app = FastAPI(title="Streamrip Web", docs_url=None, redoc_url=None)
base_dir = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(base_dir, "..", "templates"))
config_manager = StreamripConfigManager()
data_dir = os.path.join(os.path.dirname(base_dir), "data")
saved_path = os.path.join(data_dir, "saved_for_later.json")
version_cache_path = os.path.join(data_dir, "version_cache.json")
download_manager = DownloadManager(config_manager, saved_path)

app.mount(
    "/static",
    StaticFiles(directory=os.path.join(base_dir, "..", "static")),
    name="static",
)


@app.on_event("startup")
async def on_startup():
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    await refresh_versions(force=False)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    config_snapshot = config_manager.export()
    version_data = await get_version_data()
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "config": config_snapshot,
            "saved": download_manager.saved_items(),
            "versions": version_data,
            "app_version": APP_VERSION,
        },
    )


@app.get("/events/downloads")
async def download_events():
    async def event_generator():
        async for event in download_manager.event_broker.subscribe():
            yield format_sse(event)

    return sse_response(event_generator())


@app.get("/api/config")
async def get_config():
    return config_manager.export()


@app.post("/api/config")
async def update_config(payload: Dict[str, Dict[str, Any]]):
    return config_manager.update(payload)


@app.get("/api/queue")
async def queue_state():
    return {"queue": download_manager.snapshot()}


@app.post("/api/queue/{job_id}/retry")
async def retry_job(job_id: str):
    await download_manager.retry(job_id)
    return {"queue": download_manager.snapshot()}


@app.post("/api/queue/{job_id}/abort")
async def abort_job(job_id: str):
    await download_manager.abort(job_id)
    return {"queue": download_manager.snapshot()}


@app.post("/api/queue/{job_id}/save")
async def save_job(job_id: str):
    await download_manager.save_for_later(job_id=job_id)
    return {"saved": download_manager.saved_items()}


@app.get("/api/saved")
async def saved_items():
    return {"saved": download_manager.saved_items()}


@app.post("/api/saved")
async def save_item(payload: Dict[str, Any]):
    await download_manager.save_for_later(payload=payload)
    return {"saved": download_manager.saved_items()}


@app.post("/api/saved/remove")
async def remove_saved(payload: Dict[str, Any]):
    await download_manager.remove_saved(payload)
    return {"saved": download_manager.saved_items()}


@app.post("/api/saved/download")
async def download_saved(payload: Dict[str, Any] | None = None):
    entries = payload.get("items") if payload else None
    await download_manager.download_saved(entries)
    return {"queue": download_manager.snapshot()}


@app.post("/api/search")
async def search(payload: Dict[str, Any]):
    required = {"source", "media_type", "query"}
    if not required.issubset(payload):
        missing = required - set(payload.keys())
        raise HTTPException(status_code=400, detail=f"Missing fields: {missing}")

    limit = int(payload.get("limit", 25))
    source = payload["source"]
    media_type = payload["media_type"]
    query = payload["query"]

    from streamrip.metadata.search_results import SearchResults
    from streamrip.rip.main import Main

    config = config_manager.load()
    results: List[Dict[str, Any]] = []
    async with Main(config) as main:
        client = await main.get_logged_in_client(source)
        pages = await client.search(media_type, query, limit=limit)
        if len(pages) == 0:
            return {"results": []}

        parsed = SearchResults.from_pages(source, media_type, pages)
        # Acquire flattened items from the raw pages to preserve metadata columns
        flattened: list[dict] = []
        for page in pages:
            flattened.extend(extract_items_from_page(page, source, media_type))

        downloaded_ids = set()
        try:
            downloaded_ids = {row[0] for row in main.database.downloads.all()}
        except Exception:
            pass

        for summary, raw in zip(parsed.results, flattened):
            entry = summarize_item(raw, summary, media_type, source)
            entry["downloaded"] = summary.id in downloaded_ids
            results.append(entry)

    return {"results": results}


@app.post("/api/downloads")
async def start_download(payload: Dict[str, Any]):
    items = payload.get("items", [])
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be a list")
    queue = await download_manager.enqueue(items)
    return {"queue": queue}


@app.get("/api/version")
async def api_version():
    return await get_version_data()


def extract_items_from_page(page: dict, source: str, media_type: str) -> list[dict]:
    if source == "soundcloud":
        return list(page.get("collection", []))
    if source == "qobuz":
        return list(page.get(media_type + "s", {}).get("items", []))
    if source == "deezer":
        return list(page.get("data", []))
    if source == "tidal":
        return list(page.get("items", []))
    return []


def _stringify_artist(value: Any) -> str | None:
    """Normalize artist field to a readable string."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("name") or value.get("artist") or value.get("title")
    if isinstance(value, list):
        parts = [
            _stringify_artist(item)
            for item in value
            if _stringify_artist(item) is not None
        ]
        return ", ".join([p for p in parts if p])
    return str(value)


def _extract_year(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return str(int(value))
    if isinstance(value, str):
        return value[:4]
    if isinstance(value, dict):
        for key in ("year", "release_year", "releaseYear"):
            if key in value and value[key]:
                return str(value[key])[:4]
    return None


def summarize_item(
    raw: dict, summary_obj: Any, media_type: str, source: str
) -> dict:
    artist = _stringify_artist(
        raw.get("performer", {}).get("name")
        or raw.get("artist")
        or raw.get("artist", {}).get("name")
        or (raw.get("publisher_metadata") and raw["publisher_metadata"].get("artist"))
        or raw.get("user", {}).get("username")
        or summary_obj.__dict__.get("artist")
    )
    release = (
        raw.get("release_date_original")
        or raw.get("release_date")
        or raw.get("releaseDate")
        or raw.get("streamStartDate")
        or raw.get("display_date")
        or raw.get("date")
        or raw.get("year")
    )
    album_type = (
        raw.get("record_type")
        or raw.get("type")
        or raw.get("album_type")
        or raw.get("version")
    )
    tracks = (
        raw.get("tracks_count")
        or raw.get("numberOfTracks")
        or raw.get("nb_tracks")
        or len(raw.get("tracks", []) or raw.get("items", []))
    )
    explicit = (
        raw.get("explicit")
        or raw.get("explicit_lyrics")
        or raw.get("explicitContent")
        or raw.get("explicitFlag")
        or False
    )
    title = raw.get("title") or raw.get("name") or summary_obj.__dict__.get("name")

    return {
        "id": str(raw.get("id") or summary_obj.id),
        "source": raw.get("source") or summary_obj.__dict__.get("source") or source,
        "media_type": media_type,
        "title": title,
        "artist": artist,
        "album_type": album_type,
        "tracks": tracks,
        "year": _extract_year(release),
        "explicit": bool(explicit),
        "summary": getattr(summary_obj, "summarize", lambda: title)(),
    }


def format_sse(event: Dict[str, Any]) -> str:
    data = event.get("data", {})
    name = event.get("event", "message")
    payload = f"event: {name}\ndata: {json.dumps(data)}\n\n"
    return payload


def _load_cache() -> dict:
    try:
        with open(version_cache_path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return {}


def _write_cache(cache: dict):
    Path(version_cache_path).parent.mkdir(parents=True, exist_ok=True)
    with open(version_cache_path, "w") as f:
        json.dump(cache, f, indent=2)


async def get_version_data() -> dict:
    cache = _load_cache()
    if cache:
        return cache
    await refresh_versions(force=True)
    return _load_cache()


def _http_get_json(url: str) -> dict:
    req = Request(url, headers={"Accept": "application/vnd.github+json"})
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _latest_commit_sha(repo: str) -> str | None:
    try:
        res = _http_get_json(f"https://api.github.com/repos/{repo}/commits?per_page=1")
        if isinstance(res, list) and res:
            return res[0].get("sha")
    except Exception:
        return None
    return None


def _latest_release(repo: str) -> Tuple[str | None, str | None]:
    try:
        res = _http_get_json(f"https://api.github.com/repos/{repo}/releases/latest")
        tag = res.get("tag_name")
        html_url = res.get("html_url")
        return tag, html_url
    except Exception:
        return None, None


def _streamrip_install_source() -> str:
    """Return 'git' if installed from VCS, else 'release'."""
    try:
        import importlib.util

        spec = importlib.util.find_spec("streamrip")
        if spec is None or spec.origin is None:
            return "release"
        pkg_path = Path(spec.origin).parent
        for candidate in pkg_path.glob("streamrip-*.dist-info/direct_url.json"):
            try:
                data = json.loads(candidate.read_text())
                if data.get("vcs_info"):
                    return "git"
            except Exception:
                continue
    except Exception:
        return "release"
    return "release"


async def refresh_versions(force: bool):
    cache = _load_cache()
    now = time.time()
    if cache and not force:
        if now - cache.get("checked_at", 0) < 60 * 60 * 24:
            return

    from streamrip import __version__ as streamrip_version

    streamrip_source = _streamrip_install_source()
    app_latest = _latest_commit_sha(APP_REPO)

    if streamrip_source == "git":
        streamrip_latest = _latest_commit_sha(STREAMRIP_REPO)
        streamrip_latest_label = streamrip_latest
    else:
        tag, url = _latest_release(STREAMRIP_REPO)
        streamrip_latest = tag
        streamrip_latest_label = tag or "unknown"

    cache = {
        "checked_at": now,
        "app": {
            "version": APP_VERSION,
            "latest": app_latest,
            "repo": APP_REPO,
        },
        "streamrip": {
            "version": streamrip_version,
            "latest": streamrip_latest_label,
            "source": streamrip_source,
            "repo": STREAMRIP_REPO,
        },
    }
    _write_cache(cache)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
