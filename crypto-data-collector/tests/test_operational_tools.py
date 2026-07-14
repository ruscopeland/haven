import base64
import hashlib
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tools import build_engine_release


def test_engine_release_is_reproducible_and_signature_verifies(monkeypatch, tmp_path):
    private = Ed25519PrivateKey.generate()
    encoded = base64.b64encode(private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )).decode()
    output = tmp_path / "haven-engine.zip"
    monkeypatch.setattr(build_engine_release, "OUTPUT", output)
    monkeypatch.setenv("HAVEN_ENGINE_RELEASE_PRIVATE_KEY", encoded)
    monkeypatch.setenv("HAVEN_ENGINE_RELEASE_VERSION", "test-1")

    build_engine_release.main()
    first_digest = hashlib.sha256(output.read_bytes()).hexdigest()
    build_engine_release.main()
    assert hashlib.sha256(output.read_bytes()).hexdigest() == first_digest

    manifest = json.loads(output.with_suffix(".zip.manifest.json").read_text(encoding="utf8"))
    signature = base64.b64decode(manifest.pop("signature"))
    private.public_key().verify(signature, json.dumps(
        manifest, sort_keys=True, separators=(",", ":")).encode())
    assert manifest["sha256"] == first_digest
