"""Build a deterministic Haven engine archive and Ed25519-signed manifest."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "crypto-data-collector" / "api" / "static" / "haven-engine.zip"
ENGINE_FILES = (
    "api-client.js", "chain.js", "create-wallet.js", "credential-store.js",
    "engine.js", "finder-runner.js", "index.js", "package.json", "package-lock.json",
    "pure.js", "run.bat", "sandbox-runtime.js", "setup.bat", "setup.js",
    "strategy-runner.js", ".env.example",
)


def _canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _write_reproducible(archive: zipfile.ZipFile, source: Path, destination: str) -> None:
    """Write stable bytes and metadata so identical source produces identical archives."""
    info = zipfile.ZipInfo(destination, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED,
                     compresslevel=9)


def main() -> None:
    encoded_key = os.environ.get("HAVEN_ENGINE_RELEASE_PRIVATE_KEY", "").strip()
    version = os.environ.get("HAVEN_ENGINE_RELEASE_VERSION", "").strip()
    if not encoded_key or not version:
        raise RuntimeError("HAVEN_ENGINE_RELEASE_PRIVATE_KEY and HAVEN_ENGINE_RELEASE_VERSION are required")
    private_key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(encoded_key))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in ENGINE_FILES:
            source = ROOT / "marker-engine" / name
            if not source.is_file():
                raise RuntimeError(f"required engine release file is missing: {name}")
            _write_reproducible(archive, source, f"haven-engine/marker-engine/{name}")
        sdk = ROOT / "strategy-sdk"
        for source in sorted([*sdk.glob("*.json"), *sdk.glob("src/*.js"), *sdk.glob("docs/*.md")]):
            _write_reproducible(
                archive, source, f"haven-engine/strategy-sdk/{source.relative_to(sdk).as_posix()}")
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    unsigned = {"version": version, "sha256": digest,
                "created_at": int(time.time()), "algorithm": "Ed25519"}
    manifest = {**unsigned, "signature": base64.b64encode(
        private_key.sign(_canonical(unsigned))).decode()}
    OUTPUT.with_suffix(".zip.manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    print(f"Signed engine release {version}: {digest}")


if __name__ == "__main__":
    main()
