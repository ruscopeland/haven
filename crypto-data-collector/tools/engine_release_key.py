"""Manage Haven's local Windows-protected engine release signing key.

The private key is encrypted with Windows DPAPI for the current user and lives
outside the repository. This tool never prints the private key.
"""

from __future__ import annotations

import argparse
import base64
import os
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


LOCAL_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Haven"
PRIVATE_PATH = LOCAL_DIR / "engine-release-signing.dpapi"
PUBLIC_PATH = LOCAL_DIR / "engine-release-signing.public.txt"


def _powershell(script: str, value: str) -> str:
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        input=value, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr or "Windows key-store operation failed").strip())
    return result.stdout.strip()


def _protect(value: str) -> str:
    return _powershell(
        "Add-Type -AssemblyName System.Security; "
        "$plain = [Console]::In.ReadToEnd(); "
        "$bytes = [Text.Encoding]::UTF8.GetBytes($plain); "
        "$protected = [System.Security.Cryptography.ProtectedData]::Protect("
        "$bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
        "[Convert]::ToBase64String($protected)", value)


def _unprotect(value: str) -> str:
    return _powershell(
        "Add-Type -AssemblyName System.Security; "
        "$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); "
        "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect("
        "$protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
        "[Text.Encoding]::UTF8.GetString($plain)", value)


def _private_key() -> str:
    if not PRIVATE_PATH.is_file():
        raise RuntimeError("No local engine release key exists; initialize it through an authorized rotation.")
    return _unprotect(PRIVATE_PATH.read_text(encoding="utf8"))


def initialize() -> None:
    if PRIVATE_PATH.exists() or PUBLIC_PATH.exists():
        raise RuntimeError("A local engine release key already exists; refusing to replace it.")
    private = Ed25519PrivateKey.generate()
    private_b64 = base64.b64encode(private.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
        serialization.NoEncryption())).decode()
    public_b64 = base64.b64encode(private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    PRIVATE_PATH.write_text(_protect(private_b64), encoding="utf8")
    PUBLIC_PATH.write_text(public_b64 + "\n", encoding="utf8")
    print(f"Created a Windows-protected local release key at {PRIVATE_PATH}")
    print(f"Public key saved at {PUBLIC_PATH}")


def copy_private_for_github() -> None:
    """Place the private value on the local clipboard for one-time secret entry."""
    _powershell("Set-Clipboard -Value ([Console]::In.ReadToEnd())", _private_key())
    print("Private release key copied to the local clipboard for GitHub secret entry.")


def run_build(version: str) -> None:
    env = {**os.environ, "HAVEN_ENGINE_RELEASE_PRIVATE_KEY": _private_key(),
           "HAVEN_ENGINE_RELEASE_VERSION": version}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([sys.executable, str(root / "crypto-data-collector" / "tools" /
                                                "build_engine_release.py")],
                            cwd=root, env=env, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("initialize")
    commands.add_parser("status")
    commands.add_parser("copy-private-for-github")
    build = commands.add_parser("build")
    build.add_argument("--version", required=True)
    args = parser.parse_args()

    if args.command == "initialize":
        initialize()
    elif args.command == "status":
        print(f"Local protected key: {'present' if PRIVATE_PATH.is_file() else 'missing'}")
        print(f"Public key: {'present' if PUBLIC_PATH.is_file() else 'missing'}")
    elif args.command == "copy-private-for-github":
        copy_private_for_github()
    else:
        run_build(args.version)


if __name__ == "__main__":
    main()
