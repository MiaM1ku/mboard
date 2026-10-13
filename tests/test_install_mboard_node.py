"""Local-only installer helpers: no network, real service calls, or node credentials.
Run: python3 -m unittest discover -s tests -p 'test_install_mboard_node.py' -v
Python is a developer test dependency, not an installer prerequisite.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).resolve().parents[1] / "deploy/install-mboard-node.sh"
TOKEN = "a" * 64


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, INSTALLER=str(INSTALLER), TEST_ROOT=str(self.root),
                        MBOARD_INSTALLER_LIBRARY="1")
        self.shells = [["sh"]]
        if shutil.which("busybox"):
            self.shells.append(["busybox", "sh"])
            self.busybox_bin = self.root / "busybox-bin"
            self.busybox_bin.mkdir()
            for name in ["awk", "stat", "tar", "sha256sum", "wc", "chmod", "cp", "mv", "rm", "date", "mktemp"]:
                (self.busybox_bin / name).symlink_to(shutil.which("busybox"))

    def tearDown(self):
        self.temp.cleanup()

    def shell(self, text, success=True):
        results = []
        for shell in self.shells:
            env = self.env.copy()
            if shell[0] == "busybox":
                env["PATH"] = str(self.busybox_bin) + ":" + env["PATH"]
            result = subprocess.run(shell + ["-c", '. "$INSTALLER"\n' + text],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, success,
                             (shell, result.returncode, result.stdout, result.stderr))
            results.append(result)
        return results

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

    def validate(self, bundle, success=True, suffix=""):
        self.file("bundle.json", json.dumps(bundle) + suffix)
        return self.shell('validate_bundle "$TEST_ROOT/bundle.json"', success)

    def test_legacy_32_character_machine_credential(self):
        legacy = 'mBoardLegacyNode' * 2
        self.file('legacy.yml', 'machine:\n  machine_id: 10\n  token: "' + legacy + '"\n')
        self.file('credentials.env', 'LEGACY_TOKEN=' + legacy + '\n')
        for result in self.shell('old_machine_record "$TEST_ROOT/legacy.yml"; credential_token "$TEST_ROOT/credentials.env" LEGACY_TOKEN'):
            self.assertEqual(result.stdout.splitlines(), ['10|' + legacy + '|', legacy])
        self.shell('machine_token ' + legacy)
        self.shell('hex_token ' + legacy, success=False)

    def test_posix_syntax_and_help(self):
        for shell in self.shells:
            result = subprocess.run(shell + ["-n", str(INSTALLER)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(["sh", str(INSTALLER), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("Root required", result.stdout)

    def test_qualified_machine_ignores_panel_node_id_and_token(self):
        self.file("source.yml", f'''instances:
  - panel:
      url: "https://panel.example"
      node_id: 1
      token: "{'b' * 64}"
    machine:
      machine_id: 10
      token: "{TOKEN}"
    kernel:
      type: singbox
''')
        for result in self.shell('old_machine_record "$TEST_ROOT/source.yml"'):
            self.assertEqual(result.stdout.strip(), f"10|{TOKEN}|")

    def test_literal_top_level_env_machine(self):
        self.file("source.yml", '''panel:
  node_id: 1
machine:
  machine_id: 11
  token_env: 'XB_MACHINE_11'
''')
        for result in self.shell('old_machine_record "$TEST_ROOT/source.yml"'):
            self.assertEqual(result.stdout.strip(), "11||XB_MACHINE_11")

    def test_rejects_ambiguous_or_executable_yaml(self):
        sources = [
            "panel:\n  node_id: 1\n",
            f"machine:\n  machine_id: 10\n  machine_id: 11\n  token: {TOKEN}\n",
            f"machine:\n  machine_id: 10\n  token: {TOKEN}\n  token_env: XB_TOKEN\n",
            "machine: {machine_id: 10, token: invalid}\n",
            "machine:\n  machine_id: 10\n  token: $(touch /tmp/installer-test-unsafe)\n",
            "machine:\n  machine_id: 10\n  token_env: XB_TOKEN\nmachine:\n  machine_id: 11\n",
            "machine:\n\tmachine_id: 10\n",
            "machine:\n  machine_id: 10\n  token_env: XB_TOKEN\n  unknown: field\n",
        ]
        for source in sources:
            with self.subTest(source=source):
                self.file("source.yml", source)
                self.shell('old_machine_record "$TEST_ROOT/source.yml"', success=False)

    def test_literal_credentials_never_execute(self):
        self.file("credentials.env", f"# test\nOTHER={TOKEN}\nexport XB_MACHINE_11='{TOKEN}'\n")
        for result in self.shell('credential_token "$TEST_ROOT/credentials.env" XB_MACHINE_11'):
            self.assertEqual(result.stdout.strip(), TOKEN)
        attacks = [f"XB_MACHINE_11=$(touch {self.root}/executed)\n",
                   f"XB_MACHINE_11={TOKEN}\nXB_MACHINE_11={TOKEN}\n",
                   "XB_MACHINE_11=${ANOTHER_VAR}\n",
                   f'XB_MACHINE_11="{TOKEN}; echo unsafe"\n']
        for attack in attacks:
            self.file("credentials.env", attack)
            self.shell('credential_token "$TEST_ROOT/credentials.env" XB_MACHINE_11', success=False)
            self.assertFalse((self.root / "executed").exists())

    def test_origin_and_binary_origin_rules(self):
        self.shell('valid_origin https://panel.example && valid_origin https://example.com:443')
        for origin in ["http://example.com", "https://user:pass@example.com", "https://example.com/x",
                       "https://example.com?x=y", "https://example.com#part", "https://example.com:70000",
                       "https://", 'https://example.com"']:
            self.env["ORIGIN"] = origin
            self.shell('valid_origin "$ORIGIN"', success=False)

    def test_valid_bundle_and_empty_files(self):
        self.validate(self.bundle())
        self.validate(self.bundle(files=[]))

    def test_bundle_rejects_path_escape_symlink_like_and_oversize(self):
        for path in ["../190.key", "/etc/passwd.key", ".hidden.key", "a/b.key", "key.pem", "a\n.key"]:
            with self.subTest(path=path):
                self.validate(self.bundle(files=[{"path_under_mboard_tls": path,
                                                 "content": "KEY", "mode": 384}]), False)
        self.validate(self.bundle(files=[{"path_under_mboard_tls": "190.key", "content": "a" * 1048577,
                                         "mode": 384}]), False)
        self.validate(self.bundle(files=[{"path_under_mboard_tls": "190.key", "content": "x\u0000y",
                                         "mode": 384}]), False)
        item = {"path_under_mboard_tls": "190.key", "content": "KEY", "mode": 384}
        self.validate(self.bundle(files=[item, item]), False)
        self.validate(self.bundle(files=[dict(item, mode=511)]), False)

    def test_bundle_rejects_untyped_missing_and_extra_json(self):
        for patch in [{"token": "unsafe"}, {"revision": "7"}, {"revision": -1}, {"revision": 1.5},
                      {"config": []}, {"traffic_labels": {}}, {"files": None}]:
            self.validate(self.bundle(**patch), False)
        self.validate(self.bundle(), False, suffix=" {}")
        self.validate({"data": {"token": TOKEN}}, False)

    def test_private_auth_file_and_no_token_stdout(self):
        self.env["SYNTHETIC_TOKEN"] = TOKEN
        for result in self.shell('auth_config "$SYNTHETIC_TOKEN" "$TEST_ROOT/auth.conf"'):
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
        path = self.root / "auth.conf"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertIn("Authorization: Bearer " + TOKEN, path.read_text())

    def test_checksum_pins_and_tamper(self):
        self.file("binary", "synthetic binary\n")
        self.shell('hash=$(sha256sum "$TEST_ROOT/binary"); hash=${hash%% *}; verify_binary "$TEST_ROOT/binary" "$hash"')
        self.shell('verify_binary "$TEST_ROOT/binary" "' + "0" * 64 + '"', False)
        text = INSTALLER.read_text()
        self.assertIn("66a42d370414117ecf1f9c5dce92f7efb44d8a1cd5167546951f7d95246c0a83", text)
        self.assertIn("1e6b4ef716062484f52d3490c3b1c4d7798e8cd76aeaba3f01e9f3320c63bd90", text)

    def test_activation_schema(self):
        self.file("activate.json", json.dumps({"data": {"activated": True, "machine_id": 10, "config_revision": 7}}))
        self.shell('MACHINE_ID=10; REVISION=7; validate_activation "$TEST_ROOT/activate.json"')
        self.shell('MACHINE_ID=10; REVISION=8; validate_activation "$TEST_ROOT/activate.json"', False)
        self.file("activate.json", '{"data":{"activated":false,"config_revision":7}}')
        self.shell('MACHINE_ID=10; REVISION=7; validate_activation "$TEST_ROOT/activate.json"', False)

    def test_activation_rejects_wrong_or_missing_machine(self):
        for payload in [{"activated": True, "config_revision": 7},
                        {"activated": True, "config_revision": 7, "machine_id": 11}]:
            self.file("activate.json", json.dumps({"data": payload}))
            self.shell('MACHINE_ID=10; REVISION=7; validate_activation "$TEST_ROOT/activate.json"', False)

    def test_activation_lost_reply_preserves_new_service(self):
        self.shell('''
BACKUP="$TEST_ROOT"; STAGE="$TEST_ROOT"; LOCKED=0; CUTOVER=1; COMMITTED=0
OLD_ACTIVE=1; NEW_ACTIVE=0; NEW_ENABLED=0; ACTIVATION_UNCERTAIN=0; ACTIVATION_IN_FLIGHT=0
api_post() { printf 000 > "$STAGE/http-status"; return 28; }
service_stop() { printf unsafe > "$TEST_ROOT/stopped"; }
service_start() { printf unsafe > "$TEST_ROOT/restarted"; }
rm() { :; }
trap cleanup EXIT
activate_once && exit 99
[ "$ACTIVATION_UNCERTAIN" = 1 ] || exit 99
exit 23
''', False)
        self.assertFalse((self.root / "stopped").exists())
        self.assertFalse((self.root / "restarted").exists())

    def test_activation_explicit_decline_allows_rollback(self):
        self.shell('''
STAGE="$TEST_ROOT"; COMMITTED=0; ACTIVATION_UNCERTAIN=0; ACTIVATION_IN_FLIGHT=0
api_post() { printf 409 > "$STAGE/http-status"; return 22; }
activate_once && exit 99
[ "$ACTIVATION_UNCERTAIN" = 0 ] && [ "$ACTIVATION_IN_FLIGHT" = 0 ] && [ "$COMMITTED" = 0 ]
''')

    def test_symlink_and_hardlink_destinations_rejected(self):
        target = self.file("target", "keep original")
        (self.root / "identity.json").symlink_to(target)
        os.link(target, self.root / "linked")
        self.shell('plain_file "$TEST_ROOT/identity.json"', False)
        self.shell('plain_file "$TEST_ROOT/linked"', False)
        self.assertEqual(target.read_text(), "keep original")

    def test_old_systemd_effective_binding(self):
        self.file("old-service", "ExecStart=/usr/local/bin/xboard-node -c /etc/xboard-node/config.yml\n")
        script = '''
MANAGER=systemd; OLD_SERVICE="$TEST_ROOT/old-service"
systemctl() {
 case "$2" in
  --property=FragmentPath) printf '%s\\n' "$OLD_SERVICE";;
  --property=DropInPaths) printf '%s\\n' "${DROPIN:-}";;
  --property=ExecStart) printf '%s\\n' "${EFFECTIVE:-{ path=/usr/local/bin/xboard-node ; argv[]=/usr/local/bin/xboard-node -c /etc/xboard-node/config.yml ; }}";;
 esac
}
verify_old_service
'''
        self.shell(script)
        self.env["DROPIN"] = "/etc/systemd/system/xboard-node.service.d/custom.conf"
        self.shell(script, False)
        self.env["DROPIN"] = ""
        self.env["EFFECTIVE"] = "{ path=/usr/bin/unrelated ; argv[]=/usr/bin/unrelated ; }"
        self.shell(script, False)

    def test_service_templates_support_both_managers(self):
        for manager in ["systemd", "openrc"]:
            self.shell(f'STAGE="$TEST_ROOT"; MANAGER={manager}; render_service')
            text = (self.root / "new-service").read_text()
            if manager == "systemd":
                self.assertIn("TimeoutStopSec=75", text)
                self.assertIn("ReadWritePaths=/opt/mboard-node /etc/mboard-node/tls /var/lib/mboard-node", text)
            else:
                self.shell('MANAGER=openrc; NEW_SERVICE="$TEST_ROOT/new-service"; verify_new_service')
                self.assertIn('supervisor="supervise-daemon"', text)
                self.assertIn('retry="TERM/75/KILL/5"', text)
                self.assertIn("umask 077", text)

    def test_failed_cutover_restores_snapshots_and_restarts_old(self):
        # Mock every operation with production paths. Exercise trap in a separate
        # shell so exit semantics are real but this test cannot change host files.
        for name in ["new-service", "new-tree.tar.gz", "tls-tree.tar.gz"]:
            self.file(name, "test snapshot")
        script = '''
BACKUP="$TEST_ROOT"; STAGE=; LOCKED=0; CUTOVER=1; COMMITTED=0
OLD_ACTIVE=1; NEW_ACTIVE=1; NEW_ENABLED=1; NEW_SERVICE=/test/new-service
trace() { printf '%s\\n' "$*" >> "$TEST_ROOT/trace"; }
service_stop() { trace "stop:$1"; }
service_active() { return 1; }
service_disable() { trace "disable:$1"; }
service_enable() { trace "enable:$1"; }
service_start() { trace "start:$1"; }
reload_services() { trace reload; }
rm() { trace "rm:$*"; }
cp() { trace "cp:$*"; }
tar() { trace "tar:$*"; }
trap cleanup EXIT
exit 23
'''
        self.shell(script, False)
        trace = (self.root / "trace").read_text()
        self.assertIn("stop:mboard-node", trace)
        self.assertIn("start:mboard-node", trace)
        self.assertIn("start:xboard-node", trace)
        self.assertIn("new-tree.tar.gz", trace)
        self.assertIn("tls-tree.tar.gz", trace)
        self.assertLess(trace.index("stop:mboard-node"), trace.index("start:xboard-node"))

    def test_openrc_snapshot_restores_executable_mode(self):
        service = self.file("new-service", "#!/sbin/openrc-run\n")
        service.chmod(0o755)
        self.shell('''
BACKUP="$TEST_ROOT"; STAGE=; LOCKED=0; CUTOVER=1; COMMITTED=0
OLD_ACTIVE=0; NEW_ACTIVE=1; NEW_ENABLED=0; NEW_SERVICE="$TEST_ROOT/restored-service"
service_stop() { :; }; service_active() { return 1; }; service_disable() { :; }
service_start() { [ -x "$NEW_SERVICE" ] && printf executable > "$TEST_ROOT/started"; }
reload_services() { :; }; rm() { :; }; tar() { :; }
trap cleanup EXIT
exit 23
''', False)
        self.assertEqual((self.root / "restored-service").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / "started").read_text(), "executable")

    def test_restore_failure_gates_all_service_restarts(self):
        self.file("new-tree.tar.gz", "synthetic damaged archive")
        self.shell('''
BACKUP="$TEST_ROOT"; STAGE=; LOCKED=0; CUTOVER=1; COMMITTED=0
OLD_ACTIVE=1; NEW_ACTIVE=1; NEW_ENABLED=0; NEW_SERVICE=/test/new-service
service_stop() { :; }; service_active() { return 1; }; service_disable() { :; }
service_start() { printf unsafe > "$TEST_ROOT/restarted"; }
reload_services() { :; }; rm() { :; }; tar() { return 1; }
trap cleanup EXIT
exit 23
''', False)
        self.assertFalse((self.root / "restarted").exists())

    def test_failed_stop_preserves_live_files_and_keeps_old_stopped(self):
        self.shell('''
BACKUP="$TEST_ROOT"; STAGE=; LOCKED=0; CUTOVER=1; COMMITTED=0
OLD_ACTIVE=1; NEW_ACTIVE=0; NEW_ENABLED=0; NEW_SERVICE=/test/new-service
service_stop() { return 1; }
service_active() { return 0; }
service_start() { printf unsafe > "$TEST_ROOT/restarted"; }
rm() { printf unsafe > "$TEST_ROOT/removed"; }
trap cleanup EXIT
exit 23
''', False)
        self.assertFalse((self.root / "removed").exists())
        self.assertFalse((self.root / "restarted").exists())

    def test_post_activation_failure_keeps_new_service(self):
        self.shell('''
BACKUP="$TEST_ROOT"; STAGE=; LOCKED=0; CUTOVER=1; COMMITTED=1
OLD_ACTIVE=1; NEW_ACTIVE=0; NEW_ENABLED=0
service_stop() { printf unsafe > "$TEST_ROOT/stopped"; }
service_start() { printf unsafe > "$TEST_ROOT/restarted"; }
trap cleanup EXIT
exit 23
''', False)
        self.assertFalse((self.root / "stopped").exists())
        self.assertFalse((self.root / "restarted").exists())


if __name__ == "__main__":
    unittest.main()
