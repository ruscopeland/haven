import os
import logging
import uvicorn
from api.server import app

log = logging.getLogger("haven")

if __name__ == "__main__":
    log.info("=== Starting Haven API Server ===")

    # Railway/most hosts inject $PORT; default to 8000 for local/solo.
    port = int(os.environ.get("PORT", "8000"))
    log.info(f"Starting API Server on 0.0.0.0:{port} ...")
    try:
        uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
    except KeyboardInterrupt:
        log.info("Caught shutdown signal (Ctrl+C).")
        log.info("=== Shutdown Complete ===")
