import os
import uvicorn
from utils.logger import log
from database.db import engine, Base, ensure_db_settings
from ingest.chains import load_env_file
from api.server import app

# Load crypto-data-collector/.env so RPC_HTTP_* / chain registry env vars
# are visible to the API process (GET /chains enabled flag, etc.). The
# collector does this in its own startup; the API server needs it too.
load_env_file()

def init_database():
    """Create all DB tables if they don't exist; run per-dialect setup."""
    log.info("Ensuring database tables exist...")
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    log.info("Database tables ready.")

if __name__ == "__main__":
    log.info("=== Starting Haven API Server ===")

    # Create DB tables if they don't exist
    init_database()

    # Railway/most hosts inject $PORT; default to 8000 for local/solo.
    port = int(os.environ.get("PORT", "8000"))
    log.info(f"Starting API Server on 0.0.0.0:{port} ...")
    try:
        # uvicorn.run blocks the main thread
        uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
    except KeyboardInterrupt:
        log.info("Caught shutdown signal (Ctrl+C).")
        log.info("=== Shutdown Complete ===")
