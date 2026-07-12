"""Build haven-engine.zip — the desktop engine customers download.

Layout inside the zip (preserves the engine's `../strategy-sdk` import):

    haven-engine/        <- the marker-engine, renamed for customers
      index.js, engine.js, pure.js, chain.js, strategy-runner.js, finder-runner.js
      package.json, setup.js, setup.bat, run.bat, .env.example, README.txt
    strategy-sdk/
      src/**            <- shared runtime the engine imports

Secrets (.env), node_modules, and tests are deliberately excluded. The output
lands in crypto-data-collector/api/static/ so GET /engine/download can serve it.

Run:  python tools/build_engine_zip.py
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "crypto-data-collector", "api", "static")
OUT_ZIP = os.path.join(OUT_DIR, "haven-engine.zip")

# marker-engine files that ship (everything the daemon needs at runtime).
ENGINE_FILES = [
    "index.js", "engine.js", "pure.js", "chain.js", "api-client.js",
    "strategy-runner.js", "finder-runner.js", "create-wallet.js",
    "package.json", "setup.js", "setup.bat", "run.bat", ".env.example",
]

README = """Haven Engine
============

Runs on your computer and executes your Haven live trades.

FIRST TIME
  1. Install Node.js (LTS) from https://nodejs.org if you don't have it.
  2. Double-click  setup.bat  and follow the prompts:
       - paste your connection key (Haven website -> Settings ->
         "Connect your engine")
       - choose [1] Create a new wallet (default)
       - copy the seed phrase offline, then confirm two words
  3. Double-click  run.bat  to start. Leave the window open.

EVERY TIME AFTER
  Just double-click  run.bat.  Close the window to stop.

IMPORTANT
  - Live trades only run while this program is open and your computer is on.
  - Save your seed phrase. If you lose it, the wallet cannot be recovered.
  - Fund the wallet address printed at the end of setup before live trades.
"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    eng_dir = os.path.join(ROOT, "marker-engine")
    sdk_dir = os.path.join(ROOT, "strategy-sdk")

    with zipfile.ZipFile(OUT_ZIP, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ENGINE_FILES:
            src = os.path.join(eng_dir, name)
            if os.path.exists(src):
                z.write(src, f"haven-engine/{name}")
            else:
                print(f"  ! missing (skipped): {name}")
        z.writestr("haven-engine/README.txt", README)

        # strategy-sdk/src/** + its package.json (skip node_modules/tests).
        for base, _dirs, files in os.walk(os.path.join(sdk_dir, "src")):
            for f in files:
                if f.endswith((".test.js",)):
                    continue
                full = os.path.join(base, f)
                rel = os.path.relpath(full, sdk_dir)
                z.write(full, f"strategy-sdk/{rel}".replace(os.sep, "/"))
        sdk_pkg = os.path.join(sdk_dir, "package.json")
        if os.path.exists(sdk_pkg):
            z.write(sdk_pkg, "strategy-sdk/package.json")

    size_kb = os.path.getsize(OUT_ZIP) // 1024
    print(f"Built {OUT_ZIP} ({size_kb} KB)")


if __name__ == "__main__":
    main()
