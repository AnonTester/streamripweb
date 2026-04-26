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
   git clone https://github.com/AnonTester/streamripweb.git
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
   Also, make sure [ffmpeg](https://ffmpeg.org/download.html) is installed - it is used to convert downloaded tracks to different formats.

## Docker

You can run Streamrip Web in Docker with either `docker compose` (recommended) or `docker run`.

### Docker Compose (recommended)

1. Review and edit the host volume paths in [`docker-compose.yml`](docker-compose.yml):

   - `/opt/streamripweb:/app/data` stores persistent app data and streamrip config.
   - `/media/music/other/deemix Music/:/download` is the output directory for downloads.

2. Build and start:

   ```bash
   docker compose up -d --build
   ```

3. Open the UI:

   http://localhost:8500/

4. In **Settings**, set the streamrip downloads folder to `/download` so downloads go to your mapped host directory.

5. Useful commands:

   ```bash
   docker compose logs -f streamripweb
   docker compose down
   ```

### Docker CLI (alternative)

```bash
docker build -t streamripweb:latest .

docker run -d \
  --name streamripweb \
  -p 8500:8500 \
  -e XDG_CONFIG_HOME=/app/data \
  -v /opt/streamripweb:/app/data \
  -v /path/to/your/music:/download \
  --restart unless-stopped \
  streamripweb:latest
```

Then open http://localhost:8500/.


## Configuration

Streamrip Web reads and writes the same configuration used by the `streamrip` CLI (default: `~/.config/streamrip/config.toml`). On first run, a default config file is created if one does not already exist.

You can configure credentials and download preferences in two ways:

- **From the UI:** Open the **Settings** tab in the web app to edit config values directly. Only known keys from the streamrip schema are persisted.
- **From the CLI:** Run `streamrip configure` or edit the config file manually. Streamrip Web will reflect changes on reload.

Any updates made in the UI are validated against streamrip’s dataclass-backed schema to avoid writing unexpected keys.

## Authentication

To authenticate a client, the `login` method of the `Client` must be used. This documents the parameters you need to pass for each source.

### Qobuz

- `email`: The email used for the account
- `pwd`: The md5 hash of the account password.
- (optional) `app_id`: If this is passed in, `QobuzClient` won't scrape it again.
- (optional) `secrets`: If this is passed in, `QobuzClient` won't scrape it again.

### TIDAL

These are all fetched by the client, but can be passed in to save time.

- `user_id`
- `country_code`
- `access_token`
- `refresh_token`

**Note**: Due to changes in Tidal authentication, streamrip needs to be patched with different client id/secret keys as described in this [streamrip bug report](https://github.com/nathom/streamrip/issues/896)

### Deezer

- `arl`: See [Finding your ARL](https://github.com/nathom/streamrip/wiki/Finding-Your-Deezer-ARL-Cookie)


## Startup

Activate the virtual environment if used:
```bash
source .venv/bin/activate
```

then launch the application with Uvicorn (default port 8500):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8500
```

Or use the startup script:

```bash
python start.py
```

Then open http://localhost:8500/ in your browser. The server auto-creates the `data/` directory and refreshes version metadata at startup. To run with live reload during development, add the `--reload` flag to the Uvicorn command.


## Usage

- **Search**: Choose a source and media type, enter a query, and queue any returned items for download. Progress appears in the queue view.
- **URL download**: Open the **URL** tab, paste one or more streamrip-supported URLs (one per line), and start the download. Progress appears in the queue; the input field clears automatically once all URLs finish successfully.
- **Saved for later**: Recover failed or deferred downloads and retry them at any time.
