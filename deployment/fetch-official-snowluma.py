#!/usr/bin/env python3
"""Fetch the pinned official image for private offline transport, without rebuilding it.

Only Python's standard library is required. No user credentials are used. Anonymous
registry tokens and signed blob URLs are held in memory and never logged or saved.
"""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import threading
import time
import urllib.request

REPOSITORY = "motricseven7/snowluma"
VERSION = "v2.2.1"
INDEX = "sha256:29536cd34e9c9c3f8a942be4e5cd6a17d366acd9b2096aa56b5863d024a80d23"
MANIFEST = "sha256:74d6874a4240636dca700734f31fbce7d0735cbce6bb43780dd8e3788eddccc9"
CONFIG = "sha256:f819e96808d03205ba2a6a152903de9e3b0aa01787ea6d1da5091b4e4e333fc1"
REGISTRY = "https://registry-1.docker.io/v2/" + REPOSITORY
ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json"
CHUNK = 1024 * 1024


def checksum(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            result.update(chunk)
    return "sha256:" + result.hexdigest()


def private_directory(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ValueError("Output must be an absolute path without symbolic links")
    if path.exists() and (not path.is_dir() or path.stat().st_uid != os.getuid()):
        raise ValueError("Output directory must belong to the current operator")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


class Registry:
    def __init__(self, root, cached_only):
        self.root = root
        self.blobs = root / "blobs" / "sha256"
        self.blobs.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.cached_only = cached_only
        self._token = ""
        self._expiry = 0
        self._lock = threading.Lock()

    def token(self):
        with self._lock:
            if time.monotonic() >= self._expiry:
                url = ("https://auth.docker.io/token?service=registry.docker.io&scope=repository:"
                       + REPOSITORY + ":pull")
                with urllib.request.urlopen(url, timeout=30) as response:
                    data = json.load(response)
                self._token = data["token"]
                self._expiry = time.monotonic() + max(1, int(data.get("expires_in", 300)) - 60)
            return self._token

    def path(self, digest):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError("Invalid registry digest")
        return self.blobs / digest.split(":", 1)[1]

    def get(self, digest, kind="blobs", size=None):
        target = self.path(digest)
        if target.is_symlink():
            raise ValueError("Refusing a symbolic link in the blob store")
        if target.exists():
            if checksum(target) != digest or (size is not None and target.stat().st_size != size):
                raise ValueError("Cached blob failed verification: " + digest)
            return target
        if self.cached_only:
            raise ValueError("Verified cached blob is missing: " + digest)
        partial = target.with_suffix(".part")
        if partial.is_symlink():
            raise ValueError("Refusing a symbolic link for partial download")
        try:
            request = urllib.request.Request(REGISTRY + "/" + kind + "/" + digest,
                headers={"Authorization": "Bearer " + self.token(), "Accept": ACCEPT})
            count = 0
            value = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as out:
                os.chmod(partial, 0o600)
                for chunk in iter(lambda: response.read(CHUNK), b""):
                    out.write(chunk)
                    value.update(chunk)
                    count += len(chunk)
            if "sha256:" + value.hexdigest() != digest or (size is not None and count != size):
                raise ValueError("Downloaded blob hash or size mismatch")
            partial.replace(target)
            print(json.dumps({"verified_blob": digest, "bytes": count}), flush=True)
            return target
        except Exception as error:
            partial.unlink(missing_ok=True)
            # Exception details may contain a signed redirect URL. Never print them.
            raise RuntimeError("Official blob download failed: " + digest + " ("
                               + type(error).__name__ + "); rerun to reuse verified blobs") from None


def prepare(root, cached_only):
    registry = Registry(root, cached_only)
    index = json.loads(registry.get(INDEX, "manifests").read_bytes())
    if not any(item["digest"] == MANIFEST and item.get("platform") == {"architecture": "amd64", "os": "linux"}
               for item in index["manifests"]):
        raise ValueError("Pinned index does not contain the expected platform manifest")
    manifest_path = registry.get(MANIFEST, "manifests")
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["config"]["digest"] != CONFIG:
        raise ValueError("Pinned manifest references an unexpected config")
    config_path = registry.get(CONFIG, size=manifest["config"]["size"])
    config = json.loads(config_path.read_bytes())
    if config["architecture"] != "amd64" or config["os"] != "linux":
        raise ValueError("Unexpected image platform")
    layers, diff_ids = manifest["layers"], config["rootfs"]["diff_ids"]
    if len(layers) != len(diff_ids):
        raise ValueError("Layer inventory mismatch")
    # Exactly three workers at most, including on a fresh cache.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        work = [pool.submit(registry.get, item["digest"], size=item["size"]) for item in layers]
        for task in concurrent.futures.as_completed(work):
            task.result()
    for number, (layer, diff_id) in enumerate(zip(layers, diff_ids), 1):
        if layer["mediaType"] not in ("application/vnd.oci.image.layer.v1.tar+gzip",
                                      "application/vnd.docker.image.rootfs.diff.tar.gzip"):
            raise ValueError("Unsupported layer compression")
        value = hashlib.sha256()
        with gzip.open(registry.path(layer["digest"]), "rb") as stream:
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                value.update(chunk)
        if "sha256:" + value.hexdigest() != diff_id:
            raise ValueError("Uncompressed layer verification failed")
        print(json.dumps({"verified_diff_id": diff_id, "layer": number}), flush=True)
    return registry, manifest, diff_ids


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def pack(root, registry, manifest, diff_ids):
    write_json(root / "oci-layout", {"imageLayoutVersion": "1.0.0"})
    write_json(root / "index.json", {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{"mediaType": manifest["mediaType"], "digest": MANIFEST,
            "size": registry.path(MANIFEST).stat().st_size,
            "platform": {"architecture": "amd64", "os": "linux"},
            "annotations": {"org.opencontainers.image.ref.name": REPOSITORY + ":" + VERSION}}]})
    transport = [{"Config": "blobs/sha256/" + CONFIG.split(":")[1], "RepoTags": [REPOSITORY + ":" + VERSION],
        "Layers": ["blobs/sha256/" + item["digest"].split(":")[1] for item in manifest["layers"]],
        "LayerSources": dict(zip(diff_ids, manifest["layers"]))}]
    write_json(root / "manifest.json", transport)
    evidence = {"source": REGISTRY, "tag": VERSION, "registry_index_digest": INDEX,
        "manifest_digest": MANIFEST, "config_digest": CONFIG, "layers": manifest["layers"],
        "diff_ids": diff_ids, "status": "all-original-registry-bytes-verified",
        "modified_image_contents": False, "uncompressed_diff_ids_verified": True,
        "docker_import_image_id": CONFIG, "docker_import_repo_tag": REPOSITORY + ":" + VERSION,
        "transport_format": "OCI layout with Docker tar-import manifest; original compressed layers and config unchanged"}
    write_json(root / "transfer-evidence.json", evidence)
    archive = root / ("snowluma-" + VERSION + "-amd64-original.tar")
    partial = archive.with_suffix(".tar.partial")
    paths = [root / name for name in ["oci-layout", "index.json", "manifest.json", "transfer-evidence.json"]]
    digests = {INDEX, MANIFEST, CONFIG, *(item["digest"] for item in manifest["layers"])}
    paths += [registry.path(digest) for digest in sorted(digests)]
    with tarfile.open(partial, "w", format=tarfile.PAX_FORMAT) as out:
        for path in paths:
            entry = tarfile.TarInfo(path.relative_to(root).as_posix())
            entry.size, entry.mode, entry.mtime, entry.uid, entry.gid = path.stat().st_size, 0o600, 0, 0, 0
            with path.open("rb") as source:
                out.addfile(entry, source)
    partial.chmod(0o600)
    partial.replace(archive)
    value = checksum(archive).split(":")[1]
    (root / "SHA256SUMS").write_text(value + "  " + archive.name + "\n")
    (root / "SHA256SUMS").chmod(0o600)
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                      "sha256": value, "image_id": CONFIG}), flush=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="/tmp/qqai-dsh-snow-image")
    parser.add_argument("--cached-only", action="store_true", help="Do not access the network")
    parser.add_argument("--verify-only", action="store_true", help="Verify cached blobs/diff IDs without downloading or rewriting an archive")
    args = parser.parse_args()
    root = private_directory(args.output_dir)
    registry, manifest, diff_ids = prepare(root, args.cached_only or args.verify_only)
    if args.verify_only:
        print(json.dumps({"verified": True, "image_id": CONFIG, "layers": len(diff_ids), "archive_rewritten": False}))
    else:
        pack(root, registry, manifest, diff_ids)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Print only our own safe messages; third-party exceptions can embed URLs.
        if type(error) in (ValueError, RuntimeError):
            raise SystemExit(str(error)) from None
        raise SystemExit("Official image transfer stopped (" + type(error).__name__ + ")") from None
