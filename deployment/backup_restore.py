#!/usr/bin/env python3
"""Private consistent backups and empty-target recovery for this deployment only."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import pwd
import shutil
import subprocess
import tarfile
import tempfile

SERVICE = "qqai-dsh.service"
PROJECT = "qqai-dsh"
VOLUMES = {
    "qqai-dsh-snowluma-data": "gateway-data",
    "qqai-dsh-qq-config": "qq-client-config",
    "qqai-dsh-qq-data": "qq-client-data",
}
HOST_PATHS = (
    "/srv/qqai-dsh/home/.dsh", "/srv/qqai-dsh/workspace", "/etc/qqai-dsh",
    "/opt/qqai-dsh/source", "/opt/qqai-dsh/deployment",
    "/opt/qqai-dsh/app/package.json", "/opt/qqai-dsh/app/package-lock.json",
    "/opt/qqai-dsh/app/pnpm-lock.yaml", "/etc/systemd/system/qqai-dsh.service",
    "/etc/systemd/system/qqai-dsh.service.d",
)


def run(args, *, ok=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if ok and result.returncode:
        # A tool error can contain private paths/tokens. Keep command output private.
        raise RuntimeError(f"{args[0]} operation failed (exit {result.returncode}); no command output was published")
    return result


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def service_state():
    result = run(["systemctl", "show", SERVICE, "--no-pager",
                  "--property=LoadState,ActiveState,MainPID"], ok=False)
    state = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if state.get("LoadState") == "not-found":
        return {"active": False, "state": "inactive", "pid": 0}
    if result.returncode or state.get("ActiveState") not in {"active", "inactive", "failed"}:
        raise RuntimeError("DSH service is unavailable or transitioning; wait for a stable state before backup/recovery")
    pid = int(state.get("MainPID", "-1"))
    if pid < 0 or (state["ActiveState"] != "active" and pid != 0):
        raise RuntimeError("DSH service has an unexpected live process")
    return {"active": state["ActiveState"] == "active", "state": state["ActiveState"], "pid": pid}


def private_dir(path, *, empty=False):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path:
        raise ValueError("Use an absolute, non-symlink private directory")
    if path.exists() and (not path.is_dir() or path.stat().st_uid != os.getuid()):
        raise ValueError("Private directory must belong to the current operator")
    if empty and path.exists() and any(path.iterdir()):
        raise ValueError("Destination is not empty; refusing to overwrite it")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def docker_state():
    if not shutil.which("docker"):
        return [], {}
    if run(["docker", "info", "--format", "{{.DockerRootDir}}"], ok=False).returncode:
        raise RuntimeError("Docker is installed but unavailable; cannot prove gateway backup completeness")
    ids = run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={PROJECT}",
               "--filter", "label=com.docker.compose.service=snowluma"]).stdout.split()
    containers = []
    for cid in ids:
        item = json.loads(run(["docker", "inspect", cid]).stdout)[0]
        containers.append({"id": cid, "running": bool(item["State"]["Running"]),
                           "image": item["Config"]["Image"]})
    volumes = {}
    for name in VOLUMES:
        result = run(["docker", "volume", "inspect", name], ok=False)
        if result.returncode:
            continue
        data = json.loads(result.stdout)[0]
        if (data.get("Labels") or {}).get("com.docker.compose.project", PROJECT) != PROJECT:
            raise RuntimeError("A named gateway volume belongs to a different Compose project")
        if data["Driver"] != "local" or not Path(data["Mountpoint"]).is_dir():
            raise RuntimeError("Only accessible local Docker volumes can be backed up")
        users = run(["docker", "ps", "-q", "--filter", f"volume={name}"]).stdout.split()
        if set(users) - set(ids):
            raise RuntimeError("A gateway volume is shared by another running container; refusing an inconsistent backup")
        volumes[name] = data["Mountpoint"]
    if containers and set(volumes) != set(VOLUMES):
        raise RuntimeError("The deployed gateway does not have all three expected volumes")
    return containers, volumes


def include_host(member):
    parts = PurePosixPath(member.name).parts
    # Reinstall pinned dependencies; don't archive caches or repository internals.
    if "node_modules" in parts or ".git" in parts or "__pycache__" in parts:
        return None
    if member.isdev() or member.isfifo():
        raise RuntimeError("Unexpected special file in deployment data")
    return member


def include_gateway(member):
    # Chromium ProcessSingleton POSIX creates these per-process symlinks;
    # they are not QQ authentication Cookies databases or durable login data.
    if member.issym() and PurePosixPath(member.name).name in {"SingletonLock", "SingletonCookie", "SingletonSocket"}:
        return None
    # tarfile does not archive Unix domain sockets. Other special files fail closed.
    return include_host(member)


def backup(output_dir):
    output = private_dir(output_dir)
    for source in HOST_PATHS:
        if output.resolve().is_relative_to(Path(source).resolve()):
            raise ValueError("Backup directory must be outside the captured deployment trees")
    if not Path(HOST_PATHS[0]).is_dir():
        raise RuntimeError("DSH data directory is absent; no deployment backup was created")
    containers, volumes = docker_state()
    running = [c["id"] for c in containers if c["running"]]
    active = service_state()["active"]
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    archive = output / f"qqai-dsh-{stamp}.tar"
    source_paths = [p for p in HOST_PATHS if Path(p).exists()]
    if any(Path(p).is_symlink() for p in source_paths):
        raise RuntimeError("A captured project root is a symlink; refusing to traverse it")
    with tempfile.TemporaryDirectory(prefix=".qqai-backup-", dir=output) as stage_name:
        stage = Path(stage_name)
        try:
            if active:
                run(["systemctl", "stop", SERVICE])
            if service_state()["active"] or service_state()["pid"]:
                raise RuntimeError("DSH did not stop before the snapshot")
            for cid in running:
                run(["docker", "stop", "--time", "45", cid])
            with tarfile.open(stage / "host.tar.gz", "w:gz", compresslevel=3) as tar:
                for path in source_paths:
                    tar.add(path, arcname=path.lstrip("/"), filter=include_host)
            for name, mount in volumes.items():
                (stage / "volumes").mkdir(exist_ok=True, mode=0o700)
                with tarfile.open(stage / "volumes" / f"{name}.tar.gz", "w:gz", compresslevel=3) as tar:
                    tar.add(mount, arcname=".", filter=include_gateway)
        finally:
            failures = []
            for cid in running:
                if run(["docker", "start", cid], ok=False).returncode:
                    failures.append("SnowLuma")
            if active and run(["systemctl", "start", SERVICE], ok=False).returncode:
                failures.append("DSH")
            if failures:
                raise RuntimeError("Snapshot ended but restoring prior running state failed: " + ", ".join(failures))
        manifest = {"format": 1, "project": PROJECT, "created_utc": stamp,
                    "host_paths": source_paths, "volumes": sorted(volumes),
                    "gateway_included": bool(volumes), "gateway_containers": containers,
                    "dsh_was_active": active,
                    "dependencies_excluded": True,
                    "contains_private_credentials_and_qq_login": True}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        sums = {str(p.relative_to(stage)): digest(p) for p in stage.rglob("*") if p.is_file()}
        (stage / "checksums.json").write_text(json.dumps(sums, indent=2) + "\n")
        partial = archive.with_suffix(".partial")
        with tarfile.open(partial, "w") as tar:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    tar.add(path, arcname=str(path.relative_to(stage)), recursive=False)
        partial.chmod(0o600)
        partial.rename(archive)
    sidecar = archive.with_suffix(archive.suffix + ".sha256")
    sidecar.write_text(f"{digest(archive)}  {archive.name}\n")
    sidecar.chmod(0o600)
    print(json.dumps({"archive": str(archive), "sha256_file": str(sidecar),
                      "gateway_included": bool(volumes), "previous_running_state_restored": True}))


def check_member(member, root, allowed=None, preserve_owner=False):
    name = posixpath.normpath(member.name)
    if member.name.startswith("/") or name == ".." or name.startswith("../"):
        raise ValueError("Archive path escapes destination")
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        raise ValueError("Archive contains a special file")
    selected = None
    if allowed is not None:
        selected = next((p for p in allowed if name == p or name.startswith(p + "/")), None)
        if selected is None:
            raise ValueError("Archive member is outside the project path allowlist")
    if member.issym() or member.islnk():
        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname)
                                   if member.issym() else member.linkname)
        if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
            raise ValueError("Archive link escapes destination")
        if selected and not (target == selected or target.startswith(selected + "/")):
            raise ValueError("Archive link crosses a captured project root")
    filtered = tarfile.data_filter(member, root)
    if preserve_owner and filtered:
        filtered = filtered.replace(uid=member.uid, gid=member.gid, deep=False)
    return filtered


def extract_inner(archive, root, allowed=None, preserve_owner=False):
    with tarfile.open(archive, "r:gz") as tar:
        # Prevalidate the whole index before the first extracted file.
        for member in tar.getmembers():
            check_member(member, str(root), allowed, preserve_owner)
        tar.extractall(root, numeric_owner=True,
                       filter=lambda member, path: check_member(member, path, allowed, preserve_owner))


def isolate(archive, destination):
    archive = Path(archive).resolve(strict=True)
    sidecar_parts = archive.with_suffix(archive.suffix + ".sha256").read_text().split()
    if not sidecar_parts:
        raise ValueError("Archive checksum file is empty")
    expected = sidecar_parts[0]
    if len(expected) != 64 or digest(archive) != expected:
        raise ValueError("Archive SHA-256 verification failed")
    dest = private_dir(destination, empty=True)
    payload = private_dir(dest / "payload", empty=True)
    names = {"manifest.json", "checksums.json", "host.tar.gz"}
    names.update(f"volumes/{name}.tar.gz" for name in VOLUMES)
    with tarfile.open(archive, "r:") as tar:
        members = tar.getmembers()
        seen = set()
        for member in members:
            if not member.isfile() or member.name not in names or member.name in seen:
                raise ValueError("Unexpected outer archive entry")
            if member.name in {"manifest.json", "checksums.json"} and member.size > 1024 * 1024:
                raise ValueError("Metadata is too large")
            seen.add(member.name)
        tar.extractall(payload, filter="data")
    checksums = json.loads((payload / "checksums.json").read_text())
    if set(checksums) != seen - {"checksums.json"}:
        raise ValueError("Payload checksum inventory mismatch")
    for name, sha in checksums.items():
        if digest(payload / name) != sha:
            raise ValueError("Payload SHA-256 verification failed")
    manifest = json.loads((payload / "manifest.json").read_text())
    if manifest.get("format") != 1 or manifest.get("project") != PROJECT:
        raise ValueError("This is not a supported QQAI_DSH backup")
    if not set(manifest["host_paths"]).issubset(HOST_PATHS) or not set(manifest["volumes"]).issubset(VOLUMES):
        raise ValueError("Unknown deployment paths or Docker volumes")
    expected_entries = {"host.tar.gz", "manifest.json"} | {f"volumes/{n}.tar.gz" for n in manifest["volumes"]}
    if set(checksums) != expected_entries:
        raise ValueError("Manifest and payload inventory differ")
    host = private_dir(dest / "host", empty=True)
    extract_inner(payload / "host.tar.gz", host, [p.lstrip("/") for p in manifest["host_paths"]])
    for name in manifest["volumes"]:
        target = private_dir(dest / "volumes" / name, empty=True)
        extract_inner(payload / "volumes" / f"{name}.tar.gz", target)
    (dest / "VERIFIED.json").write_text(json.dumps({"archive_sha256": expected,
        "project": PROJECT, "gateway_included": manifest["gateway_included"],
        "isolated_only": True, "services_started": False}, indent=2) + "\n")
    return dest, manifest


def apply_restore(dest, manifest):
    if manifest["volumes"] and not shutil.which("docker"):
        raise RuntimeError("Install Docker before applying a backup that includes QQ volumes")
    if service_state()["active"]:
        raise RuntimeError("DSH is running; refusing to restore")
    containers, mounts = docker_state()
    if any(item["running"] for item in containers):
        raise RuntimeError("SnowLuma is running; refusing to restore")
    # Preflight every target before copying any runtime data.
    for name in manifest["host_paths"]:
        target = Path(name)
        if target.is_symlink() or target.resolve() != target or (target.exists() and (not target.is_dir() or any(target.iterdir()))):
            raise RuntimeError("A live restore target is not empty; no existing deployment may be overwritten")
    for name in manifest["volumes"]:
        if name in mounts and any(Path(mounts[name]).iterdir()):
            raise RuntimeError("A gateway volume is not empty; refusing to overwrite its login data")
    try:
        account = pwd.getpwnam("dsh")
    except KeyError:
        run(["useradd", "--system", "--user-group", "--home-dir", "/srv/qqai-dsh/home",
             "--create-home", "--shell", "/usr/sbin/nologin", "dsh"])
        account = pwd.getpwnam("dsh")
    for name in manifest["host_paths"]:
        source, target = dest / "host" / name.lstrip("/"), Path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True, symlinks=True)
        else:
            shutil.copy2(source, target, follow_symlinks=False)
    # Data is restored, but sending is deliberately stopped for validation.
    config_path = Path("/srv/qqai-dsh/home/.dsh/plugins-data/aurabot/config.json")
    if config_path.exists():
        config = json.loads(config_path.read_text())
        config.update(enabled=False, dryRun=True)
        config.setdefault("speakUp", {})["enabled"] = False
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
        config_path.chmod(0o600)
    for root in [Path("/srv/qqai-dsh/home"), Path("/srv/qqai-dsh/workspace")]:
        if root.exists():
            for path in [root, *root.rglob("*")]:
                os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
            root.chmod(0o700)
    # Isolated extraction intentionally uses umask 077. Restore only code traversal
    # permissions here; private state and /etc credentials remain 0700/0600.
    for path in [Path("/srv/qqai-dsh"), Path("/opt/qqai-dsh"), Path("/opt/qqai-dsh/app")]:
        if path.exists():
            path.chmod(0o755)
    for root in [Path("/opt/qqai-dsh/source"), Path("/opt/qqai-dsh/deployment")]:
        if root.exists():
            for path in [root, *root.rglob("*")]:
                if path.is_symlink():
                    continue
                path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    app = Path("/opt/qqai-dsh/app")
    if app.exists():
        os.chown(app, account.pw_uid, account.pw_gid)
        for path in app.iterdir():
            if path.is_file() and not path.is_symlink():
                os.chown(path, account.pw_uid, account.pw_gid)
                path.chmod(0o600)
    for name in manifest["volumes"]:
        if name not in mounts:
            run(["docker", "volume", "create", "--driver", "local",
                 "--label", f"com.docker.compose.project={PROJECT}",
                 "--label", f"com.docker.compose.volume={VOLUMES[name]}", name])
            mounts[name] = json.loads(run(["docker", "volume", "inspect", name]).stdout)[0]["Mountpoint"]
        extract_inner(dest / "payload" / "volumes" / f"{name}.tar.gz", Path(mounts[name]), preserve_owner=True)
    print(json.dumps({"applied_to_empty_targets": True, "services_started": False,
                      "qq_sending_enabled": False, "dependencies_must_be_reinstalled": True}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("backup")
    b.add_argument("--output-dir", default="/var/backups/qqai-dsh")
    r = sub.add_parser("restore")
    r.add_argument("archive")
    r.add_argument("--destination")
    r.add_argument("--apply", action="store_true")
    r.add_argument("--confirm-no-other-bot", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run as root so credentials and login states remain in root-only directories")
    if args.command == "backup":
        backup(args.output_dir)
        return
    if args.apply and not args.confirm_no_other_bot:
        parser.error("--apply requires --confirm-no-other-bot after verifying that no other machine is using this QQ bot")
    destination = args.destination or str(Path("/var/lib/qqai-dsh/restore-check") / Path(args.archive).stem)
    dest, manifest = isolate(args.archive, destination)
    if args.apply:
        apply_restore(dest, manifest)
    else:
        print(json.dumps({"verified_destination": str(dest), "gateway_included": manifest["gateway_included"],
                          "isolated_only": True, "services_started": False}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        raise SystemExit(f"QQAI backup/recovery stopped: {error}") from None
