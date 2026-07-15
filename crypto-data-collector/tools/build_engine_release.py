"""Build signed Windows and Linux Haven engine installers.

Windows releases are NSIS ``.exe`` installers. Linux releases are ``.tar.gz``
bundles containing a current-user installer. Neither bundle contains wallet
credentials or a plaintext credential fallback.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "crypto-data-collector" / "api" / "static"
LINUX_OUTPUT = OUTPUT_DIR / "haven-engine-linux.tar.gz"
WINDOWS_OUTPUT = OUTPUT_DIR / "haven-engine-windows-installer.exe"
ENGINE_FILES = (
    "api-client.js", "chain.js", "create-wallet.js", "credential-store.js",
    "engine.js", "finder-runner.js", "index.js", "package.json", "package-lock.json",
    "pure.js", "run.bat", "run.sh", "sandbox-runtime.js", "setup.bat", "setup.js",
    "setup.sh", "strategy-runner.js", ".env.example",
)


def _canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _engine_sources() -> list[tuple[Path, str]]:
    files: list[tuple[Path, str]] = []
    for name in ENGINE_FILES:
        source = ROOT / "marker-engine" / name
        if not source.is_file():
            raise RuntimeError(f"required engine release file is missing: {name}")
        files.append((source, f"marker-engine/{name}"))
    sdk = ROOT / "strategy-sdk"
    for source in sorted([*sdk.glob("*.json"), *sdk.glob("src/*.js"), *sdk.glob("docs/*.md")]):
        files.append((source, f"strategy-sdk/{source.relative_to(sdk).as_posix()}"))
    return files


def _write_tar_file(archive: tarfile.TarFile, source: Path, destination: str) -> None:
    info = tarfile.TarInfo(destination)
    info.size = source.stat().st_size
    info.mode = 0o755 if source.suffix == ".sh" else 0o644
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    with source.open("rb") as handle:
        archive.addfile(info, handle)


def _sign(output: Path, private_key: Ed25519PrivateKey, version: str) -> None:
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    unsigned = {"version": version, "sha256": digest,
                "created_at": int(time.time()), "algorithm": "Ed25519"}
    manifest = {**unsigned, "signature": base64.b64encode(
        private_key.sign(_canonical(unsigned))).decode()}
    output.with_name(output.name + ".manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf8")


def build_linux_release(private_key: Ed25519PrivateKey, version: str,
                        output: Path = LINUX_OUTPUT) -> Path:
    """Create a reproducible Linux installer archive and its signed manifest."""
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w") as archive:
            _write_tar_file(archive, ROOT / "marker-engine" / "install.sh", "haven-engine/install.sh")
            for source, destination in _engine_sources():
                _write_tar_file(archive, source, f"haven-engine/{destination}")
    _sign(output, private_key, version)
    return output


def _stage_windows_sources(stage: Path) -> None:
    for source, destination in _engine_sources():
        target = stage / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def build_windows_release(private_key: Ed25519PrivateKey, version: str,
                          output: Path = WINDOWS_OUTPUT) -> Path:
    """Build and sign the Windows NSIS installer. Releases must run this on a Windows builder."""
    makensis = shutil.which("makensis")
    if not makensis:
        raise RuntimeError("NSIS (makensis) is required to build the Windows installer")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="haven-engine-") as temp:
        stage = Path(temp) / "stage"
        _stage_windows_sources(stage)
        command = [makensis, f"/DOUTFILE={output}", f"/DSTAGE={stage}",
                   str(ROOT / "marker-engine" / "installer.nsi")]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode:
            raise RuntimeError(f"NSIS failed: {(result.stderr or result.stdout).strip()}")
    if not output.is_file():
        raise RuntimeError("NSIS did not produce the Windows installer")
    _sign(output, private_key, version)
    return output


def main() -> None:
    encoded_key = os.environ.get("HAVEN_ENGINE_RELEASE_PRIVATE_KEY", "").strip()
    version = os.environ.get("HAVEN_ENGINE_RELEASE_VERSION", "").strip()
    if not encoded_key or not version:
        raise RuntimeError("HAVEN_ENGINE_RELEASE_PRIVATE_KEY and HAVEN_ENGINE_RELEASE_VERSION are required")
    private_key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(encoded_key))
    linux = build_linux_release(private_key, version)
    windows = build_windows_release(private_key, version)
    print(f"Signed engine releases {version}: {linux.name}, {windows.name}")


if __name__ == "__main__":
    main()
