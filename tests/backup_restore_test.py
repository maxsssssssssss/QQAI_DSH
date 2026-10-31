"""Synthetic archive checks; actual server backup/recovery is a separate acceptance step."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("qqai_recovery", Path(__file__).parents[1] / "deployment/backup_restore.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def archive(self, base):
        stage = base / "stage"
        stage.mkdir()
        host_path = "/srv/qqai-dsh/home/.dsh"
        with tarfile.open(stage / "host.tar.gz", "w:gz") as tar:
            data = b'{"synthetic_test_only": true}\n'
            info = tarfile.TarInfo(host_path.lstrip("/") + "/fixture.json")
            info.size, info.mode = len(data), 0o600
            tar.addfile(info, io.BytesIO(data))
        (stage / "manifest.json").write_text(json.dumps({"format": 1, "project": "qqai-dsh",
            "host_paths": [host_path], "volumes": [], "gateway_included": False}))
        sums = {p.name: recovery.digest(p) for p in stage.iterdir()}
        (stage / "checksums.json").write_text(json.dumps(sums))
        archive = base / "fixture.tar"
        with tarfile.open(archive, "w") as tar:
            for file in stage.iterdir():
                tar.add(file, arcname=file.name)
        archive.with_suffix(".tar.sha256").write_text(recovery.digest(archive) + "  fixture.tar\n")
        return archive

    def test_isolated_verification_restores_only_under_empty_destination(self):
        with tempfile.TemporaryDirectory(prefix="qqai-recovery-test-") as folder:
            base = Path(folder)
            archive = self.archive(base)
            dest, manifest = recovery.isolate(archive, base / "isolated")
            self.assertTrue((dest / "host/srv/qqai-dsh/home/.dsh/fixture.json").is_file())
            self.assertFalse(manifest["gateway_included"])
            self.assertFalse(json.loads((dest / "VERIFIED.json").read_text())["services_started"])
            self.assertEqual(dest.stat().st_mode & 0o777, 0o700)
            with self.assertRaisesRegex(ValueError, "not empty"):
                recovery.isolate(archive, dest)

    def test_checksum_damage_prevents_extraction(self):
        with tempfile.TemporaryDirectory(prefix="qqai-recovery-test-") as folder:
            base = Path(folder)
            archive = self.archive(base)
            with archive.open("ab") as file:
                file.write(b"corruption")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                recovery.isolate(archive, base / "isolated")
            self.assertFalse((base / "isolated").exists())

    def test_traversal_cross_root_links_and_special_files_are_rejected(self):
        for name in ["../../etc/shadow", "/etc/shadow"]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    recovery.check_member(tarfile.TarInfo(name), "/tmp/qqai-fixture")
        link = tarfile.TarInfo("srv/qqai-dsh/home/.dsh/escape")
        link.type, link.linkname = tarfile.SYMTYPE, "../../../../etc/shadow"
        with self.assertRaises(ValueError):
            recovery.check_member(link, "/tmp/qqai-fixture", ["srv/qqai-dsh/home/.dsh"])
        special = tarfile.TarInfo("device")
        special.type = tarfile.CHRTYPE
        with self.assertRaises(ValueError):
            recovery.check_member(special, "/tmp/qqai-fixture")

    def test_only_known_chromium_process_symlinks_are_omitted(self):
        for name in ["SingletonLock", "SingletonCookie", "SingletonSocket"]:
            link = tarfile.TarInfo("./QQ/" + name)
            link.type, link.linkname = tarfile.SYMTYPE, "/tmp/transient-process-state"
            self.assertIsNone(recovery.include_gateway(link))
        cookies = tarfile.TarInfo("./QQ/Default/Cookies")
        self.assertIs(recovery.include_gateway(cookies), cookies)
        other = tarfile.TarInfo("./QQ/other-link")
        other.type, other.linkname = tarfile.SYMTYPE, "/tmp/unknown"
        self.assertIs(recovery.include_gateway(other), other)


if __name__ == "__main__":
    unittest.main()
