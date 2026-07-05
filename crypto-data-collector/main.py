import uvicorn
from utils.logger import log
from database.db import engine, Base, ensure_db_settings
from api.server import app

def init_database():
    """Create all DB tables if they don't exist and enable WAL mode."""
    log.info("Ensuring database tables exist...")
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    log.info("Database tables ready (WAL mode enabled).")

if __name__ == "__main__":
    log.info("=== Starting Alpha API Server ===")
    
    # Create DB tables if they don't exist
    init_database()
    
    log.info("Starting API Server on http://localhost:8000 ...")
    try:
        # uvicorn.run blocks the main thread
        uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
    except KeyboardInterrupt:
        log.info("Caught shutdown signal (Ctrl+C).")
        log.info("=== Shutdown Complete ===")
