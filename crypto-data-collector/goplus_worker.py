"""Long-running GoPlus worker window (started by start.bat).

Runs small batches forever within the daily budget so scanning is visible
and continuous without burning free-tier quota in one burst.

  python goplus_worker.py
"""
import os
import sys
import time

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import Base, engine, ensure_db_settings
from ingest.chains import load_env_file
from ingest.goplus import run_scan, GoPlusClient
from ingest.store import log


def main():
    load_env_file()
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    client = GoPlusClient()
    if not client.configured:
        log("GoPlus worker: GOPLUS_APP_KEY/SECRET missing in .env — idle", "ERROR")
        while True:
            time.sleep(3600)

    batch = int(os.environ.get("GOPLUS_WORKER_BATCH", "25"))
    sleep_when_idle = int(os.environ.get("GOPLUS_WORKER_IDLE_SEC", "900"))  # 15m
    sleep_between = int(os.environ.get("GOPLUS_WORKER_LOOP_SEC", "120"))   # 2m

    log(f"GoPlus worker started (batch={batch}/loop, budget={client.daily_budget}/day)")
    while True:
        try:
            client = GoPlusClient()  # refresh usage from disk
            if client.remaining_budget() <= 0:
                log(f"Haven local GoPlus address cap exhausted for today "
                    f"({client.daily_budget}/day, GOPLUS_DAILY_BUDGET) — not GoPlus CU. Sleep 30m")
                time.sleep(1800)
                continue
            result = run_scan(max_addresses=min(batch, client.remaining_budget()))
            log(f"GoPlus worker: {result}")
            if result.get("scanned", 0) == 0:
                time.sleep(sleep_when_idle)
            else:
                time.sleep(sleep_between)
        except KeyboardInterrupt:
            log("GoPlus worker stopped")
            break
        except Exception as e:
            log(f"GoPlus worker error: {e}", "ERROR")
            time.sleep(60)


if __name__ == "__main__":
    main()
