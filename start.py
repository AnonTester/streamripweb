from app.main import app, get_configured_port, load_app_settings


if __name__ == "__main__":
    import uvicorn

    settings = load_app_settings()
    uvicorn.run(app, host="0.0.0.0", port=get_configured_port(settings))
