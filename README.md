## Overview

Streamrip Web is a FastAPI-powered web UI for the [streamrip](https://github.com/nathom/streamrip) downloader. It lets you:

- Search across supported sources (Qobuz, Tidal, Deezer, SoundCloud) and media types.
- Submit direct URLs for streamrip to resolve and download.
- Queue downloads and monitor progress in real time through Server-Sent Events.
- Retry, abort, and save items for later from the queue.
- Manage your streamrip configuration from a browser-based settings panel.

The application stores runtime data (such as saved items and cached version info) in the local `data/` directory that is created on startup.

## Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/nathom/streamripweb.git
   cd streamripweb
   ```

2. **Create a virtual environment (recommended)**

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

3. **Install dependencies**

   ```bash
   pip install --upgrade pip
   pip install -r requirements.txt
   ```

   The app depends on `streamrip`, `fastapi`, `uvicorn`, `jinja2`, and `sse-starlette`. If you prefer using the development branch of streamrip, uncomment the Git dependency noted in `requirements.txt`.

## Configuration

Streamrip Web reads and writes the same configuration used by the `streamrip` CLI (default: `~/.config/streamrip/config.toml`). On first run, a default config file is created if one does not already exist.

You can configure credentials and download preferences in two ways:

- **From the UI:** Open the **Settings** tab in the web app to edit config values directly. Only known keys from the streamrip schema are persisted.
- **From the CLI:** Run `streamrip configure` or edit the config file manually. Streamrip Web will reflect changes on reload.

Any updates made in the UI are validated against streamrip’s dataclass-backed schema to avoid writing unexpected keys.

## Startup

Launch the application with Uvicorn (default port 8500):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8500
```

Then open http://localhost:8500/ in your browser. The server auto-creates the `data/` directory and refreshes version metadata at startup. To run with live reload during development, add the `--reload` flag to the Uvicorn command.

## Usage

- **Search**: Choose a source and media type, enter a query, and queue any returned items for download. Progress appears in the queue view.
- **URL download**: Open the **URL** tab, paste one or more streamrip-supported URLs (one per line), and start the download. Progress appears in the queue; the input field clears automatically once all URLs finish successfully.
- **Saved for later**: Recover failed or deferred downloads and retry them at any time.
