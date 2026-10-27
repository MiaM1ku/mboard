"""Local-only deploy-node.sh helpers: no network, service calls, or node credentials.
Run: python3 -m unittest discover -s tests -p 'test_deploy_node.py' -v
Python is a developer test dependency, not a deploy prerequisite.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1] / "deploy/deploy-node.sh"
TOKEN = "a" * 64


class DeployNodeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, DEPLOY=str(DEPLOY), TEST_ROOT=str(self.root),
                        MBOARD_DEPLOY_LIBRARY="1")
        self.shells = [["sh"]]
        if shutil.which("busybox"):
            self.shells.append(["busybox", "sh"])
            self.busybox_bin = self.root / "busybox-bin"
            self.busybox_bin.mkdir()
            for name in ["awk", "stat", "sha256sum", "chmod", "cp", "mv", "rm", "date", "mktemp"]:
                (self.busybox_bin / name).symlink_to(shutil.which("busybox"))

    def tearDown(self):
        self.temp.cleanup()

    def shell(self, text, success=True):
        for shell in self.shells:
            env = self.env.copy()
            if shell[0] == "busybox":
                env["PATH"] = str(self.busybox_bin) + ":" + env["PATH"]
            result = subprocess.run(shell + ["-c", '. "$DEPLOY"\n' + text],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, success,
                             (shell, result.returncode, result.stdout, result.stderr))

    def file(self, name, text):
        path = self.root / name
        path.write_text(text)
        return path

    def bundle(self, **patch):
        data = {"token": TOKEN, "revision": 7, "config": {"inbounds": []},
                "traffic_labels": [], "files": [
                    {"path_under_mboard_tls": "190.crt", "content": "CERT\n", "mode": 384},
                    {"path_under_mboard_tls": "190.key", "content": "KEY\n", "mode": 384}]}
        data.update(patch)
        return {"data": data}

    def validate(self, bundle, success=True):
        self.file("bundle.json", json.dumps(bundle))
        self.shell('validate_bundle "$TEST_ROOT/bundle.json"', success)

    def test_machine_id_shape(self):
        for value in ["1", "12", "999999999999999"]:
            self.shell('valid_id "%s"' % value)
        for value in ["", "0", "01", "1a", "-1", "9999999999999999"]:
            self.shell('valid_id "%s"' % value, False)

    def test_token_shape(self):
        for value in ["a" * 32, "a" * 64, "A_b-" * 8, "a" * 64]:
            self.shell('token_shape "%s"' % value)
        for value in ["", "a" * 31, "a" * 63, "a" * 65, "a" * 64 + "\n", "a" * 64 + "!"]:
            self.shell('token_shape "%s"' % value, False)

    def test_panel_origin_is_https_without_path(self):
        for value in ["https://panel.example", "https://panel.example:8443", "https://1.2.3.4"]:
            self.shell('valid_origin "%s"' % value)
        for value in ["http://panel.example", "https://panel.example/api", "https://user:pw@panel.example",
                      "https://", "https://panel.example?x=1", "https://panel.example#f", "panel.example"]:
            self.shell('valid_origin "%s"' % value, False)

    def test_bundle_accepts_the_panel_contract(self):
        self.validate(self.bundle())
        self.validate(self.bundle(files=[]))
        self.validate(self.bundle(revision=0))

    def test_bundle_rejects_unsafe_or_malformed_fields(self):
        self.validate(self.bundle(token="A" * 64), False)
        self.validate(self.bundle(token="a" * 63), False)
        self.validate(self.bundle(revision=7.5), False)
        self.validate(self.bundle(revision=-1), False)
        self.validate(self.bundle(config={}), False)
        self.validate(self.bundle(traffic_labels={}), False)
        self.validate(self.bundle(files=[{"path_under_mboard_tls": "../escape.crt", "content": "C", "mode": 384}]), False)
        self.validate(self.bundle(files=[{"path_under_mboard_tls": "190.pem", "content": "C", "mode": 384}]), False)
        self.validate(self.bundle(files=[{"path_under_mboard_tls": "190.crt", "content": "C", "mode": 511}]), False)
        self.validate(self.bundle(files=[{"path_under_mboard_tls": "190.crt", "content": "C\u0000", "mode": 384}]), False)
        duplicated = self.bundle()
        duplicated["data"]["files"] = duplicated["data"]["files"] * 2
        self.validate(duplicated, False)
        self.validate({"data": None}, False)
        self.validate([], False)
        self.file("bundle.json", "{}")
        self.shell('validate_bundle "$TEST_ROOT/bundle.json"', False)

    def test_bundle_rejects_oversized_documents(self):
        oversized = self.bundle()
        oversized["data"]["files"][0]["content"] = "C" * (1024 * 1024 + 1)
        self.validate(oversized, False)

    def test_activation_schema(self):
        self.file("activate.json", json.dumps({"data": {"activated": True, "machine_id": 4, "config_revision": 7}}))
        self.shell('MACHINE_ID=4; REVISION=7; validate_activation "$TEST_ROOT/activate.json"')
        self.shell('MACHINE_ID=5; REVISION=7; validate_activation "$TEST_ROOT/activate.json"', False)
        self.shell('MACHINE_ID=4; REVISION=8; validate_activation "$TEST_ROOT/activate.json"', False)
        self.file("activate.json", json.dumps({"data": {"activated": False, "machine_id": 4, "config_revision": 7}}))
        self.shell('MACHINE_ID=4; REVISION=7; validate_activation "$TEST_ROOT/activate.json"', False)

    def test_pinned_release_digests_match_the_installer(self):
        deploy = DEPLOY.read_text()
        installer = (DEPLOY.parent / "install-mboard-node.sh").read_text()
        for digest in ["458ccfbcfc24f428184b9125456c7c246db9508c5d343bfa510c43294847490d",
                       "1e6b4ef716062484f52d3490c3b1c4d7798e8cd76aeaba3f01e9f3320c63bd90"]:
            self.assertIn(digest, deploy)
            self.assertIn(digest, installer)

    def test_service_unit_keeps_the_agent_private(self):
        self.shell('render_service "$TEST_ROOT/mboard-node.service"')
        unit = (self.root / "mboard-node.service").read_text()
        self.assertIn("ExecStart=/opt/mboard-node/mboard-node run -config /opt/mboard-node/agent.json", unit)
        self.assertIn("UMask=0077", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("ReadWritePaths=/opt/mboard-node /etc/mboard-node/tls /var/lib/mboard-node", unit)
        self.assertNotIn("root", unit)
        self.assertEqual((self.root / "mboard-node.service").stat().st_mode & 0o777, 0o755)


if __name__ == "__main__":
    unittest.main()
