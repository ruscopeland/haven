import base64
import io
import hashlib
import json
import tarfile

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
    output = tmp_path / "haven-engine-linux.tar.gz"
    monkeypatch.setenv("HAVEN_ENGINE_RELEASE_PRIVATE_KEY", encoded)
    monkeypatch.setenv("HAVEN_ENGINE_RELEASE_VERSION", "test-1")

    build_engine_release.build_linux_release(private, "test-1", output)
    first_digest = hashlib.sha256(output.read_bytes()).hexdigest()
    build_engine_release.build_linux_release(private, "test-1", output)
    assert hashlib.sha256(output.read_bytes()).hexdigest() == first_digest

    manifest = json.loads(output.with_name(output.name + ".manifest.json").read_text(encoding="utf8"))
    signature = base64.b64decode(manifest.pop("signature"))
    private.public_key().verify(signature, json.dumps(
        manifest, sort_keys=True, separators=(",", ":")).encode())
    assert manifest["sha256"] == first_digest
    with tarfile.open(fileobj=io.BytesIO(output.read_bytes()), mode="r:gz") as archive:
        assert "haven-engine/install.sh" in archive.getnames()
        assert "haven-engine/marker-engine/setup.sh" in archive.getnames()
